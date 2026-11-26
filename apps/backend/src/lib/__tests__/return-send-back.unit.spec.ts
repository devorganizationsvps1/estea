const adapter = {
  name: "DHL eCommerce",
  code: "dhl",
  owns: (d: unknown) => (d as { carrier?: string } | null)?.carrier === "dhl",
  createShipment: jest.fn(),
  getStatus: jest.fn(),
  trackingUrl: (c: string) => `https://takip.test/${c}`,
}
let configured: typeof adapter | null = adapter
jest.mock("../../modules/carrier/registry", () => ({
  getConfiguredCarrier: () => configured,
  getCarrierFor: (d: unknown) => ((d as { carrier?: string } | null)?.carrier === "dhl" ? adapter : null),
  carrierTestMode: () => true,
  buildOrderReference: (id: unknown) => `ESC-${id}`,
}))
jest.mock("../ops-events", () => ({ recordOpsEvent: jest.fn(async () => undefined), errorText: (e: unknown) => String((e as Error)?.message ?? e) }))
jest.mock("../notify", () => ({ createNotificationIdempotent: jest.fn(async () => ({ sent: true })) }))
jest.mock("../return-email-context", () => ({
  loadReturnEmailContext: jest.fn(async () => ({
    returnId: "return_01JABCDEF9",
    orderId: "order_1",
    orderDisplayId: "65",
    email: "musteri@test.dev",
    items: [{ title: "Siyah Çay", quantity: 1 }],
    notAccepted: [],
    metadata: {},
  })),
}))

import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { createNotificationIdempotent } from "../notify"
import { recordOpsEvent } from "../ops-events"
import {
  closeExpiredSendBacks,
  disposeSendBack,
  markSendBackReturned,
  SendBackError,
  shipSendBack,
  trackSendBacks,
} from "../return-send-back"

const RETURN_ID = "return_01JABCDEF9"
const order = {
  id: "order_1",
  display_id: 65,
  email: "musteri@test.dev",
  currency_code: "try",
  shipping_address: {
    first_name: "Ayşe",
    last_name: "Yılmaz",
    address_1: "Atatürk Cad. No: 1",
    city: "İstanbul",
    province: "34",
    postal_code: "34000",
    country_code: "tr",
    phone: "05321234567",
    metadata: { city_code: "34", district: "Kadıköy" },
  },
  items: [{ id: "item_a", title: "Siyah Çay", variant_title: "500 gr", unit_price: 200, metadata: null }],
}

/** Bellekte tek iade: updateReturns metadata'yı gerçekten değiştirir (taze okuma sınanır). */
function makeContainer(sendBack: Record<string, unknown> | null, extraMeta: Record<string, unknown> = {}) {
  const ret = {
    id: RETURN_ID,
    order_id: "order_1",
    status: "canceled",
    metadata: { paytr_refund: { status: "skipped" }, ...extraMeta, ...(sendBack ? { escay_send_back: sendBack } : {}) } as Record<string, unknown>,
  }
  const container = {
    resolve: (key: string) => {
      if (key === Modules.LOCKING) return { execute: async (_k: unknown, job: () => Promise<unknown>) => job() }
      if (key === ContainerRegistrationKeys.QUERY)
        return { graph: async ({ entity }: { entity: string }) => ({ data: entity === "order" ? [order] : [{ ...ret }] }) }
      if (key === Modules.ORDER)
        return {
          updateReturns: async (rows: { data: { metadata: Record<string, unknown> } }[]) => {
            ret.metadata = rows[0].data.metadata
          },
        }
      if (key === Modules.NOTIFICATION) return {}
      if (key === ContainerRegistrationKeys.LOGGER) return { warn: jest.fn(), info: jest.fn() }
      throw new Error(key)
    },
  }
  return { container: container as never, ret }
}

const awaiting = { status: "awaiting", source: "rejection", items: [{ item_id: "item_a", quantity: 1 }], created_at: "2026-11-25T08:00:00.000Z" }
const mailKinds = () => (createNotificationIdempotent as jest.Mock).mock.calls.map((c) => c[1].template)

beforeEach(() => {
  jest.clearAllMocks()
  configured = adapter
})

describe("shipSendBack", () => {
  it("kargo firmasında teslimat adresine gönderi açar, takip numarasını müşteriye yollar", async () => {
    adapter.createShipment.mockResolvedValue({ data: { shipment_ref: "ESC65GCDEF9", tracking_number: "111", tracking_url: "https://takip.test/111", label_zpl: "^XA^XZ" }, labels: [] })
    const { container, ret } = makeContainer(awaiting)
    const sb = await shipSendBack(container, { returnId: RETURN_ID, actorId: "user_1" })

    const input = adapter.createShipment.mock.calls[0][0]
    expect(input.order.reference).toBe("ESC-65-GCDEF9")
    expect(input.recipient).toMatchObject({ name: "Ayşe Yılmaz", cityCode: "34", districtName: "Kadıköy" })
    expect(input.items).toHaveLength(1)
    expect(sb.status).toBe("shipped")
    expect(sb.shipment).toMatchObject({ carrier: "dhl", tracking_number: "111", order_reference: "ESC-65-GCDEF9" })
    expect(mailKinds()).toEqual(["return-send-back-shipped"])
    // Başka süreçlerin alanları korunur.
    expect(ret.metadata.paytr_refund).toEqual({ status: "skipped" })
    expect((ret.metadata.escay_send_back as { shipment: { customer_notified_at?: string } }).shipment.customer_notified_at).toBeTruthy()
  })

  it("gönderi açılamazsa kayıt değişmez, olay düşer", async () => {
    adapter.createShipment.mockRejectedValue(new Error("DHL 500"))
    const { container, ret } = makeContainer(awaiting)
    await expect(shipSendBack(container, { returnId: RETURN_ID })).rejects.toThrow(SendBackError)
    expect((ret.metadata.escay_send_back as { status: string }).status).toBe("awaiting")
    expect(recordOpsEvent).toHaveBeenCalledWith(container, expect.objectContaining({ kind: "return.send_back_failed", level: "error" }))
    expect(mailKinds()).toEqual([])
  })

  it("kargo firması bağlı değilse takip numarası ister, verilince elle kaydeder", async () => {
    configured = null
    const { container } = makeContainer(awaiting)
    await expect(shipSendBack(container, { returnId: RETURN_ID })).rejects.toThrow(/takip numarasını/)
    const sb = await shipSendBack(container, { returnId: RETURN_ID, manual: { trackingNumber: " 999 ", carrierName: "PTT" } })
    expect(sb.shipment).toMatchObject({ carrier: "manual", carrier_name: "PTT", tracking_number: "999" })
    expect(adapter.createShipment).not.toHaveBeenCalled()
  })

  it("yoldaki ya da imha edilmiş ürün yeniden gönderilmez", async () => {
    await expect(shipSendBack(makeContainer({ ...awaiting, status: "shipped" }).container, { returnId: RETURN_ID })).rejects.toThrow(/zaten/)
    await expect(shipSendBack(makeContainer({ ...awaiting, status: "disposed" }).container, { returnId: RETURN_ID })).rejects.toThrow(/imha/)
    await expect(shipSendBack(makeContainer(null).container, { returnId: RETURN_ID })).rejects.toThrow(/geri gönderilecek ürün yok/)
  })

  it("bize dönen paket yeniden gönderilirken eski referans tekrar kullanılmaz", async () => {
    adapter.createShipment.mockResolvedValue({ data: { shipment_ref: "ESC65GCDEF9R2", tracking_number: "222" }, labels: [] })
    const { container } = makeContainer({ ...awaiting, status: "returned", previous_refs: ["ESC65GCDEF9"], hold_until: "2026-12-09T09:00:00.000Z" })
    const sb = await shipSendBack(container, { returnId: RETURN_ID })
    expect(adapter.createShipment.mock.calls[0][0].order.canceledShipmentRefs).toEqual(["ESC65GCDEF9"])
    expect(sb).toMatchObject({ status: "shipped", hold_until: null, returned_at: null })
  })
})

describe("teslim alınmayan paket", () => {
  const shipped = { ...awaiting, status: "shipped", shipment: { carrier: "dhl", shipment_ref: "ESC65GCDEF9", tracking_number: "111", customer_notified_at: "x" } }

  it("bize döndü: 14 gün bekleme başlar, müşteriye bildirilir", async () => {
    const { container } = makeContainer(shipped)
    const sb = await markSendBackReturned(container, { returnId: RETURN_ID })
    expect(sb.status).toBe("returned")
    expect(Date.parse(sb.hold_until as string) - Date.parse(sb.returned_at as string)).toBe(14 * 86_400_000)
    expect(sb.previous_refs).toEqual(["ESC65GCDEF9"])
    expect(mailKinds()).toEqual(["return-send-back-returned"])
    await expect(markSendBackReturned(makeContainer(awaiting).container, { returnId: RETURN_ID })).rejects.toThrow(/gönderilmiş paket/)
  })

  it("yoklama: teslim edildi → kapanır; geri dönüyor → bekleme başlar", async () => {
    adapter.getStatus.mockResolvedValue({ code: "5", description: "Teslim Edildi", action: "delivered" })
    const a = makeContainer(shipped)
    await trackSendBacks(a.container)
    expect(a.ret.metadata.escay_send_back).toMatchObject({ status: "delivered", shipment: { status_code: "5" } })

    adapter.getStatus.mockResolvedValue({ code: "7", description: "Göndericiye Geri Geliyor", action: "returned" })
    const b = makeContainer(shipped)
    await trackSendBacks(b.container)
    expect(b.ret.metadata.escay_send_back).toMatchObject({ status: "returned" })
    expect(mailKinds()).toEqual(["return-send-back-returned"])
  })

  it("yoklama: gecikmeli takip numarası gelince müşteriye bir kez mail gider", async () => {
    adapter.getStatus.mockResolvedValue({ code: "1", description: "Gönderi hazırlandı", action: "none", patch: { tracking_number: "333" } })
    const { container, ret } = makeContainer({ ...awaiting, status: "shipped", shipment: { carrier: "dhl", shipment_ref: "ESC65GCDEF9", dhl_barcode_pending: true } })
    await trackSendBacks(container)
    await trackSendBacks(container)
    expect(mailKinds()).toEqual(["return-send-back-shipped"])
    expect(ret.metadata.escay_send_back).toMatchObject({ status: "shipped", shipment: { tracking_number: "333" } })
  })

  it("bekleme süresi dolunca kayıt kapanır, müşteriye son bildirim gider; dolmadıysa dokunulmaz", async () => {
    const returned = { ...awaiting, status: "returned", returned_at: "2026-11-25T09:00:00.000Z", hold_until: "2026-12-09T09:00:00.000Z" }
    const early = makeContainer(returned)
    expect(await closeExpiredSendBacks(early.container, new Date("2026-12-08T09:00:00.000Z"))).toBe(0)
    expect(mailKinds()).toEqual([])

    const due = makeContainer(returned)
    expect(await closeExpiredSendBacks(due.container, new Date("2026-12-09T09:00:01.000Z"))).toBe(1)
    expect(due.ret.metadata.escay_send_back).toMatchObject({ status: "closed" })
    expect(mailKinds()).toEqual(["return-send-back-closed"])
  })
})

describe("disposeSendBack", () => {
  it("müşteri onayı notu olmadan imha kaydedilmez", async () => {
    const { container, ret } = makeContainer(awaiting)
    await expect(disposeSendBack(container, { returnId: RETURN_ID, consentNote: " " })).rejects.toThrow(/yazılı onayını/)
    expect((ret.metadata.escay_send_back as { status: string }).status).toBe("awaiting")
  })

  it("onayla imha edilir, müşteriye bildirilir; yoldaki ürün imha edilemez", async () => {
    const { container } = makeContainer(awaiting)
    const sb = await disposeSendBack(container, { returnId: RETURN_ID, consentNote: "25.11 e-postayla onayladı", actorId: "user_1" })
    expect(sb).toMatchObject({ status: "disposed", disposal: { by: "user_1", consent_note: "25.11 e-postayla onayladı" } })
    expect(mailKinds()).toEqual(["return-send-back-disposed"])
    await expect(
      disposeSendBack(makeContainer({ ...awaiting, status: "shipped" }).container, { returnId: RETURN_ID, consentNote: "onayladı 25.11" })
    ).rejects.toThrow(/elimizde değil/)
  })
})

import { describe, expect, it } from "vitest"
import { resolveReturnStatus } from "@escay/shared/return-status"

describe("resolveReturnStatus", () => {
  it("iade yoksa null", () => {
    expect(resolveReturnStatus(null)).toBeNull()
    expect(resolveReturnStatus({})).toBeNull()
  })

  it("talep: kod yoksa kod beklenir, varsa kod gösterilir", () => {
    expect(resolveReturnStatus({ status: "requested" })).toMatchObject({
      label: "İade talebi alındı",
      tone: "pending",
      returnCode: null,
    })
    const withCode = resolveReturnStatus({ status: "requested", metadata: { return_code: "YK-1" } })
    expect(withCode?.returnCode).toBe("YK-1")
    expect(withCode?.note).toContain("YK-1")
  })

  it("red, durumdan ve para iadesinden önce gelir; sebep gösterilir", () => {
    const st = resolveReturnStatus({
      status: "canceled",
      metadata: {
        escay_rejection: { rejected: true, reason: "Ürün açılmış" },
        paytr_refund: { status: "skipped" },
      },
    })
    expect(st).toMatchObject({ label: "İade kabul edilmedi", tone: "rejected" })
    expect(st?.note).toBe("Açıklama: Ürün açılmış")
  })

  it("paket gelmeden red: göndermemesi söylenir, iade kodu gösterilmez", () => {
    const st = resolveReturnStatus({
      status: "canceled",
      metadata: {
        return_code: "ESC65IABC123",
        escay_rejection: { rejected: true, stage: "before_arrival", reason: "İade süresi dolmuş" },
      },
    })
    expect(st?.note).toBe("Açıklama: İade süresi dolmuş. Lütfen paketi kargoya verme; iade kodun artık geçerli değil.")
    expect(st?.returnCode).toBeNull()
  })

  it("incelenip reddedilen ürünün geri gönderimi adım adım görünür", () => {
    const rejected = (send_back: Record<string, unknown>) =>
      resolveReturnStatus({
        status: "canceled",
        metadata: { escay_rejection: { rejected: true, stage: "inspected", reason: "Ambalajı açılmış" }, escay_send_back: send_back },
      })?.note
    expect(rejected({ status: "awaiting" })).toContain("ücretsiz olarak adresine geri göndereceğiz")
    expect(rejected({ status: "shipped", shipment: { carrier_name: "DHL eCommerce", tracking_number: "123456" } })).toContain(
      "DHL eCommerce takip no: 123456"
    )
    expect(rejected({ status: "returned", hold_until: "2026-12-09T09:00:00.000Z" })).toContain("9 Aralık tarihine kadar")
    expect(rejected({ status: "closed" })).toContain("bekleme süresi doldu")
    expect(rejected({ status: "disposed" })).toContain("onayınla imha edildi")
  })

  it("kısmi kabulde kabul edilmeyen ürünün geri gönderimi de söylenir", () => {
    const st = resolveReturnStatus({
      status: "partially_received",
      metadata: {
        escay_acceptance: { items: [{ rejected: 1 }] },
        paytr_refund: { status: "success", amount: 100 },
        escay_send_back: { status: "shipped", shipment: { tracking_number: "777" } },
      },
    })
    expect(st?.label).toBe("Para iade edildi")
    expect(st?.note).toContain("Takip no: 777")
  })

  it("değişim, iade gibi görünmez", () => {
    const exchange = (status: string) => ({ escay_exchange: { status, items: [] } })
    expect(resolveReturnStatus({ status: "requested", metadata: exchange("requested") })?.label).toBe(
      "Değişim talebi alındı"
    )
    expect(resolveReturnStatus({ status: "received", metadata: exchange("requested") })?.label).toBe(
      "Değişim: ürün bize ulaştı"
    )
    expect(resolveReturnStatus({ status: "received", metadata: exchange("shipment_created") })).toMatchObject({
      kind: "exchange",
      label: "Yeni ürün gönderiliyor",
    })
    // İptal edilen değişim normal iadeye döner
    expect(resolveReturnStatus({ status: "received", metadata: exchange("canceled") })?.kind).toBe("return")
  })

  it("para iadesi: tutar ve kısmi kabul notu", () => {
    const st = resolveReturnStatus({
      status: "partially_received",
      metadata: {
        paytr_refund: { status: "success", amount: 1800 },
        escay_acceptance: { items: [{ rejected: 1 }] },
      },
    })
    expect(st).toMatchObject({ label: "Para iade edildi", tone: "done", refundAmount: 1800 })
    expect(st?.note).toContain("Bazı ürünler kabul edilmedi")
  })

  it("teslim alındı, para iadesi henüz yoksa işleniyor", () => {
    expect(
      resolveReturnStatus({ status: "received", metadata: { paytr_refund: { status: "failed" } } })
    ).toMatchObject({ label: "Ürün bize ulaştı", tone: "progress", refundAmount: null })
  })
})

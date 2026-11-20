const adapter = {
  name: "DHL",
  code: "dhl",
  owns: (d: unknown) => (d as { carrier?: string } | null)?.carrier === "dhl",
  createReturn: jest.fn(),
  cancelReturn: jest.fn(),
}
jest.mock("../../modules/carrier/registry", () => ({ getConfiguredCarrier: () => adapter }))
jest.mock("../ops-events", () => ({ recordOpsEvent: jest.fn(async () => undefined), errorText: (e: unknown) => String((e as Error)?.message ?? e) }))
jest.mock("../return-code", () => ({
  recordCarrierReturnCode: jest.fn(async () => undefined),
  clearCanceledReturnCode: jest.fn(async () => undefined),
  sendReturnCodeToCustomer: jest.fn(async () => ({ email: "a@b.test" })),
}))

import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { recordOpsEvent } from "../ops-events"
import { clearCanceledReturnCode, recordCarrierReturnCode, sendReturnCodeToCustomer } from "../return-code"
import { renewCarrierReturnCode, ReturnCodeRenewError } from "../return-code-renew"

function container(ret: Record<string, unknown>) {
  const updateReturns = jest.fn()
  const lockKeys: unknown[] = []
  return {
    updateReturns,
    lockKeys,
    c: {
      resolve: (key: string) => {
        if (key === Modules.LOCKING)
          return {
            execute: async (k: unknown, job: () => Promise<unknown>) => {
              lockKeys.push(k)
              return job()
            },
          }
        if (key === ContainerRegistrationKeys.QUERY) return { graph: async () => ({ data: [ret] }) }
        if (key === Modules.ORDER) return { updateReturns }
        throw new Error(key)
      },
    } as never,
  }
}

const fulfilment = { canceled_at: null, data: { carrier: "dhl", order_reference: "ESC-65" } }
const base = { id: "ret_1", status: "requested", order_id: "order_1", order: { fulfillments: [fulfilment] } }

describe("iade kodu yenileme", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    adapter.createReturn.mockReset().mockResolvedValue({ returnCode: "ESC65IABC", labelUrl: "http://mn.tc?rtnid=NEW" })
    adapter.cancelReturn.mockReset().mockResolvedValue(undefined)
  })

  it("kod varsa: önce firmada iptal, aynı referansla yeniden aç, yeni etiketle ve yeni mail anahtarıyla gönder", async () => {
    const { c, lockKeys } = container({ ...base, metadata: { return_code: "ESC65IABC", return_code_source: "carrier", return_code_renewals: 1 } })
    const r = await renewCarrierReturnCode(c, { returnId: "ret_1" })
    expect(lockKeys).toEqual(["escay:return-accept:ret_1"])
    expect(adapter.cancelReturn).toHaveBeenCalledWith(fulfilment.data, "ESC65IABC")
    expect(adapter.cancelReturn.mock.invocationCallOrder[0]).toBeLessThan(adapter.createReturn.mock.invocationCallOrder[0])
    expect(clearCanceledReturnCode).toHaveBeenCalledWith(c, "ret_1", "ESC65IABC")
    expect(recordCarrierReturnCode).toHaveBeenCalledWith(c, "ret_1", "ESC65IABC", {
      labelUrl: "http://mn.tc?rtnid=NEW",
      meta: expect.objectContaining({ return_code_renewals: 2 }),
    })
    expect(sendReturnCodeToCustomer).toHaveBeenCalledWith(
      c,
      expect.objectContaining({ code: "ESC65IABC", renewal: 2, labelUrl: "http://mn.tc?rtnid=NEW" })
    )
    expect(r).toMatchObject({ code: "ESC65IABC", canceledPrevious: true, renewal: 2 })
  })

  it("eski kod iptal edildi, yenisi açılamadı: kod iadeden düşer, return.code_failed olayı yazılır", async () => {
    adapter.createReturn.mockRejectedValue(new Error("DHL 500"))
    const { c } = container({ ...base, metadata: { return_code: "ESC65IABC", return_code_source: "carrier", return_code_sent_at: "2026-11-20" } })
    await expect(renewCarrierReturnCode(c, { returnId: "ret_1" })).rejects.toBeInstanceOf(ReturnCodeRenewError)
    expect(clearCanceledReturnCode).toHaveBeenCalledWith(c, "ret_1", "ESC65IABC")
    expect(recordOpsEvent).toHaveBeenCalledWith(c, expect.objectContaining({ kind: "return.code_failed", level: "error" }))
    expect(recordCarrierReturnCode).not.toHaveBeenCalled()
    expect(sendReturnCodeToCustomer).not.toHaveBeenCalled()
  })

  it("firmada iptal reddedilirse (paket yolda / hata) kod olduğu gibi kalır, yeni kayıt açılmaz", async () => {
    adapter.cancelReturn.mockRejectedValue(new Error("Müşteri paketi DHL'ye vermiş"))
    const { c } = container({ ...base, metadata: { return_code: "ESC65IABC", return_code_source: "carrier" } })
    await expect(renewCarrierReturnCode(c, { returnId: "ret_1" })).rejects.toThrow(/iptal edilemedi.*DHL'ye vermiş/)
    expect(clearCanceledReturnCode).not.toHaveBeenCalled()
    expect(adapter.createReturn).not.toHaveBeenCalled()
    expect(recordOpsEvent).toHaveBeenCalledWith(c, expect.objectContaining({ kind: "return.code_failed" }))
  })

  it("mail gidemezse ReturnCodeRenewError + olay; kod iadede kalır (yeniden gönderilebilir)", async () => {
    ;(sendReturnCodeToCustomer as jest.Mock).mockRejectedValueOnce(new Error("Siparişte müşteri e-postası yok."))
    const { c } = container({ ...base, metadata: {} })
    await expect(renewCarrierReturnCode(c, { returnId: "ret_1" })).rejects.toBeInstanceOf(ReturnCodeRenewError)
    expect(recordCarrierReturnCode).toHaveBeenCalled()
    expect(recordOpsEvent).toHaveBeenCalledWith(c, expect.objectContaining({ kind: "return.code_failed", title: "İade kodu müşteriye gönderilemedi" }))
  })

  it("kod hiç alınamamışsa iptal yok, ilk kez açar", async () => {
    const { c } = container({ ...base, metadata: {} })
    await renewCarrierReturnCode(c, { returnId: "ret_1" })
    expect(adapter.cancelReturn).not.toHaveBeenCalled()
    expect(adapter.createReturn).toHaveBeenCalled()
  })

  it("elle girilmiş kod firmada iptal edilmez", async () => {
    const { c } = container({ ...base, metadata: { return_code: "ELLE123", return_code_source: "manual" } })
    await renewCarrierReturnCode(c, { returnId: "ret_1" })
    expect(adapter.cancelReturn).not.toHaveBeenCalled()
  })

  it("teslim alınmış / reddedilmiş iade yenilenmez", async () => {
    await expect(renewCarrierReturnCode(container({ ...base, status: "received", metadata: {} }).c, { returnId: "ret_1" })).rejects.toThrow(/bekleyen/)
    await expect(
      renewCarrierReturnCode(container({ ...base, metadata: { escay_rejection: { rejected: true } } }).c, { returnId: "ret_1" })
    ).rejects.toThrow(/bekleyen/)
    expect(adapter.createReturn).not.toHaveBeenCalled()
  })
})

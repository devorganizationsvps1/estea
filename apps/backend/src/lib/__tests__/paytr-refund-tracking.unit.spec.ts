jest.mock("../ops-events", () => ({ recordOpsEvent: jest.fn(async () => undefined) }))
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { recordOpsEvent } from "../ops-events"
import { trackPaytrRefunds } from "../paytr-refund-tracking"
import type { PaytrStatusResult } from "../paytr-status"

const DAY = 24 * 60 * 60 * 1000
const now = new Date("2026-11-20T12:00:00Z")

function setup(returns: any[]) {
  const updateReturns = jest.fn()
  const container = {
    resolve: (key: string) => {
      if (key === ContainerRegistrationKeys.QUERY)
        return {
          graph: async ({ entity }: { entity: string }) =>
            entity === "return" ? { data: returns } : { data: [{ id: "pay_1", data: { merchant_oid: "OID1" } }] },
        }
      if (key === ContainerRegistrationKeys.LOGGER) return { warn: jest.fn(), info: jest.fn() }
      if (key === Modules.ORDER) return { updateReturns }
      throw new Error(key)
    },
  }
  return { container: container as never, updateReturns }
}

const ret = (id: string, amount: number, atMsAgo: number, extra: Record<string, unknown> = {}) => ({
  id,
  order_id: "order_1",
  metadata: {
    paytr_refund: { status: "success", amount, payment_id: "pay_1", at: new Date(now.getTime() - atMsAgo).toISOString(), ...extra },
  },
})

const status = (returns: PaytrStatusResult extends infer T ? any[] : never): PaytrStatusResult => ({
  ok: true,
  merchant_oid: "OID1",
  payment_amount: 1000,
  payment_total: 1000,
  payment_date: null,
  currency: "TL",
  payment_type: null,
  returns,
  returned_total: returns.reduce((s: number, r: any) => s + r.amount, 0),
  test_mode: false,
})

describe("PayTR iade tamamlanma takibi", () => {
  beforeEach(() => jest.clearAllMocks())

  it("tamamlanan iade kayda yazılır, uyarı yok", async () => {
    const { container, updateReturns } = setup([ret("r1", 100, 2 * DAY)])
    const s = await trackPaytrRefunds(container, {
      now,
      query: async () => status([{ amount: 100, status: "completed", completed_at: "2026-11-19 10:00:00", reference_no: "R1" }]),
    })
    expect(s.completed).toBe(1)
    const meta = updateReturns.mock.calls[0][0][0].data.metadata.paytr_refund
    expect(meta.completed_at).toBe("2026-11-19 10:00:00")
    expect(meta.paytr_reference_no).toBe("R1")
    expect(recordOpsEvent).not.toHaveBeenCalled()
  })

  it("3 günü geçen bekleyen iade için bir kez uyarı", async () => {
    const { container } = setup([ret("r1", 100, 4 * DAY)])
    const s = await trackPaytrRefunds(container, { now, query: async () => status([{ amount: 100, status: "pending", reference_no: "R1" }]) })
    expect(s.alerted).toBe(1)
    expect(recordOpsEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: "PayTR iadesi 3 gündür tamamlanmadı" }))

    jest.clearAllMocks()
    const again = setup([ret("r1", 100, 4 * DAY, { pending_alerted_at: now.toISOString() })])
    await trackPaytrRefunds(again.container, { now, query: async () => status([{ amount: 100, status: "pending" }]) })
    expect(recordOpsEvent).not.toHaveBeenCalled()
  })

  it("PayTR'de hiç görünmeyen iade 1 gün sonra hata olarak uyarılır", async () => {
    const { container } = setup([ret("r1", 100, 2 * DAY)])
    await trackPaytrRefunds(container, { now, query: async () => status([]) })
    expect(recordOpsEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ level: "error", title: "PayTR'de iade kaydı görünmüyor" })
    )
  })

  it("aynı tutarlı iki iade aynı PayTR kaydına eşlenmez; eşleşmeyen ikincisi uyarılır", async () => {
    const { container, updateReturns } = setup([ret("r1", 100, 2 * DAY), ret("r2", 100, 2 * DAY)])
    const s = await trackPaytrRefunds(container, {
      now,
      query: async () => status([{ amount: 100, status: "completed", reference_no: "R1" }]),
    })
    expect(s.completed).toBe(1)
    const metas = updateReturns.mock.calls.map((c: any) => c[0][0])
    expect(metas.filter((m: any) => m.data.metadata.paytr_refund.completed_at)).toHaveLength(1)
    expect(metas.filter((m: any) => m.data.metadata.paytr_refund.missing_alerted_at)).toHaveLength(1)
  })

  it("tamamlanmış ya da başarısız iade sorgulanmaz", async () => {
    const query = jest.fn()
    const { container } = setup([ret("r1", 100, DAY, { completed_at: "x" }), { id: "r2", order_id: "o", metadata: { paytr_refund: { status: "failed" } } }])
    await trackPaytrRefunds(container, { now, query })
    expect(query).not.toHaveBeenCalled()
  })
})

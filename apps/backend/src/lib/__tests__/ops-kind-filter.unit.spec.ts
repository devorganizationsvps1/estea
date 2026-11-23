import { opsKindFilter, SYSTEM_EVENT_KINDS } from "../ops-events"

describe("olay kaydı tür filtresi", () => {
  it("filtre yokken teknik olaylar gelmez (günlük görünüm, sipariş Olaylar kutusu)", () => {
    expect(opsKindFilter(undefined)).toEqual({ $nin: SYSTEM_EVENT_KINDS })
    expect(SYSTEM_EVENT_KINDS).toEqual(expect.arrayContaining(["contract.failed", "carrier.health"]))
  })

  it("system yalnız teknik olayları, önek o türleri getirir", () => {
    expect(opsKindFilter("system")).toEqual(SYSTEM_EVENT_KINDS)
    expect(opsKindFilter("shipment")).toEqual({ $like: "shipment.%" })
    expect(opsKindFilter("payment.failed")).toBe("payment.failed")
  })

  it("personelin çözeceği olaylar teknik sayılmaz", () => {
    for (const kind of ["shipment.failed", "shipment.audit", "return.refund_failed", "payment.alert", "invoice.failed"]) {
      expect(SYSTEM_EVENT_KINDS).not.toContain(kind)
    }
  })
})

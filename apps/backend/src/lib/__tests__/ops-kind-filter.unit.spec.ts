import { opsKindFilter, ROUTINE_EVENT_KINDS, SYSTEM_EVENT_KINDS } from "../ops-events"

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

  it("hata ve uyarı görünümünde rutin uyarılar (ödenmeyen sipariş, reddedilen kart) gelmez", () => {
    expect(opsKindFilter(undefined, { importantOnly: true })).toEqual({ $nin: [...SYSTEM_EVENT_KINDS, ...ROUTINE_EVENT_KINDS] })
    expect(opsKindFilter("payment", { importantOnly: true })).toEqual({ $like: "payment.%", $nin: ROUTINE_EVENT_KINDS })
    expect(ROUTINE_EVENT_KINDS).not.toContain("payment.alert")
  })

  it("personelin çözeceği olaylar teknik sayılmaz", () => {
    for (const kind of ["shipment.failed", "shipment.audit", "return.refund_failed", "payment.alert", "invoice.failed"]) {
      expect(SYSTEM_EVENT_KINDS).not.toContain(kind)
    }
  })
})

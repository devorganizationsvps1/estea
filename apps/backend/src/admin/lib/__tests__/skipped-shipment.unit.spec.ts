import { skippedShipmentMessage } from "../skipped-shipment"

describe("gönderi aç: atlanan sonuç başarı diye gösterilmez", () => {
  it("yeni gönderi açıldıysa uyarı yok", () => {
    expect(skippedShipmentMessage({ ok: true, fulfillmentId: "ful_1" })).toBeNull()
    expect(skippedShipmentMessage({})).toBeNull()
    expect(skippedShipmentMessage(null)).toBeNull()
  })

  it("bilinen sebepler Türkçe cümleye çevrilir", () => {
    expect(skippedShipmentMessage({ ok: true, skipped: "carrier shipment already exists" })).toMatch(/zaten açık/)
    expect(skippedShipmentMessage({ ok: true, skipped: "nothing left to fulfill" })).toMatch(/kalmamış/)
    expect(skippedShipmentMessage({ ok: true, skipped: "already shipped" })).toMatch(/zaten açılmış/)
  })

  it("bilinmeyen sebep ham hâliyle gösterilir", () => {
    expect(skippedShipmentMessage({ ok: true, skipped: "x" })).toBe("Gönderi açılmadı: x")
  })
})

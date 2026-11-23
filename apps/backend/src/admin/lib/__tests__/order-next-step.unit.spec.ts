import { resolveNextStep } from "../order-next-step"

const base = { nextAction: "prepare" as const, needsShipment: false, carrierLinked: false, hasLabel: false }

describe("sipariş detayı: sıradaki tek iş", () => {
  it("teslim edilmiş ya da iptal siparişte iş yok", () => {
    expect(resolveNextStep({ ...base, nextAction: null })).toBeNull()
  })

  it("ödendi ama gönderi yoksa önce gönderi açılır", () => {
    expect(resolveNextStep({ ...base, needsShipment: true })).toEqual({ kind: "open_shipment" })
  })

  it("firma bağlıyken: etiket beklenir, basılır, sonra kurye ve teslim beklenir", () => {
    const linked = { ...base, carrierLinked: true }
    expect(resolveNextStep(linked)).toEqual({ kind: "wait_label" })
    expect(resolveNextStep({ ...linked, hasLabel: true })).toEqual({ kind: "print_label" })
    expect(resolveNextStep({ ...linked, hasLabel: true, nextAction: "ship" })).toEqual({ kind: "wait_courier" })
    expect(resolveNextStep({ ...linked, hasLabel: true, nextAction: "deliver" })).toEqual({ kind: "wait_delivery" })
  })

  it("firma yokken adımlar elle işaretlenir", () => {
    expect(resolveNextStep(base)).toEqual({ kind: "advance", action: "prepare" })
    expect(resolveNextStep({ ...base, nextAction: "ship" })).toEqual({ kind: "advance", action: "ship" })
    expect(resolveNextStep({ ...base, nextAction: "deliver" })).toEqual({ kind: "advance", action: "deliver" })
  })
})

import { calculateReturnRefundAmount, paidPricePerUnit, type RefundOrderItem } from "../return-refund"

const base = { reasonsById: {}, shippingTotal: 149.9, shippingAlreadyRefunded: false }

describe("iade tutarı: yalnız iade edilen kalemin ödenen fiyatı", () => {
  it("değişmeyen kayıtlardan: KDV dahil fiyat − kupon; satır tamamen iade edilince de", () => {
    // 1 adet × 500, 50 kupon, KDV dahil; iade alınmış → Medusa toplamları 0
    const line: RefundOrderItem = {
      id: "x", unit_price: 500, quantity: 1, is_tax_inclusive: true,
      adjustments: [{ amount: 50 }], tax_lines: [{ rate: 1 }],
      total: 0, refundable_total_per_unit: 0, detail: { quantity: 1, return_received_quantity: 1 },
    }
    const r = calculateReturnRefundAmount({ ...base, returnStatus: "received", returnItems: [{ item_id: "x", quantity: 1, received_quantity: 1 }], orderItems: [line] })
    expect(r.itemsAmount).toBe(450)
    expect(r.uncertainItems).toEqual([])
  })

  it("KDV hariç fiyatta KDV eklenir; Medusa ile tutarlı", () => {
    const line: RefundOrderItem = {
      id: "x", unit_price: 35, quantity: 2, is_tax_inclusive: false,
      adjustments: [], tax_lines: [{ rate: 1 }], total: 70.7, refundable_total_per_unit: 35.35,
    }
    expect(paidPricePerUnit(line, new Map())).toBeCloseTo(35.35, 5)
  })

  it("iki hesap tutmazsa belirsiz (otomatik iade yok)", () => {
    const line: RefundOrderItem = {
      id: "x", unit_price: 100, quantity: 1, is_tax_inclusive: true,
      adjustments: [], tax_lines: [], refundable_total_per_unit: 80,
    }
    const r = calculateReturnRefundAmount({ ...base, returnStatus: "received", returnItems: [{ item_id: "x", quantity: 1, received_quantity: 1 }], orderItems: [line] })
    expect(r.uncertainItems).toEqual(["x"])
  })

  // Yerel sipariş #1: 35×2, 2800×3, 340×2 (KDV %1 dahil toplamlar)
  const items: RefundOrderItem[] = [
    { id: "a", unit_price: 35, quantity: 2, total: 70.7 },
    { id: "b", unit_price: 2800, quantity: 3, total: 8484 },
    { id: "c", unit_price: 340, quantity: 2, total: 686.8 },
  ]

  it("3 kalemli siparişte 1 adet iade → yalnız o adet", () => {
    const r = calculateReturnRefundAmount({
      ...base,
      returnStatus: "received",
      returnItems: [{ item_id: "b", quantity: 1, received_quantity: 1 }],
      orderItems: items,
    })
    expect(r.itemsAmount).toBe(2828)
    expect(r.shippingIncluded).toBe(false)
  })

  it("kuponlu satırda liste fiyatı değil ödenen fiyat", () => {
    const r = calculateReturnRefundAmount({
      ...base,
      returnStatus: "received",
      returnItems: [{ item_id: "x", quantity: 1, received_quantity: 1 }],
      orderItems: [{ id: "x", unit_price: 500, quantity: 2, total: 800 }],
    })
    expect(r.itemsAmount).toBe(400)
  })

  it("adet detail.quantity'den de okunur", () => {
    expect(paidPricePerUnit({ id: "x", total: 300, detail: { quantity: 3 } }, new Map())).toBe(100)
  })

  it("iade alındıktan sonra satır toplamı kalan adede düşer: birim fiyat değişmez", () => {
    // Medusa: 3 adet × 1299, 1 adet iade alınmış → total 2598, quantity 3
    expect(
      paidPricePerUnit({ id: "x", quantity: 3, total: 2598, detail: { quantity: 3, return_received_quantity: 1 } }, new Map())
    ).toBe(1299)
    expect(paidPricePerUnit({ id: "x", quantity: 3, total: 2598, refundable_total_per_unit: 1299 }, new Map())).toBe(1299)
  })

  it("değişimle gelen 0 ₺ kalem, değiştirildiği kalemin ödenen fiyatıyla (zincir) iade edilir", () => {
    const list: RefundOrderItem[] = [
      { id: "root", unit_price: 500, quantity: 1, total: 450 },
      { id: "ex1", unit_price: 0, quantity: 1, total: 0, metadata: { escay_exchange_for_item_id: "root" } },
      { id: "ex2", unit_price: 0, quantity: 1, total: 0, metadata: { escay_exchange_for_item_id: "ex1" } },
    ]
    const r = calculateReturnRefundAmount({
      ...base,
      returnStatus: "received",
      returnItems: [{ item_id: "ex2", quantity: 1, received_quantity: 1 }],
      orderItems: list,
    })
    expect(r.itemsAmount).toBe(450)
  })

  it("döngülü değişim zinciri sonsuz döngüye girmez", () => {
    const list: RefundOrderItem[] = [
      { id: "p", total: 0, quantity: 1, metadata: { escay_exchange_for_item_id: "q" } },
      { id: "q", total: 0, quantity: 1, metadata: { escay_exchange_for_item_id: "p" } },
    ]
    const byId = new Map(list.map((i) => [i.id as string, i]))
    expect(paidPricePerUnit(list[0], byId)).toBe(0)
  })

  it("ödenen fiyat okunamazsa kalem belirsiz sayılır (otomatik iade yok)", () => {
    const r = calculateReturnRefundAmount({
      ...base,
      returnStatus: "received",
      returnItems: [{ item_id: "x", quantity: 1, received_quantity: 1 }],
      orderItems: [{ id: "x", unit_price: 500 }],
    })
    expect(r.uncertainItems).toEqual(["x"])
  })

  it("toplam yoksa refundable_total_per_unit, o da yoksa liste fiyatı", () => {
    expect(paidPricePerUnit({ id: "x", refundable_total_per_unit: 33.3, unit_price: 40 }, new Map())).toBe(33.3)
    expect(paidPricePerUnit({ id: "x", refundable_total_per_unit: 30, total: 100, quantity: 2 }, new Map())).toBe(30)
    expect(paidPricePerUnit({ id: "x", unit_price: 40 }, new Map())).toBe(40)
  })
})

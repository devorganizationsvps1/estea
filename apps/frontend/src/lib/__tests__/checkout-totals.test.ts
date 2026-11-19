import { describe, expect, it } from "vitest"
import { computeCheckoutTotals } from "@/components/checkout/CheckoutOrderSummary"

describe("computeCheckoutTotals — promosyonlar", () => {
  it("ücretsiz kargo: indirim satırı kargo tutarını içermez, satırlar toplamı verir", () => {
    const t = computeCheckoutTotals(
      {
        original_item_total: 200,
        item_total: 200,
        discount_total: 99.9,
        shipping_total: 0,
        total: 200,
      },
      { useAppliedShipping: true }
    )
    expect(t).toMatchObject({ productSubtotal: 200, discount: 0, shipping: 0, total: 200 })
  })

  it("ürün kuponu + ücretsiz kargo", () => {
    const t = computeCheckoutTotals(
      {
        original_item_total: 200,
        item_total: 180,
        discount_total: 119.9,
        shipping_total: 0,
        total: 180,
      },
      { useAppliedShipping: true }
    )
    expect(t).toMatchObject({ productSubtotal: 200, discount: 20, shipping: 0, total: 180 })
    expect(t.productSubtotal - t.discount + t.shipping).toBe(t.total)
  })

  it("kargo uygulanmamışken cart.total (eski kargo yöntemi dahil) tahminle toplanmaz", () => {
    const t = computeCheckoutTotals(
      {
        original_item_total: 200,
        item_total: 180,
        discount_total: 20,
        shipping_total: 99.9,
        total: 279.9,
      },
      { shippingEstimate: 99.9 }
    )
    expect(t.total).toBe(279.9)
  })
})

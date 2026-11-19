import { buildPromotionUsageActions } from "../promotion-usage"

describe("buildPromotionUsageActions", () => {
  it("kalem ve kargo indirimlerini Medusa'nın kaydettiği sırayla tek tek listeler", () => {
    expect(
      buildPromotionUsageActions({
        items: [
          { adjustments: [{ code: "HOSGELDIN10", amount: 12.5 }] },
          { adjustments: [{ code: "HOSGELDIN10", amount: { value: "7.5" } }] },
        ],
        shipping_methods: [{ adjustments: [{ code: "KARGOBEDAVA", amount: 99.9 }] }],
      })
    ).toEqual([
      { code: "HOSGELDIN10", amount: 12.5 },
      { code: "HOSGELDIN10", amount: 7.5 },
      { code: "KARGOBEDAVA", amount: 99.9 },
    ])
  })

  it("kodsuz ya da boş indirim satırını ve indirimsiz siparişi atlar", () => {
    expect(
      buildPromotionUsageActions({
        items: [{ adjustments: [{ code: null, amount: 5 }] }, { adjustments: null }, {}],
        shipping_methods: null,
      })
    ).toEqual([])
    expect(buildPromotionUsageActions({})).toEqual([])
  })
})

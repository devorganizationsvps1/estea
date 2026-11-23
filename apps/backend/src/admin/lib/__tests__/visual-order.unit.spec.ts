import { nextInVisualOrder } from "../visual-order"

// DOM sırası: siparişler, ürünler, iadeler; görünen sıra (CSS order): siparişler, iadeler, ürünler
const items = [
  { el: "orders", top: 97 },
  { el: "products", top: 231 },
  { el: "returns", top: 167 },
]

describe("menüde klavye sırası görünen sırayı izler", () => {
  it("Tab bir alttaki görünen satıra gider", () => {
    expect(nextInVisualOrder(items, "orders", 1)).toBe("returns")
    expect(nextInVisualOrder(items, "returns", 1)).toBe("products")
  })

  it("Shift+Tab bir üsttekine gider", () => {
    expect(nextInVisualOrder(items, "products", -1)).toBe("returns")
  })

  it("uçlarda ve menü dışı öğede null döner", () => {
    expect(nextInVisualOrder(items, "products", 1)).toBeNull()
    expect(nextInVisualOrder(items, "orders", -1)).toBeNull()
    expect(nextInVisualOrder(items, "other", 1)).toBeNull()
  })
})

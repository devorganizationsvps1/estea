import { ShopsideClient, findToken, responseError } from "../client"
import { isConfigured, normalizeOptions } from "../options"
import {
  computeShopsidePushPlan,
  parseOpenOrderQuantities,
  parseShopsideProducts,
} from "../stock"
import type { TrackedVariant } from "../../../lib/stock-plan"

function variant(sku: string, stocked: number, reserved = 0): TrackedVariant {
  return { variantId: `v_${sku}`, sku, inventoryItemId: `i_${sku}`, locationId: "loc", stocked, reserved }
}

/** `process` alanına göre yanıt veren sahte Shopside. */
function fakeShopside(replies: Record<string, unknown | (() => unknown)>) {
  const calls: Record<string, string>[] = []
  const transport = jest.fn(async (_url: string, init: { body: string }) => {
    const params = Object.fromEntries(new URLSearchParams(init.body))
    calls.push(params)
    const picked = replies[params.process]
    const body = typeof picked === "function" ? (picked as () => unknown)() : picked
    if (body === undefined) throw new Error(`Beklenmeyen process: ${params.process}`)
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  })
  const client = new ShopsideClient({
    apiKey: "key",
    apiSecret: "secret",
    baseUrl: "https://api.shopside.test/user/",
    timeoutMs: 1000,
    transport: transport as never,
  })
  return { client, calls }
}

describe("options", () => {
  it("kimlik yoksa kapalı, varsayılanlar güvenli", () => {
    const opts = normalizeOptions({})
    expect(isConfigured(opts)).toBe(false)
    expect(opts.stockApply).toBe(false)
    expect(opts.ordersEnabled).toBe(true)
    expect(opts.openOrderStatuses).toEqual(["1", "2"])
  })

  it("kimlik ve ayarları okur", () => {
    const opts = normalizeOptions({
      apiKey: "k",
      apiSecret: "s",
      stockApply: "true",
      ordersEnabled: "false",
      openOrderStatuses: "1, 2,3",
    })
    expect(isConfigured(opts)).toBe(true)
    expect(opts.stockApply).toBe(true)
    expect(opts.ordersEnabled).toBe(false)
    expect(opts.openOrderStatuses).toEqual(["1", "2", "3"])
  })
})

describe("ShopsideClient", () => {
  it("giriş yapar, token'ı sonraki çağrılara ekler ve yeniden kullanır", async () => {
    const { client, calls } = fakeShopside({
      "common/api-login": { status: true, data: { token: "T1" } },
      "product/list": { status: true, data: [] },
    })
    await client.listProducts()
    await client.listProducts("7")
    expect(calls.map((c) => c.process)).toEqual(["common/api-login", "product/list", "product/list"])
    expect(calls[0]).toMatchObject({ api_key: "key", api_secret: "secret" })
    expect(calls[1].token).toBe("T1")
    expect(calls[2].process_id).toBe("7")
  })

  it("token reddedilirse bir kez yeniden giriş yapar", async () => {
    let listCalls = 0
    const { client, calls } = fakeShopside({
      "common/api-login": { token: "T" },
      "order/list": () =>
        ++listCalls === 1 ? { status: false, message: "Token geçersiz" } : { status: true, data: [] },
    })
    await client.listOrders({ status: "1", page: 1, limit: 100 })
    expect(calls.filter((c) => c.process === "common/api-login").length).toBe(2)
    expect(calls[calls.length - 1]).toMatchObject({ order_status: "1", page: "1", limit: "100" })
  })

  it("giriş yanıtında token yoksa ve işlem hata dönerse durur", async () => {
    const noToken = fakeShopside({ "common/api-login": { status: false, message: "Hatalı API bilgisi" } })
    await expect(noToken.client.login()).rejects.toThrow("Hatalı API bilgisi")

    const failing = fakeShopside({
      "common/api-login": { token: "T" },
      "product/stock": { status: false, message: "Ürün bulunamadı" },
    })
    await expect(failing.client.updateStock("1", 5)).rejects.toThrow("Ürün bulunamadı")
  })

  it("stok yazarken tüm platformlar alanını gönderir", async () => {
    const { client, calls } = fakeShopside({
      "common/api-login": { token: "T" },
      "product/stock": { status: true },
    })
    await client.updateStock("1384", 15)
    expect(calls[1]).toMatchObject({
      process: "product/stock",
      "platforms[all][process_id]": "1384",
      "platforms[all][stock_amount]": "15",
    })
  })

  it("token ve hata biçimlerini tanır", () => {
    expect(findToken({ token: "a" })).toBe("a")
    expect(findToken({ result: { access_token: "b" } })).toBe("b")
    expect(findToken({ data: [] })).toBe("")
    expect(responseError({ status: "error", message: "x" })).toBe("x")
    expect(responseError({ success: false })).toBe("Shopside işlemi başarısız")
    expect(responseError({ status: true, data: [] })).toBe("")
    expect(responseError([])).toBe("")
  })
})

describe("parseShopsideProducts", () => {
  it("stok kodu, ürün kimliği ve stoğu okur", () => {
    const { bySku } = parseShopsideProducts([{ id: 12, stock_code: " esc-1 ", stock_amount: "8" }])
    expect(bySku.get("ESC-1")).toEqual({ productId: "12", stock: 8 })
  })

  it("alan adları ezilebilir; stoğu okunamayan ürün yine eşleşir", () => {
    const { bySku } = parseShopsideProducts([{ pid: "p1", barkod: "869", kalan: "?" }], {
      skuField: "barkod",
      productIdField: "pid",
      quantityField: "kalan",
    })
    expect(bySku.get("869")).toEqual({ productId: "p1", stock: null })
  })

  it("mükerrer kodu dışarıda bırakır, tanınmayan yanıtta durur", () => {
    const parsed = parseShopsideProducts([
      { id: 1, sku: "A", stock: 1 },
      { id: 2, sku: "A", stock: 2 },
    ])
    expect(parsed.duplicates).toEqual(["A"])
    expect(parsed.bySku.size).toBe(0)
    expect(() => parseShopsideProducts([{ foo: 1, bar: 2 }])).toThrow("foo, bar")
  })
})

describe("parseOpenOrderQuantities", () => {
  it("sipariş satırlarını SKU başına toplar, aynı siparişi bir kez sayar", () => {
    const order = (id: number, lines: unknown[]) => ({ id, products: lines })
    const open = parseOpenOrderQuantities([
      order(1, [{ stock_code: "a", quantity: 2 }, { stock_code: "B", quantity: "1" }]),
      order(2, [{ stock_code: "A", quantity: 1 }]),
      order(1, [{ stock_code: "a", quantity: 2 }]),
    ])
    expect(open.orderCount).toBe(2)
    expect([...open.bySku]).toEqual([["A", 3], ["B", 1]])
  })

  it("okunamayan satırı sayar ama 0 adet uydurmaz", () => {
    const open = parseOpenOrderQuantities([
      { id: 1, items: [{ sku: "A", qty: 1 }, { name: "kodsuz", qty: 1 }] },
    ])
    expect(open.bySku.get("A")).toBe(1)
    expect(open.linesWithoutSku).toBe(1)
  })

  it("sipariş var ama satırlar tanınmıyorsa durur; boş liste sorun değil", () => {
    expect(() => parseOpenOrderQuantities([{ id: 1, total: 100 }])).toThrow("ürün satırları tanınmadı")
    expect(parseOpenOrderQuantities([]).orderCount).toBe(0)
  })
})

describe("computeShopsidePushPlan", () => {
  const products = new Map([
    ["A", { productId: "1", stock: 10 }],
    ["B", { productId: "2", stock: 4 }],
    ["C", { productId: "3", stock: null }],
  ])

  it("satılabilir adedi (stok − rezerve) yazar, aynıysa yazmaz", () => {
    const plan = computeShopsidePushPlan({
      variants: [variant("a", 10, 3), variant("B", 4), variant("C", 2), variant("D", 1)],
      products,
      maxZeroRatio: 0.5,
    })
    expect(plan.pushes).toEqual([
      { sku: "a", productId: "1", from: 10, to: 7 },
      { sku: "C", productId: "3", from: null, to: 2 },
    ])
    expect(plan.unchanged).toBe(1)
    expect(plan.missing).toEqual(["D"])
  })

  it("bu turda yazılan Medusa stoğunu esas alır", () => {
    const plan = computeShopsidePushPlan({
      variants: [variant("A", 10, 1)],
      products,
      stockOverride: new Map([["A", 6]]),
      maxZeroRatio: 0.5,
    })
    expect(plan.pushes).toEqual([{ sku: "A", productId: "1", from: 10, to: 5 }])
  })

  it("toplu sıfırlamayı korumaya alır", () => {
    const many = new Map(
      ["A", "B", "C", "D"].map((sku, i) => [sku, { productId: String(i), stock: 5 }])
    )
    const plan = computeShopsidePushPlan({
      variants: ["A", "B", "C", "D"].map((sku) => variant(sku, 0)),
      products: many,
      maxZeroRatio: 0.5,
    })
    expect(plan.newlyZero).toBe(4)
    expect(plan.zeroGuardTripped).toBe(true)
  })
})

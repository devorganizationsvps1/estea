import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { syncStock } from "../../src/lib/stock-sync"
import { fulfillOrderItems } from "./helpers/fulfill-order"
import { placeGuestStubOrder } from "./helpers/place-order"
import {
  createPricedProducts,
  seedStorefrontFixture,
  type StorefrontFixture,
} from "./helpers/storefront-fixture"

jest.setTimeout(120 * 1000)

const realFetch = globalThis.fetch

// medusa-config modül seçeneklerini runner'ın `env`'inden önce okuyor.
process.env.PARASUT_CLIENT_ID = "test-client"
process.env.PARASUT_CLIENT_SECRET = "test-secret"
process.env.PARASUT_USERNAME = "test@escay.test"
process.env.PARASUT_PASSWORD = "test-pass"
process.env.PARASUT_COMPANY_ID = "42"
process.env.PARASUT_STOCK_APPLY = "true"
process.env.SHOPSIDE_API_KEY = "shopside-key"
process.env.SHOPSIDE_API_SECRET = "shopside-secret"
process.env.SHOPSIDE_STOCK_APPLY = "true"

type ShopsideState = {
  /** stok kodu → Shopside'daki stok */
  stock: Record<string, number>
  /** faturası kesilmemiş pazaryeri siparişleri */
  openOrders: { id: number; products: { stock_code: string; quantity: number }[] }[]
  /** product/stock ile yazılanlar: ürün kimliği → adet */
  written: Record<string, number>
}

/**
 * Paraşüt ve Shopside uçları sahtelenir. `parasut` ürün kodu → stok miktarıdır;
 * Shopside ürün kimliği olarak stok kodunun kendisi kullanılır.
 */
function stubApis(parasut: Record<string, number>, shopside: Partial<ShopsideState> = {}) {
  const state: ShopsideState = { stock: {}, openOrders: [], written: {}, ...shopside }
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const target = String(url)
    if (target.includes("api.parasut.com")) {
      if (target.endsWith("/oauth/token")) return json({ access_token: "tok", expires_in: 7200 })
      if (target.includes("/v4/42/products?")) {
        return json({
          data: Object.entries(parasut).map(([code, stock], i) => ({
            id: String(i + 1),
            attributes: { code, name: code, inventory_tracking: true, stock_count: stock },
          })),
          meta: { total_pages: 1, total_count: Object.keys(parasut).length },
        })
      }
      throw new Error(`Beklenmeyen Paraşüt isteği: ${target}`)
    }
    if (target.includes("api.shopside.io")) {
      const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")))
      switch (params.process) {
        case "common/api-login":
          return json({ status: true, token: "shopside-token" })
        case "order/list":
          // Açık siparişler "Yeni" (1) durumunda; "Onaylanmış" (2) boş.
          return json({ status: true, data: params.order_status === "1" ? state.openOrders : [] })
        case "product/list":
          return json({
            status: true,
            data: Object.entries(state.stock).map(([code, stock]) => ({
              id: code,
              stock_code: code,
              stock_amount: stock,
            })),
          })
        case "product/stock":
          state.written[params["platforms[all][process_id]"]] = Number(
            params["platforms[all][stock_amount]"]
          )
          return json({ status: true })
        default:
          throw new Error(`Beklenmeyen Shopside isteği: ${params.process}`)
      }
    }
    return realFetch(url as never, init as never)
  }) as typeof fetch
  return state
}

async function readLevel(container: MedusaContainer, variantId: string) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "product_variant",
    fields: [
      "inventory_items.inventory.location_levels.stocked_quantity",
      "inventory_items.inventory.location_levels.reserved_quantity",
    ],
    filters: { id: variantId },
  })
  const variant = data[0] as unknown as {
    inventory_items: {
      inventory: { location_levels: { stocked_quantity: number; reserved_quantity: number }[] }
    }[]
  }
  return variant.inventory_items[0].inventory.location_levels[0]
}

medusaIntegrationTestRunner({
  env: {
    PAYTR_MOCK: "1",
    PAYTR_MERCHANT_ID: "",
    PAYTR_MERCHANT_KEY: "",
    PAYTR_MERCHANT_SALT: "",
    SHIPPING_CARRIER: "",
    COOKIE_SECURE: "false",
      },
  testSuite: ({ api, getContainer }) => {
    describe("Stok eşitlemesi: Paraşüt → Medusa → Shopside (gerçek Medusa stoğu, sahte API)", () => {
      let fx: StorefrontFixture
      let synced: { id: string; sku: string }
      let absent: { id: string; sku: string }

      beforeAll(async () => {
        const container = getContainer()
        fx = await seedStorefrontFixture(container)
        const products = await createPricedProducts(container, fx, 2, { titlePrefix: "Stok" })
        const [a, b] = products.map((p) => p.variants[0])
        synced = { id: a.id, sku: a.sku as string }
        absent = { id: b.id, sku: b.sku as string }
      })

      afterEach(() => {
        globalThis.fetch = realFetch
      })

      it("eşleşen stoğu yazar, Paraşüt'te olmayana dokunmaz", async () => {
        const container = getContainer()
        stubApis({ [synced.sku]: 7 })

        const result = await syncStock(container)

        expect(result.status).toBe("applied")
        expect((await readLevel(container, synced.id)).stocked_quantity).toBe(7)
        expect((await readLevel(container, absent.id)).stocked_quantity).toBe(100)
      })

      it("apply kapalıyken yazmaz", async () => {
        const container = getContainer()
        stubApis({ [synced.sku]: 7 })

        const result = await syncStock(container, { apply: false })

        expect(result.status).toBe("dry_run")
        expect((await readLevel(container, synced.id)).stocked_quantity).toBe(100)
      })

      it("hatalı yanıtta stoğa dokunmaz", async () => {
        const container = getContainer()
        stubApis({})

        await expect(syncStock(container)).rejects.toThrow("boş ürün listesi")
        expect((await readLevel(container, synced.id)).stocked_quantity).toBe(100)
      })

      it("açık pazaryeri siparişini düşer, satılabilir adedi Shopside'a yazar", async () => {
        const container = getContainer()
        // Paraşüt 10 diyor; pazaryerinde faturası kesilmemiş 3 adetlik sipariş var.
        const shopside = stubApis(
          { [synced.sku]: 10 },
          {
            stock: { [synced.sku]: 10 },
            openOrders: [{ id: 1, products: [{ stock_code: synced.sku, quantity: 3 }] }],
          }
        )

        const result = await syncStock(container)

        expect(result.status).toBe("applied")
        expect((await readLevel(container, synced.id)).stocked_quantity).toBe(7)
        expect(shopside.written).toEqual({ [synced.sku]: 7 })
        if (result.status === "disabled") throw new Error("eşitleme kapalı")
        expect(result.shopside).toMatchObject({ status: "applied", openOrders: 1 })
        expect(result.shopside?.plan.missing).toEqual([absent.sku])
      })

      it("site siparişi ayrılınca pazaryeri stoğu hemen düşer", async () => {
        const container = getContainer()
        stubApis({ [synced.sku]: 10 }, { stock: { [synced.sku]: 10 } })
        await syncStock(container)

        await placeGuestStubOrder(api, fx, synced.id, "pazaryeri@example.com", { quantity: 4 })

        const shopside = stubApis({ [synced.sku]: 10 }, { stock: { [synced.sku]: 10 } })
        await syncStock(container)
        expect(await readLevel(container, synced.id)).toMatchObject({
          stocked_quantity: 10,
          reserved_quantity: 4,
        })
        expect(shopside.written).toEqual({ [synced.sku]: 6 })
      })

      it("rezervasyon, kargo ve fatura boyunca fazla satışa izin vermez", async () => {
        const container = getContainer()
        stubApis({ [synced.sku]: 10 })
        await syncStock(container)

        const order = await placeGuestStubOrder(api, fx, synced.id, "stok@example.com", {
          quantity: 2,
        })

        // Sipariş açık: fiziksel stok aynı, 2 adet ayrılmış.
        await syncStock(container)
        expect(await readLevel(container, synced.id)).toMatchObject({
          stocked_quantity: 10,
          reserved_quantity: 2,
        })

        // Kargolandı, fatura teslimde: Paraşüt hâlâ 10 diyor, geri 10 yazılmamalı.
        await fulfillOrderItems(container, {
          orderId: order.id,
          itemId: order.items[0].id,
          quantity: 2,
          locationId: fx.stockLocationId,
        })
        await syncStock(container)
        expect(await readLevel(container, synced.id)).toMatchObject({
          stocked_quantity: 8,
          reserved_quantity: 0,
        })

        // Fatura kesildi, Paraşüt 8'e indi: çift düşüm olmamalı.
        await container.resolve(Modules.ORDER).updateOrders([
          {
            id: order.id,
            metadata: {
              parasut_invoice: {
                status: "issued",
                mode: "live",
                invoice_id: "inv1",
                items: [{ line_item_id: order.items[0].id, quantity: 2 }],
              },
            },
          },
        ])
        stubApis({ [synced.sku]: 8 })
        await syncStock(container)
        expect((await readLevel(container, synced.id)).stocked_quantity).toBe(8)
      })
    })
  },
})

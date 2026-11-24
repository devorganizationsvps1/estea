import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { extractRows } from "../lib/stock-plan"
import { SHOPSIDE_MODULE } from "../modules/shopside"
import type ShopsideModuleService from "../modules/shopside/service"
import { parseOpenOrderQuantities, parseShopsideProducts } from "../modules/shopside/stock"

function show(value: unknown, max = 1500): string {
  const text = JSON.stringify(value, null, 2) ?? String(value)
  return text.length > max ? `${text.slice(0, max)}\n…(${text.length - max} karakter daha)` : text
}

/**
 * İlk Shopside bağlantısı: giriş yapar, bağlı platformları, ürün ve sipariş listesinin
 * gerçek biçimini gösterir. Dokümanda yanıt örneği olmadığı için alan adları buradan
 * doğrulanır. Yalnız OKUR; Shopside'a ve Medusa'ya yazmaz.
 * Kullanım: npm run test:shopside
 */
export default async function testShopside({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const shopside = container.resolve<ShopsideModuleService>(SHOPSIDE_MODULE)
  if (!shopside.isConfigured()) {
    throw new Error("SHOPSIDE_API_KEY / SHOPSIDE_API_SECRET boş (Shopside → Profil → API Bilgileri).")
  }
  const options = shopside.getOptions()
  const client = shopside.getClient()

  await client.login()
  logger.info("[test-shopside] giriş başarılı")

  const steps: [string, () => Promise<unknown>][] = [
    ["bağlı platformlar (api/list)", () => client.listApis()],
    ["ürünler (product/list)", () => client.listProducts(options.productListProcessId)],
    [
      "siparişler (order/list)",
      () => client.listOrders({ processId: options.orderListProcessId, page: 1, limit: 5 }),
    ],
  ]
  const bodies: unknown[] = []
  for (const [label, run] of steps) {
    try {
      const body = await run()
      bodies.push(body)
      logger.info(`[test-shopside] ${label}:\n${show(body)}`)
    } catch (err) {
      bodies.push(null)
      logger.error(`[test-shopside] ${label} OKUNAMADI: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Eşitlemenin bu yanıtları okuyup okuyamadığı
  try {
    const products = parseShopsideProducts(extractRows(bodies[1], "Shopside ürün listesi"), options)
    logger.info(
      `[test-shopside] ürün çözümleme: ${products.bySku.size} stok kodu, kodsuz satır ${products.rowsWithoutSku}, mükerrer ${products.duplicates.join(", ") || "-"}`
    )
  } catch (err) {
    logger.error(
      `[test-shopside] ürün çözümleme BAŞARISIZ (SHOPSIDE_SKU_FIELD / _QUANTITY_FIELD / _PRODUCT_ID_FIELD ile düzeltin): ${err instanceof Error ? err.message : String(err)}`
    )
  }
  try {
    const open = parseOpenOrderQuantities(extractRows(bodies[2], "Shopside sipariş listesi"), options)
    logger.info(
      `[test-shopside] sipariş çözümleme: ${open.orderCount} sipariş, ${open.bySku.size} stok kodu, okunamayan satır ${open.linesWithoutSku}`
    )
  } catch (err) {
    logger.error(
      `[test-shopside] sipariş çözümleme BAŞARISIZ (SHOPSIDE_ORDER_LINES_FIELD / SHOPSIDE_ORDER_LIST_PROCESS_ID ile düzeltin): ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

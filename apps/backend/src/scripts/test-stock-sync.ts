import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { syncStock } from "../lib/stock-sync"
import { PARASUT_MODULE } from "../modules/parasut"
import type ParasutModuleService from "../modules/parasut/service"

/**
 * Stok eşitlemesinin planını yazdırır (Paraşüt → Medusa → Shopside).
 * Medusa stoğuna YAZMAZ; Shopside'a yazma yalnız SHOPSIDE_STOCK_APPLY=true ise olur,
 * bu yüzden ilk denemede onu kapalı tutun. Kullanım: npm run test:stock
 */
export default async function testStockSync({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const parasut = container.resolve<ParasutModuleService>(PARASUT_MODULE)
  if (!parasut.isStockConfigured()) {
    throw new Error("Paraşüt kimlikleri boş (PARASUT_CLIENT_ID …); mock modda okunacak stok yok.")
  }

  const result = await syncStock(container, { apply: false })
  if (result.status === "disabled") return

  const { parsed, plan, skipped, shopside } = result
  logger.info(
    `[test-stock] ${result.status} parasutSku=${parsed.bySku.size} eşleşen=${plan.matched} değişecek=${plan.changes.length}`
  )
  for (const c of plan.changes) {
    logger.info(`[test-stock] ${c.sku}: ${c.from} → ${c.to} (Paraşüt ${c.source}, faturasız ${c.inFlight})`)
  }
  logger.info(`[test-stock] Paraşüt'te yok: ${plan.missing.join(", ") || "-"}`)
  logger.info(`[test-stock] stok takibi kapalı: ${parsed.untracked.join(", ") || "-"}`)
  logger.info(`[test-stock] miktar okunamadı: ${parsed.invalidQuantity.join(", ") || "-"}`)
  logger.info(`[test-stock] mükerrer kod: ${parsed.duplicates.join(", ") || "-"}`)
  logger.info(`[test-stock] kodsuz ürün: ${parsed.rowsWithoutSku}`)
  logger.info(`[test-stock] atlanan: ${skipped.map((s) => `${s.sku} (${s.reason})`).join(", ") || "-"}`)

  if (!shopside) {
    logger.info("[test-stock] Shopside kapalı (kimlik yok)")
    return
  }
  logger.info(
    `[test-stock] Shopside ${shopside.status} açıkSipariş=${shopside.openOrders} eşleşen=${shopside.plan.matched} yazılacak=${shopside.plan.pushes.length}`
  )
  for (const [sku, qty] of shopside.openBySku) {
    logger.info(`[test-stock] açık pazaryeri siparişi ${sku}: ${qty}`)
  }
  for (const p of shopside.plan.pushes) {
    logger.info(`[test-stock] Shopside ${p.sku}: ${p.from ?? "?"} → ${p.to}`)
  }
  logger.info(`[test-stock] Shopside'da yok: ${shopside.plan.missing.join(", ") || "-"}`)
}

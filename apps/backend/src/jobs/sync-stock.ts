import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { recordStockSyncFailure, syncStock } from "../lib/stock-sync"
import { errorText } from "../lib/ops-events"

/**
 * Paraşüt → Medusa → Shopside stok eşitlemesi. Paraşüt kimliği yokken çalışmaz;
 * PARASUT_STOCK_APPLY=true olmadan Medusa'ya, SHOPSIDE_STOCK_APPLY=true olmadan
 * Shopside'a yazmaz (yalnız rapor).
 */
export default async function syncStockJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  try {
    await syncStock(container)
  } catch (err) {
    const message = errorText(err)
    logger.error(`[stock-sync] ${message}`)
    await recordStockSyncFailure(container, message)
  }
}

export const config = {
  name: "sync-stock",
  schedule: "*/5 * * * *",
}

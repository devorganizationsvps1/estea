import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { PARASUT_MODULE } from "../modules/parasut"
import type ParasutModuleService from "../modules/parasut/service"
import { SHOPSIDE_MODULE } from "../modules/shopside"
import type ShopsideModuleService from "../modules/shopside/service"
import {
  computeShopsidePushPlan,
  parseOpenOrderQuantities,
  parseShopsideProducts,
  type ShopsidePushPlan,
} from "../modules/shopside/stock"
import { dailyTitle, errorText, recordOpsEvent } from "./ops-events"
import {
  buildStockFromParasutProducts,
  computeInFlightBySku,
  computeStockPlan,
  extractRows,
  mergeQuantities,
  normalizeSku,
  toTrackedVariants,
  type OrderGraphRow,
  type ParsedStock,
  type StockPlan,
  type StockRow,
  type VariantGraphRow,
} from "./stock-plan"

/** Medusa kilit süresini `timeout`tan alır; Paraşüt + Shopside istekleri + DB işini rahat aşmalı. */
const LOCK_TIMEOUT_SECONDS = 280
const REPORT_LIST_LIMIT = 40
const SHOPSIDE_PAGE_SIZE = 100
const SHOPSIDE_MAX_PAGES = 50

export type ShopsideSyncReport = {
  /** Faturası kesilmemiş pazaryeri siparişi sayısı ve SKU başına adetleri */
  openOrders: number
  openBySku: Map<string, number>
  plan: ShopsidePushPlan
  status: "applied" | "dry_run" | "guarded" | "skipped"
  failed: { sku: string; error: string }[]
}

export type StockSyncResult =
  | { status: "disabled" }
  | {
      status: "applied" | "dry_run" | "guarded"
      parsed: ParsedStock & { untracked: string[] }
      plan: StockPlan
      skipped: { sku: string; reason: string }[]
      shopside: ShopsideSyncReport | null
    }

type LockingLike = {
  execute: <T>(
    keys: string | string[],
    job: () => Promise<T>,
    args?: { timeout?: number }
  ) => Promise<T>
}

function dayStamp(): string {
  return new Date().toISOString().slice(0, 10)
}

function listText(values: string[]): string {
  const shown = values.slice(0, REPORT_LIST_LIMIT).join(", ")
  return values.length > REPORT_LIST_LIMIT ? `${shown} (+${values.length - REPORT_LIST_LIMIT})` : shown
}

/** Aynı liste günde bir kez düşer; liste değişince yeni kayıt açılır. */
async function warnDaily(
  container: MedusaContainer,
  title: string,
  values: string[]
): Promise<void> {
  if (!values.length) return
  await recordOpsEvent(container, {
    kind: "stock.sync",
    level: "warning",
    title: dailyTitle(title, values),
    detail: listText(values),
    oncePerTitle: true,
  })
}

/** Faturası kesilmemiş pazaryeri siparişleri (durum başına sayfa sayfa). */
async function readOpenShopsideOrders(shopside: ShopsideModuleService): Promise<StockRow[]> {
  const options = shopside.getOptions()
  const client = shopside.getClient()
  const rows: StockRow[] = []
  for (const status of options.openOrderStatuses) {
    for (let page = 1; ; page++) {
      if (page > SHOPSIDE_MAX_PAGES) {
        throw new Error(`Shopside sipariş listesi ${SHOPSIDE_MAX_PAGES} sayfayı aştı (durum ${status})`)
      }
      const pageRows = extractRows(
        await client.listOrders({
          processId: options.orderListProcessId,
          status,
          page,
          limit: SHOPSIDE_PAGE_SIZE,
        }),
        "Shopside sipariş listesi"
      )
      rows.push(...pageRows)
      if (pageRows.length < SHOPSIDE_PAGE_SIZE) break
    }
  }
  return rows
}

async function runSync(
  container: MedusaContainer,
  parasut: ParasutModuleService,
  shopside: ShopsideModuleService | null,
  applyOverride?: boolean
): Promise<StockSyncResult> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const options = parasut.getStockOptions()
  const apply = applyOverride ?? options.apply

  const products = await parasut.listAllProducts()
  // Boş liste "her şey tükendi" değil, büyük olasılıkla hatalı yanıttır.
  if (!products.length) throw new Error("Paraşüt'ten boş ürün listesi geldi")
  const parsed = buildStockFromParasutProducts(products)

  const shopsideOptions = shopside?.getOptions()
  const openOrderRows =
    shopside && shopsideOptions?.ordersEnabled ? await readOpenShopsideOrders(shopside) : []
  const open = parseOpenOrderQuantities(openOrderRows, shopsideOptions)

  const { data: variantRows } = await query.graph({
    entity: "product_variant",
    fields: [
      "id",
      "sku",
      "manage_inventory",
      "inventory_items.required_quantity",
      "inventory_items.inventory_item_id",
      "inventory_items.inventory.location_levels.location_id",
      "inventory_items.inventory.location_levels.stocked_quantity",
      "inventory_items.inventory.location_levels.reserved_quantity",
    ],
  })
  const { tracked, skipped } = toTrackedVariants(
    variantRows as unknown as VariantGraphRow[],
    options.locationId
  )

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "status",
      "metadata",
      "items.id",
      "items.variant_sku",
      "items.detail.fulfilled_quantity",
      "items.detail.return_received_quantity",
    ],
    // Tarih penceresi yok: faturası kesilemeyen sipariş ne kadar eski olursa olsun
    // adedi Paraşüt'ten düşmemiştir.
    filters: { status: { $nin: ["canceled"] } },
  })

  const plan = computeStockPlan({
    variants: tracked,
    stockBySku: parsed.bySku,
    inFlightBySku: mergeQuantities(
      computeInFlightBySku(orders as unknown as OrderGraphRow[]),
      open.bySku
    ),
    maxZeroRatio: options.maxZeroRatio,
  })

  await warnDaily(container, "Paraşüt'te bulunmayan SKU'lar (ürün kodu eşleşmiyor)", plan.missing)
  await warnDaily(
    container,
    "Paraşüt'te stok takibi kapalı ürünler",
    parsed.untracked.filter((sku) => tracked.some((v) => normalizeSku(v.sku) === sku))
  )
  await warnDaily(container, "Paraşüt'te stok miktarı okunamayan SKU'lar", parsed.invalidQuantity)
  await warnDaily(container, "Paraşüt'te aynı ürün koduyla birden çok ürün", parsed.duplicates)
  await warnDaily(
    container,
    "Eşitlenemeyen varyantlar",
    skipped.map((s) => `${s.sku}: ${s.reason}`)
  )
  await warnDaily(
    container,
    "Rezerve adedin altına düşen stok",
    plan.oversold.map((o) => `${o.sku}: stok ${o.target}, ayrılmış ${o.reserved}`)
  )

  if (tracked.length && !plan.matched) {
    throw new Error("Hiçbir SKU Paraşüt ürün koduyla eşleşmedi; ürün kodları ya da stok takibi eksik")
  }

  const summary = `eşleşen=${plan.matched} değişecek=${plan.changes.length} sıfırlanacak=${plan.newlyZero} eksik=${plan.missing.length} atlanan=${skipped.length} açıkPazaryeriSiparişi=${open.orderCount}`

  let status: "applied" | "dry_run" | "guarded"
  if (plan.zeroGuardTripped) {
    status = "guarded"
    await recordOpsEvent(container, {
      kind: "stock.sync",
      level: "error",
      title: `Toplu sıfırlama engellendi, stok yazılmadı (${dayStamp()})`,
      detail: `${summary}. Bilinçliyse PARASUT_STOCK_MAX_ZERO_RATIO=1.`,
      oncePerTitle: true,
    })
  } else if (!apply) {
    status = "dry_run"
    logger.info(`[stock-sync] DRY-RUN ${summary}`)
  } else {
    status = "applied"
    if (plan.changes.length) {
      const inventory = container.resolve(Modules.INVENTORY)
      await inventory.updateInventoryLevels(
        plan.changes.map((c) => ({
          inventory_item_id: c.inventoryItemId,
          location_id: c.locationId,
          stocked_quantity: c.to,
        }))
      )
    }
    logger.info(`[stock-sync] ${summary}`)
  }

  const shopsideReport = shopside
    ? await pushToShopside(container, shopside, {
        tracked,
        plan,
        medusaStatus: status,
        open,
      })
    : null

  return { status, parsed, plan, skipped, shopside: shopsideReport }
}

/**
 * Medusa'nın satılabilir adedini Shopside'a yazar. Medusa stoğu bu turda yazıldıysa yeni
 * değer, yazılmadıysa (rapor modu) eldeki değer esas alınır; Medusa turu korumaya
 * takıldıysa Shopside'a da yazılmaz.
 */
async function pushToShopside(
  container: MedusaContainer,
  shopside: ShopsideModuleService,
  input: {
    tracked: ReturnType<typeof toTrackedVariants>["tracked"]
    plan: StockPlan
    medusaStatus: "applied" | "dry_run" | "guarded"
    open: ReturnType<typeof parseOpenOrderQuantities>
  }
): Promise<ShopsideSyncReport> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const options = shopside.getOptions()
  const client = shopside.getClient()

  const productRows = extractRows(
    await client.listProducts(options.productListProcessId),
    "Shopside ürün listesi"
  )
  const parsed = parseShopsideProducts(productRows, options)
  const pushPlan = computeShopsidePushPlan({
    variants: input.tracked,
    products: parsed.bySku,
    stockOverride:
      input.medusaStatus === "applied"
        ? new Map(input.plan.changes.map((c) => [normalizeSku(c.sku), c.to]))
        : undefined,
    maxZeroRatio: options.maxZeroRatio,
  })

  await warnDaily(container, "Shopside'da bulunmayan SKU'lar (stok kodu eşleşmiyor)", pushPlan.missing)
  await warnDaily(container, "Shopside'da aynı stok koduyla birden çok ürün", parsed.duplicates)

  const report: ShopsideSyncReport = {
    openOrders: input.open.orderCount,
    openBySku: input.open.bySku,
    plan: pushPlan,
    status: "dry_run",
    failed: [],
  }
  const summary = `eşleşen=${pushPlan.matched} yazılacak=${pushPlan.pushes.length} sıfırlanacak=${pushPlan.newlyZero} eksik=${pushPlan.missing.length}`

  if (input.medusaStatus === "guarded") {
    report.status = "skipped"
    return report
  }
  if (pushPlan.zeroGuardTripped) {
    report.status = "guarded"
    await recordOpsEvent(container, {
      kind: "stock.sync",
      level: "error",
      title: `Shopside'da toplu sıfırlama engellendi, stok yazılmadı (${dayStamp()})`,
      detail: `${summary}. Bilinçliyse SHOPSIDE_STOCK_MAX_ZERO_RATIO=1.`,
      oncePerTitle: true,
    })
    return report
  }
  if (!options.stockApply) {
    logger.info(`[stock-sync] Shopside DRY-RUN ${summary}`)
    return report
  }

  report.status = "applied"
  for (const push of pushPlan.pushes) {
    try {
      await client.updateStock(push.productId, push.to)
    } catch (err) {
      report.failed.push({ sku: push.sku, error: errorText(err) })
    }
  }
  await warnDaily(
    container,
    "Shopside'a stok yazılamayan SKU'lar",
    report.failed.map((f) => `${f.sku}: ${f.error.slice(0, 120)}`)
  )
  logger.info(`[stock-sync] Shopside ${summary} hata=${report.failed.length}`)
  return report
}

/**
 * Stok eşitlemesi. Stok sahibi Paraşüt'tür (K15):
 *   Paraşüt stoğu − faturasız site satışları − faturasız pazaryeri siparişleri → Medusa
 *   Medusa satılabilir adedi → Shopside (pazaryerleri)
 * `apply` verilmezse PARASUT_STOCK_APPLY belirler; kapalıyken yalnız rapor üretir.
 */
export async function syncStock(
  container: MedusaContainer,
  input?: { apply?: boolean }
): Promise<StockSyncResult> {
  const parasut = container.resolve<ParasutModuleService>(PARASUT_MODULE)
  if (!parasut.isStockConfigured()) return { status: "disabled" }
  // Kimlik var ama admin'den bağlanılmadı: her 5 dakikada hata yazmasın.
  if (!(await parasut.isConnected())) return { status: "disabled" }
  const shopsideService = container.resolve<ShopsideModuleService>(SHOPSIDE_MODULE)
  const shopside = shopsideService.isConfigured() ? shopsideService : null

  const locking = container.resolve(Modules.LOCKING) as LockingLike
  return locking.execute(
    "stock-sync",
    () => runSync(container, parasut, shopside, input?.apply),
    { timeout: LOCK_TIMEOUT_SECONDS }
  )
}

export async function recordStockSyncFailure(
  container: MedusaContainer,
  message: string
): Promise<void> {
  await recordOpsEvent(container, {
    kind: "stock.sync",
    level: "error",
    title: `Stok eşitlemesi başarısız (${dayStamp()})`,
    detail: message,
    oncePerTitle: true,
  })
}

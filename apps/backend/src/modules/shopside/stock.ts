/**
 * Shopside yanıtları → stok hesabı (saf, HTTP/DB yok).
 *
 * İki iş:
 *  1. Açık pazaryeri siparişleri: Shopside'a düşmüş ama faturası kesilmemiş siparişlerin
 *     adetleri. Paraşüt bunları henüz bilmez; Medusa hedefinden düşülür.
 *  2. Stok yazma planı: Medusa'nın satılabilir adedi (stok − rezerve) Shopside'a yazılır,
 *     böylece site siparişi kargolanmadan pazaryerinde de düşer.
 *
 * Yanıt biçimi dokümanda yok: alan adayları denenir, env ile ezilebilir; okunamayan
 * yanıt sessizce yutulmaz, hata olur.
 */

import {
  PRODUCT_ID_FIELDS,
  QUANTITY_FIELDS,
  SKU_FIELDS,
  isRow,
  normalizeSku,
  parseQuantity,
  readField,
  readText,
  type StockRow,
  type TrackedVariant,
} from "../../lib/stock-plan"

export type ShopsideFieldOptions = {
  skuField?: string
  quantityField?: string
  productIdField?: string
  orderLinesField?: string
}

export type ShopsideProduct = { productId: string; stock: number | null }

export type ParsedShopsideProducts = {
  bySku: Map<string, ShopsideProduct>
  duplicates: string[]
  rowsWithoutSku: number
}

export type ShopsidePush = {
  sku: string
  productId: string
  from: number | null
  to: number
}

export type ShopsidePushPlan = {
  pushes: ShopsidePush[]
  matched: number
  unchanged: number
  /** Medusa'da olup Shopside'da bulunmayan SKU'lar */
  missing: string[]
  newlyZero: number
  zeroGuardTripped: boolean
}

const ORDER_LINE_FIELDS = [
  "products",
  "order_products",
  "items",
  "order_items",
  "details",
  "order_details",
  "lines",
]
const ORDER_ID_FIELDS = ["order_id", "id", "process_id", "order_number", "order_no"]

function fields(override: string | undefined, defaults: string[]): string[] {
  return override ? [override] : defaults
}

export function parseShopsideProducts(
  rows: StockRow[],
  options: ShopsideFieldOptions = {}
): ParsedShopsideProducts {
  const skuFields = fields(options.skuField, SKU_FIELDS)
  const quantityFields = fields(options.quantityField, QUANTITY_FIELDS)
  const idFields = fields(options.productIdField, PRODUCT_ID_FIELDS)

  const bySku = new Map<string, ShopsideProduct>()
  const duplicates = new Set<string>()
  const seen = new Set<string>()
  let rowsWithoutSku = 0

  for (const row of rows) {
    const sku = normalizeSku(readText(row, skuFields))
    const productId = readText(row, idFields)
    if (!sku || !productId) {
      rowsWithoutSku++
      continue
    }
    if (seen.has(sku)) {
      duplicates.add(sku)
      bySku.delete(sku)
      continue
    }
    seen.add(sku)
    bySku.set(sku, { productId, stock: parseQuantity(readField(row, quantityFields)) })
  }

  if (rows.length && !bySku.size && !duplicates.size) {
    throw new Error(
      `Shopside ürün satırlarında stok kodu / ürün kimliği tanınmadı. Gelen alanlar: ${Object.keys(rows[0]).join(", ")}`
    )
  }
  return { bySku, duplicates: [...duplicates], rowsWithoutSku }
}

/**
 * Açık sipariş satırları → SKU başına adet. Aynı sipariş iki durumda birden gelirse
 * (sayfalar arasında durum değişti) bir kez sayılır.
 */
export function parseOpenOrderQuantities(
  orders: StockRow[],
  options: ShopsideFieldOptions = {}
): { bySku: Map<string, number>; orderCount: number; linesWithoutSku: number } {
  const skuFields = fields(options.skuField, SKU_FIELDS)
  const quantityFields = fields(options.quantityField, QUANTITY_FIELDS)
  const lineFields = fields(options.orderLinesField, ORDER_LINE_FIELDS)

  const bySku = new Map<string, number>()
  const seenOrders = new Set<string>()
  let orderCount = 0
  let linesWithoutSku = 0
  let ordersWithLines = 0

  for (const order of orders) {
    const orderId = readText(order, ORDER_ID_FIELDS)
    if (orderId) {
      if (seenOrders.has(orderId)) continue
      seenOrders.add(orderId)
    }
    orderCount++
    const raw = readField(order, lineFields)
    const lines = Array.isArray(raw) ? raw.filter(isRow) : []
    if (lines.length) ordersWithLines++

    for (const line of lines) {
      const sku = normalizeSku(readText(line, skuFields))
      const quantity = parseQuantity(readField(line, quantityFields))
      if (!sku || quantity === null) {
        linesWithoutSku++
        continue
      }
      if (quantity > 0) bySku.set(sku, (bySku.get(sku) ?? 0) + quantity)
    }
  }

  // Sipariş var ama hiçbirinde satır okunamadı: adet 0 sayılırsa stok fazla görünür.
  if (orderCount && !ordersWithLines) {
    throw new Error(
      `Shopside siparişlerinde ürün satırları tanınmadı (SHOPSIDE_ORDER_LINES_FIELD). Gelen alanlar: ${Object.keys(orders[0]).join(", ")}`
    )
  }
  return { bySku, orderCount, linesWithoutSku }
}

/**
 * Shopside hedefi = Medusa'nın satılabilir adedi (stok − rezerve), `stockOverride` verilirse
 * o turda yazılacak yeni Medusa stoğu esas alınır.
 */
export function computeShopsidePushPlan(input: {
  variants: TrackedVariant[]
  products: Map<string, ShopsideProduct>
  stockOverride?: Map<string, number>
  maxZeroRatio: number
}): ShopsidePushPlan {
  const pushes: ShopsidePush[] = []
  const missing: string[] = []
  let matched = 0

  for (const variant of input.variants) {
    const key = normalizeSku(variant.sku)
    const product = input.products.get(key)
    if (!product) {
      missing.push(variant.sku)
      continue
    }
    matched++
    const stocked = input.stockOverride?.get(key) ?? variant.stocked
    const target = Math.max(0, Math.floor(stocked - variant.reserved))
    if (product.stock !== target) {
      pushes.push({ sku: variant.sku, productId: product.productId, from: product.stock, to: target })
    }
  }

  const newlyZero = pushes.filter((p) => p.to === 0 && (p.from ?? 1) > 0).length
  const zeroLimit = Math.max(2, Math.floor(matched * input.maxZeroRatio))
  return {
    pushes,
    matched,
    unchanged: matched - pushes.length,
    missing,
    newlyZero,
    zeroGuardTripped: newlyZero > zeroLimit,
  }
}

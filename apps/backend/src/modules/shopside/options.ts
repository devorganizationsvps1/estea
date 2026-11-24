/**
 * Shopside (Paraşüt'ün pazaryeri entegrasyon paneli) seçenekleri.
 * https://apidocs.shopside.io — kimlik: panelde Profil → API Bilgileri (api_key + api_secret).
 *
 * Shopside dışarıdan sipariş kabul etmez; site siparişleri oraya gitmez. Bu modül yalnız
 * stok tarafını bağlar: açık pazaryeri siparişlerini okur, satılabilir stoğu yazar.
 *
 * Dokümanda yanıt örneği ve test ortamı yok. Kimlik yoksa modül kapalıdır;
 * SHOPSIDE_STOCK_APPLY=true olmadan Shopside'a hiçbir şey yazılmaz.
 */

export type ShopsideRawOptions = {
  apiKey?: string
  apiSecret?: string
  baseUrl?: string
  timeoutMs?: string | number
  /** true → satılabilir stok Shopside'a yazılır; kapalıyken yalnız rapor */
  stockApply?: boolean | string
  /** Açık pazaryeri siparişleri Medusa stoğundan düşülsün mü (okuma; varsayılan açık) */
  ordersEnabled?: boolean | string
  /** order/list `process_id` değeri (anlamı dokümanda yok; test betiğiyle doğrulanır) */
  orderListProcessId?: string
  /** product/list `process_id` değeri */
  productListProcessId?: string
  /** Faturası kesilmemiş sayılan sipariş durumları (1: Yeni, 2: Onaylanmış) */
  openOrderStatuses?: string
  skuField?: string
  quantityField?: string
  productIdField?: string
  orderLinesField?: string
  maxZeroRatio?: string | number
}

export type ShopsideOptions = {
  apiKey: string
  apiSecret: string
  baseUrl: string
  timeoutMs: number
  stockApply: boolean
  ordersEnabled: boolean
  orderListProcessId: string
  productListProcessId: string
  openOrderStatuses: string[]
  skuField: string
  quantityField: string
  productIdField: string
  orderLinesField: string
  maxZeroRatio: number
}

export const SHOPSIDE_DEFAULT_BASE_URL = "https://api.shopside.io/user/"

const PLACEHOLDER = new Set(["", "changeme", "change-me", "placeholder", "todo", "****************"])

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim()
}

export function parseFlag(value?: unknown): boolean {
  const s = text(value).toLowerCase()
  return s === "1" || s === "true" || s === "yes" || s === "on"
}

export function isConfigured(options: Pick<ShopsideOptions, "apiKey" | "apiSecret">): boolean {
  return (
    !PLACEHOLDER.has(options.apiKey.toLowerCase()) &&
    !PLACEHOLDER.has(options.apiSecret.toLowerCase())
  )
}

export function normalizeOptions(raw: ShopsideRawOptions = {}): ShopsideOptions {
  const timeout = Number(raw.timeoutMs)
  const zeroRatio = Number(raw.maxZeroRatio)
  const statuses = text(raw.openOrderStatuses)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return {
    apiKey: text(raw.apiKey),
    apiSecret: text(raw.apiSecret),
    baseUrl: text(raw.baseUrl) || SHOPSIDE_DEFAULT_BASE_URL,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30000,
    stockApply: parseFlag(raw.stockApply),
    ordersEnabled: text(raw.ordersEnabled) ? parseFlag(raw.ordersEnabled) : true,
    orderListProcessId: text(raw.orderListProcessId),
    productListProcessId: text(raw.productListProcessId),
    openOrderStatuses: statuses.length ? statuses : ["1", "2"],
    skuField: text(raw.skuField),
    quantityField: text(raw.quantityField),
    productIdField: text(raw.productIdField),
    orderLinesField: text(raw.orderLinesField),
    maxZeroRatio:
      text(raw.maxZeroRatio) && Number.isFinite(zeroRatio) && zeroRatio > 0 && zeroRatio <= 1
        ? zeroRatio
        : 0.5,
  }
}

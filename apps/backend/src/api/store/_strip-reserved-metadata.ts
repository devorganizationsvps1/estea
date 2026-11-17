import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

/**
 * Store API metadata'sı istemciden gelir ama bazı anahtarlar sunucu tarafında
 * karar veriyor. Sepet metadata'sı siparişe kopyalanır (completeCartWorkflow):
 * - source → satış istatistiği / pazarlama davranışı (yalnızca sunucu yazar)
 * Satır metadata'sındaki ağırlık/boyut → kargo fiyatı ve gerçek gönderi paketi.
 * Bu anahtarlar yalnızca sunucu (import, admin) tarafından yazılır; istekten silinir.
 *
 * Sepet için izinli liste: siparişe kopyalanan metadata'da sunucunun karar verdiği
 * anahtarlar (bizimhesap_invoice, contracts, label_printed_at, escay_*, paytr_refund …)
 * istemciden gelirse fatura/sözleşme atlanır, sipariş kargo sayacından düşer. Bu yüzden
 * yalnız mağazanın yazdığı anahtarlar geçer; yenisi eklenirse buraya da eklenmeli.
 */
const CART_ALLOWED = new Set([
  "payment_method",
  "marketing_consent",
  "tracking_consent",
  "legal_accepted_at",
  "order_note",
])
const LINE_ITEM_RESERVED = new Set(["weight_kg", "weight_g", "weight", "length", "width", "height"])

function strip(metadata: unknown, isReserved: (key: string) => boolean): void {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return
  for (const key of Object.keys(metadata)) {
    if (isReserved(key)) delete (metadata as Record<string, unknown>)[key]
  }
}

function makeStripper(isReserved: (key: string) => boolean) {
  return (req: MedusaRequest, _res: MedusaResponse, next: MedusaNextFunction) => {
    strip((req.body as { metadata?: unknown } | undefined)?.metadata, isReserved)
    strip((req as { validatedBody?: { metadata?: unknown } }).validatedBody?.metadata, isReserved)
    next()
  }
}

function stripItems(items: unknown): void {
  if (!Array.isArray(items)) return
  for (const item of items) {
    strip((item as { metadata?: unknown } | null)?.metadata, isLineItemReserved)
  }
}

const isLineItemReserved = (key: string) => LINE_ITEM_RESERVED.has(key)
const isCartReserved = (key: string) => !CART_ALLOWED.has(key)

/** POST /store/carts ve /store/carts/:id — sepet metadata'sı + (oluşturmada) items[].metadata */
export function stripReservedCartMetadata(
  req: MedusaRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction
) {
  for (const body of [
    req.body as { metadata?: unknown; items?: unknown } | undefined,
    (req as { validatedBody?: { metadata?: unknown; items?: unknown } }).validatedBody,
  ]) {
    strip(body?.metadata, isCartReserved)
    stripItems(body?.items)
  }
  next()
}

export const stripReservedLineItemMetadata = makeStripper(isLineItemReserved)

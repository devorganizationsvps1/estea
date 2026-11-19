import { coerceAmount } from "../emails/format"

type TotalsLike = {
  original_item_total?: unknown
  item_total?: unknown
  discount_total?: unknown
}

const num = (v: unknown): number | null => {
  const c = coerceAmount(v)
  if (c == null || c === "") return null
  const n = Number(c)
  return Number.isFinite(n) ? n : null
}

const round = (n: number) => Math.round(n * 100) / 100

/**
 * Ürün indirimi (KDV dahil). Medusa `discount_total` kargo indirimini de içerir
 * ("Ücretsiz kargo" promosyonu); ürünler satırından düşülürse kargo iki kez sayılır.
 * `item_total` indirim sonrası, `original_item_total` indirim öncesi ürün toplamıdır.
 */
export function productDiscountTotal(o: TotalsLike): number {
  const original = num(o.original_item_total)
  const items = num(o.item_total)
  if (original != null && items != null) return Math.max(0, round(original - items))
  return Math.max(0, num(o.discount_total) ?? 0)
}

/** İndirim öncesi ürün toplamı (KDV dahil). */
export function productSubtotalBeforeDiscount(o: TotalsLike & { item_subtotal?: unknown }): number {
  const original = num(o.original_item_total)
  if (original != null) return round(original)
  const items = num(o.item_total)
  if (items != null) return round(items + productDiscountTotal(o))
  return round(num(o.item_subtotal) ?? 0)
}

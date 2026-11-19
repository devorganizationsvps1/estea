import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

type Adjustment = { code?: string | null; amount?: unknown }

export type PromotionUsageOrder = {
  id: string
  email?: string | null
  customer_id?: string | null
  metadata?: Record<string, unknown> | null
  items?: { adjustments?: Adjustment[] | null }[] | null
  shipping_methods?: { adjustments?: Adjustment[] | null }[] | null
}

/** Sipariş metadata'sında kupon kullanımının geri alındığını gösteren anahtar. */
export const PROMOTION_USAGE_REVERTED_KEY = "promotion_usage_reverted_at"

function amountOf(v: unknown): number {
  if (v && typeof v === "object" && "value" in (v as object)) {
    return Number((v as { value: unknown }).value) || 0
  }
  return Number(v) || 0
}

/**
 * Medusa sepeti tamamlarken (completeCartWorkflow → registerUsageStep) her kalem ve
 * kargo indirim satırını ayrı bir kullanım olarak kaydeder. Geri alma da aynı listeyle
 * yapılmalı; yoksa `limit` ve bütçe sayacı tutmaz.
 */
export function buildPromotionUsageActions(
  order: Pick<PromotionUsageOrder, "items" | "shipping_methods">
): { code: string; amount: number }[] {
  const adjustments = [
    ...(order.items || []).flatMap((i) => i.adjustments || []),
    ...(order.shipping_methods || []).flatMap((s) => s.adjustments || []),
  ]
  return adjustments
    .filter((a): a is Adjustment & { code: string } => typeof a.code === "string" && a.code.length > 0)
    .map((a) => ({ code: a.code, amount: amountOf(a.amount) }))
}

/**
 * İptal edilen siparişin kupon kullanımını geri verir. Medusa iptal akışı bunu yapmaz;
 * sipariş ödemeden önce açıldığı için yarım kalan PayTR denemeleri kampanya hakkını
 * tüketirdi. Metadata işaretiyle bir kez çalışır.
 */
export async function revertOrderPromotionUsage(
  scope: MedusaContainer,
  orderId: string
): Promise<{ reverted: number; skipped?: "not_canceled" | "already" | "no_promotion" | "not_found" }> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "status",
      "canceled_at",
      "email",
      "customer_id",
      "metadata",
      "items.adjustments.code",
      "items.adjustments.amount",
      "shipping_methods.adjustments.code",
      "shipping_methods.adjustments.amount",
    ],
    filters: { id: orderId },
  })
  const order = data?.[0] as (PromotionUsageOrder & { status?: string | null; canceled_at?: unknown }) | undefined
  if (!order?.id) return { reverted: 0, skipped: "not_found" }
  if (order.status !== "canceled" && !order.canceled_at) return { reverted: 0, skipped: "not_canceled" }
  if (order.metadata?.[PROMOTION_USAGE_REVERTED_KEY]) return { reverted: 0, skipped: "already" }

  const actions = buildPromotionUsageActions(order)
  if (!actions.length) return { reverted: 0, skipped: "no_promotion" }

  const promotion = scope.resolve(Modules.PROMOTION)
  await promotion.revertUsage(actions as never, {
    customer_id: order.customer_id || null,
    customer_email: order.email || null,
  } as never)

  await scope.resolve(Modules.ORDER).updateOrders([
    {
      id: order.id,
      metadata: { ...(order.metadata || {}), [PROMOTION_USAGE_REVERTED_KEY]: new Date().toISOString() },
    },
  ])
  return { reverted: actions.length }
}

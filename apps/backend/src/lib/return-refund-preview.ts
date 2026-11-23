import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { isExchangeActive } from "./exchange-plan"
import {
  calculateReturnRefundAmount,
  PAYTR_PROVIDER_ID,
  REFUND_ORDER_FIELDS,
  type RefundOrderItem,
  type ReturnRefundMeta,
} from "./return-refund"

const num = (v: unknown): number => {
  const n = Number((v as { value?: unknown } | null)?.value ?? v)
  return Number.isFinite(n) ? n : 0
}
const round = (n: number) => Math.round(n * 100) / 100

export type RefundPreview = {
  /** card: karta otomatik iade · manual: elle iade (PayTR ödemesi yok ya da tutar belirsiz) · exchange: para iadesi yok */
  mode: "card" | "manual" | "exchange"
  /** Teslim alınınca iade edilecek tutar (kart modunda PayTR'de kalan tutarla sınırlı). */
  amount: number
  items_amount: number
  shipping_amount: number
  shipping_included: boolean
  /** false: ödenen fiyat okunamadı, otomatik iade yapılmayacak. */
  certain: boolean
}

/**
 * Teslim alma onayında gösterilen kesin tutar: processReturnRefund'ın aynı hesabı
 * (calculateReturnRefundAmount), kabul edilecek adetlerle, hiçbir şey yazmadan.
 */
export async function previewReturnRefund(
  scope: MedusaContainer,
  input: { return_id: string; items: { item_id: string; quantity: number }[]; refund_shipping: boolean }
): Promise<RefundPreview> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: returns } = await query.graph({
    entity: "return",
    fields: ["id", "status", "order_id", "metadata", "items.item_id", "items.quantity", "items.reason_id"],
    filters: { id: input.return_id },
  })
  const ret = returns?.[0] as
    | {
        id: string
        order_id?: string | null
        metadata?: Record<string, unknown> | null
        items?: { item_id?: string | null; quantity?: number | null; reason_id?: string | null }[]
      }
    | undefined
  if (!ret?.order_id) throw new Error("İade bulunamadı")

  const { data: orders } = await query.graph({
    entity: "order",
    fields: REFUND_ORDER_FIELDS,
    filters: { id: ret.order_id },
  })
  const order = orders?.[0] as
    | {
        shipping_total?: unknown
        items?: RefundOrderItem[]
        payment_collections?: {
          payments?: { id?: string; provider_id?: string | null; captures?: { amount?: unknown }[]; refunds?: { amount?: unknown }[] }[]
        }[]
        returns?: { id?: string; metadata?: Record<string, unknown> | null }[]
      }
    | undefined
  if (!order) throw new Error("Sipariş bulunamadı")

  const reasonIds = [...new Set((ret.items || []).map((i) => i.reason_id).filter((id): id is string => Boolean(id)))]
  const reasonsById: Record<string, { metadata?: unknown }> = {}
  if (reasonIds.length) {
    const { data: reasons } = await query.graph({
      entity: "return_reason",
      fields: ["id", "metadata"],
      filters: { id: reasonIds },
    })
    for (const r of reasons || []) {
      const row = r as { id?: string; metadata?: unknown }
      if (row.id) reasonsById[row.id] = { metadata: row.metadata }
    }
  }

  const accepted = new Map(input.items.map((i) => [i.item_id, Math.max(0, Math.floor(Number(i.quantity) || 0))]))
  const calc = calculateReturnRefundAmount({
    returnStatus: "partially_received",
    returnItems: (ret.items || []).map((i) => ({
      item_id: i.item_id,
      quantity: i.quantity,
      // Talep edilenden fazlası kabul edilemez
      received_quantity: Math.min(Number(i.quantity) || 0, accepted.get(i.item_id || "") || 0),
      reason_id: i.reason_id,
    })),
    orderItems: order.items || [],
    reasonsById,
    shippingTotal: num(order.shipping_total),
    shippingAlreadyRefunded: (order.returns || []).some((r) => {
      if (!r?.id || r.id === ret.id) return false
      const pr = r.metadata?.paytr_refund as ReturnRefundMeta | undefined
      return pr?.status === "success" && pr.shipping_included === true
    }),
    forceShipping: input.refund_shipping,
  })

  const base = {
    items_amount: calc.itemsAmount,
    shipping_amount: calc.shippingAmount,
    shipping_included: calc.shippingIncluded,
    certain: calc.uncertainItems.length === 0,
  }
  if (isExchangeActive(ret.metadata)) return { ...base, mode: "exchange", amount: 0 }

  const payment = (order.payment_collections || [])
    .flatMap((pc) => pc.payments || [])
    .find((p) => p?.provider_id === PAYTR_PROVIDER_ID && (p.captures || []).reduce((s, c) => s + num(c.amount), 0) > 0)
  if (!payment || !base.certain) return { ...base, mode: "manual", amount: calc.total }

  const captured = (payment.captures || []).reduce((s, c) => s + num(c.amount), 0)
  const refunded = (payment.refunds || []).reduce((s, r) => s + num(r.amount), 0)
  return { ...base, mode: "card", amount: round(Math.min(calc.total, Math.max(0, captured - refunded))) }
}

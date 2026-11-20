import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { isPaytrMockEnabled } from "../modules/paytr/mock-iade"
import { recordOpsEvent } from "./ops-events"
import { queryPaytrStatus, type PaytrStatusResult } from "./paytr-status"
import type { ReturnRefundMeta } from "./return-refund"

/**
 * PayTR iade API'si "kabul edildi" der, para dakikalar ya da günler sonra gider
 * (Mareen 3a7888b). Burada PayTR durum sorgusundaki iadeler (`date_completed`)
 * okunur: tamamlanan iade kayda yazılır; 3 günde tamamlanmayan ya da PayTR'de
 * hiç görünmeyen iade için bir kez uyarı düşer.
 */
export type TrackedRefundMeta = ReturnRefundMeta & {
  completed_at?: string
  paytr_reference_no?: string | null
  pending_alerted_at?: string
  missing_alerted_at?: string
}

export const REFUND_PENDING_ALERT_MS = 3 * 24 * 60 * 60 * 1000
export const REFUND_MISSING_ALERT_MS = 24 * 60 * 60 * 1000
const LOOKBACK_MS = 45 * 24 * 60 * 60 * 1000

export type RefundTrackingSummary = { checked: number; completed: number; alerted: number }

type ReturnRow = {
  id: string
  order_id: string
  created_at?: string | Date
  metadata?: Record<string, unknown> | null
}

function canQuery(): boolean {
  return (
    !isPaytrMockEnabled() &&
    Boolean(
      process.env.PAYTR_MERCHANT_ID?.trim() &&
        process.env.PAYTR_MERCHANT_KEY?.trim() &&
        process.env.PAYTR_MERCHANT_SALT?.trim()
    )
  )
}

export async function trackPaytrRefunds(
  container: MedusaContainer,
  deps: { query?: (oid: string) => Promise<PaytrStatusResult>; now?: Date } = {}
): Promise<RefundTrackingSummary> {
  const summary: RefundTrackingSummary = { checked: 0, completed: 0, alerted: 0 }
  if (!deps.query && !canQuery()) return summary
  const query = deps.query ?? queryPaytrStatus
  const now = deps.now ?? new Date()
  const graph = container.resolve(ContainerRegistrationKeys.QUERY)
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const orderModule = container.resolve(Modules.ORDER)

  const { data } = await graph.graph({
    entity: "return",
    fields: ["id", "order_id", "created_at", "metadata"],
    filters: { status: ["received", "partially_received"] },
    pagination: { take: 300, order: { created_at: "DESC" } },
  })
  const rows = (data as ReturnRow[]).filter((r) => {
    const m = r.metadata?.paytr_refund as TrackedRefundMeta | undefined
    if (m?.status !== "success" || m.completed_at || !m.payment_id || !m.at) return false
    return now.getTime() - new Date(m.at).getTime() < LOOKBACK_MS
  })
  if (!rows.length) return summary

  // Aynı siparişin diğer iadelerinin zaten eşlediği PayTR iade referansları
  const claimed = new Set<string>()
  for (const r of data as ReturnRow[]) {
    const ref = (r.metadata?.paytr_refund as TrackedRefundMeta | undefined)?.paytr_reference_no
    if (ref) claimed.add(ref)
  }

  const oidCache = new Map<string, PaytrStatusResult>()
  for (const row of rows) {
    const meta = row.metadata!.paytr_refund as TrackedRefundMeta
    summary.checked++
    try {
      const { data: payments } = await graph.graph({
        entity: "payment",
        fields: ["id", "data"],
        filters: { id: meta.payment_id },
      })
      const oid = String((payments?.[0] as { data?: Record<string, unknown> } | undefined)?.data?.merchant_oid || "")
      if (!oid) continue
      let status = oidCache.get(oid)
      if (!status) {
        status = await query(oid)
        oidCache.set(oid, status)
      }
      if (!status.ok) {
        logger.warn(`[paytr-refund-tracking] durum sorgusu başarısız oid=${oid}: ${status.message}`)
        continue
      }
      const amount = Number(meta.amount) || 0
      const same = status.returns.filter(
        (r) => Math.abs(r.amount - amount) <= 0.01 && !(r.reference_no && claimed.has(r.reference_no))
      )
      const done = same.find((r) => r.status === "completed")
      const save = async (patch: Partial<TrackedRefundMeta>) => {
        await orderModule.updateReturns([
          {
            selector: { id: row.id },
            data: { metadata: { ...(row.metadata || {}), paytr_refund: { ...meta, ...patch } } },
          },
        ])
      }
      if (done) {
        if (done.reference_no) claimed.add(done.reference_no)
        await save({ completed_at: done.completed_at || now.toISOString(), paytr_reference_no: done.reference_no })
        summary.completed++
        continue
      }
      const age = now.getTime() - new Date(meta.at!).getTime()
      if (!same.length && age > REFUND_MISSING_ALERT_MS && !meta.missing_alerted_at) {
        await recordOpsEvent(container, {
          kind: "return.refund_failed",
          level: "error",
          title: "PayTR'de iade kaydı görünmüyor",
          detail:
            `İade ${amount.toFixed(2)} TL bizde "başarılı", ama PayTR durum sorgusunda bu tutarda iade yok (${oid}). ` +
            "PayTR panelinden kontrol edin; gerekiyorsa iadeyi panelden yapın.",
          orderId: row.order_id,
          data: { return_id: row.id, merchant_oid: oid, amount },
        })
        await save({ missing_alerted_at: now.toISOString() })
        summary.alerted++
      } else if (same.length && age > REFUND_PENDING_ALERT_MS && !meta.pending_alerted_at) {
        await recordOpsEvent(container, {
          kind: "return.refund_failed",
          level: "warning",
          title: "PayTR iadesi 3 gündür tamamlanmadı",
          detail: `İade ${amount.toFixed(2)} TL PayTR'de "Beklemede" (${oid}). Müşteri sorarsa PayTR destekle görüşün.`,
          orderId: row.order_id,
          data: { return_id: row.id, merchant_oid: oid, amount },
        })
        await save({ pending_alerted_at: now.toISOString() })
        summary.alerted++
      }
    } catch (err) {
      logger.warn(`[paytr-refund-tracking] return=${row.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return summary
}

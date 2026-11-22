/** Admin — olay kaydı ortak tipler ve etiketler (backend src/lib/ops-events.ts ile aynı türler). */

export type OpsEvent = {
  id: string
  kind: string
  level: "info" | "warning" | "error"
  title: string
  detail?: string | null
  order_id?: string | null
  order_display_id?: string | null
  data?: Record<string, unknown> | null
  created_at: string
}

export const OPS_KIND_LABEL: Record<string, string> = {
  "payment.succeeded": "Ödeme başarılı",
  "payment.failed": "Ödeme başarısız",
  "payment.alert": "Ödeme alarmı",
  "payment.pending": "Havale bekleniyor",
  "order.canceled_unpaid": "Ödenmeyen sipariş iptal",
  "order.canceled": "Sipariş iptal edildi",
  "shipment.created": "Kargo gönderisi açıldı",
  "shipment.failed": "Kargo gönderisi açılamadı",
  "shipment.attached": "Mevcut gönderi bağlandı",
  "shipment.shipped": "Kargoya verildi",
  "shipment.delivered": "Teslim edildi",
  "shipment.problem": "Kargo sorunu",
  "shipment.webhook": "Kargo bildirimi",
  "shipment.poll": "Kargo yoklaması",
  "shipment.audit": "Kargo denetimi",
  "carrier.health": "Kargo hesabı",
  "return.requested": "İade talebi alındı",
  "return.code_sent": "İade kodu gönderildi",
  "return.code_failed": "İade kodu alınamadı",
  "return.refund_failed": "İade parası gönderilemedi",
  "return.refunded": "İade yapıldı",
  "return.canceled": "İade iptal edildi",
  "exchange.requested": "Değişim talebi",
  "exchange.shipped": "Değişim gönderisi açıldı",
  "exchange.failed": "Değişim gönderisi açılamadı",
  "contract.failed": "Sözleşme PDF'i oluşturulamadı",
  "invoice.failed": "Fatura oluşturulamadı",
  "invoice.refund_manual": "İade faturası elle kesilecek",
}

export const OPS_LEVEL_BADGE: Record<OpsEvent["level"], { label: string; color: "green" | "orange" | "red" | "grey" }> = {
  info: { label: "Bilgi", color: "green" },
  warning: { label: "Uyarı", color: "orange" },
  error: { label: "Hata", color: "red" },
}

export function formatEventDate(value: string): string {
  return new Date(value).toLocaleString("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export async function fetchOpsEvents(params: Record<string, string | number | undefined>) {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v))
  const res = await fetch(`/admin/ops-events?${qs.toString()}`, { credentials: "include" })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<{ events: OpsEvent[]; count: number; limit: number; offset: number }>
}

export type EventGroup = { first: OpsEvent; title: string; count: number; orders: { id: string; label: string }[] }

/**
 * Başlıktaki sipariş no, tarih ve gün sayısı atılır: "15 gündür teslim edilmedi: #23 · 2026-11-22"
 * ile "10 gündür teslim edilmedi: #76 · 2026-11-22" aynı olaydır ("Teslim edilmedi").
 */
export function eventGroupTitle(title: string): string {
  const t = title
    .replace(/\s*·\s*\d{4}-\d{2}-\d{2}/g, "")
    .replace(/:?\s*#\d+/g, "")
    .replace(/^\d+ gündür /, "")
    .trim()
  return t ? t.charAt(0).toLocaleUpperCase("tr-TR") + t.slice(1) : title
}

/** Aynı olay (tür + seviye + başlık) tek satır: en yenisi gösterilir, siparişler yanında listelenir. */
export function groupEvents(events: OpsEvent[]): EventGroup[] {
  const groups = new Map<string, EventGroup>()
  for (const e of events) {
    const title = eventGroupTitle(e.title)
    const key = `${e.kind}|${e.level}|${title}`
    let g = groups.get(key)
    if (!g) {
      g = { first: e, title, count: 0, orders: [] }
      groups.set(key, g)
    }
    g.count++
    if (e.order_id && !g.orders.some((o) => o.id === e.order_id)) {
      g.orders.push({ id: e.order_id, label: `#${e.order_display_id || e.order_id.slice(-6)}` })
    }
  }
  return [...groups.values()]
}

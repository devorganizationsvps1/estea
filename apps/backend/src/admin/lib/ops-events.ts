/** Admin — olay kaydı ortak tipler ve etiketler (backend src/lib/ops-events.ts ile aynı türler). */

import { formatDateTime } from "./dates"

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
  "return.rejected": "İade reddedildi",
  "return.send_back": "Reddedilen ürün geri gönderimi",
  "return.send_back_failed": "Geri gönderim açılamadı",
  "return.send_back_returned": "Geri gönderilen paket bize döndü",
  "exchange.requested": "Değişim talebi",
  "exchange.shipped": "Değişim gönderisi açıldı",
  "exchange.failed": "Değişim gönderisi açılamadı",
  "contract.failed": "Sözleşme PDF'i oluşturulamadı",
  "invoice.failed": "Fatura oluşturulamadı",
  "invoice.refund_manual": "İade faturası elle kesilecek",
  "stock.sync": "Stok eşitleme",
  "mail.failed": "Mail gönderilemedi",
}

/** Olay başına tek cümle: personel ne yapmalı. Ham ayrıntı "Teknik ayrıntı" açılımında kalır. */
export const OPS_KIND_ACTION: Record<string, string> = {
  "payment.alert": "Müşteriden para çekildi ama sipariş düzgün oluşmadı. Teknik sorumluya haber verin; para PayTR panelinden iade edilir ya da sipariş elle açılır.",
  "shipment.failed": "Siparişi açın; sebep giderilince Gönderi aç düğmesine basın.",
  "shipment.problem": "Kargo firmasıyla görüşün; gecikme varsa müşteriye haber verin.",
  "return.code_failed": "İadeyi açıp kodu kargo firmasından alın ya da elle yazıp gönderin.",
  "return.refund_failed": "İadeyi açıp Para iadesini tekrar dene düğmesine basın. Yine olmazsa teknik sorumluya haber verin.",
  "return.send_back_failed": "İadeyi açın; hata orada yazar. Adres eksikse siparişten tamamlayıp Müşteriye geri gönder düğmesine yeniden basın.",
  "return.send_back_returned": "Müşteri paketi teslim almadı. 14 gün içinde yazarsa iadeyi açıp yeniden gönderin ya da onayıyla imha edin.",
  "exchange.failed": "Değişimi açın; hata orada yazar. İade teslim alınmadıysa önce teslim alın, sonra Yeni ürünü gönder düğmesine basın.",
  "invoice.failed": "Siparişin Fatura kartından yeniden gönderin.",
  "invoice.refund_manual": "İade faturasını Paraşüt'ten elle kesin.",
}

/** Kargo denetimi bulguları ayrı işler ister: başlıktaki bulgu türüne göre. */
const AUDIT_ACTIONS: [RegExp, string][] = [
  [/kargo kaydı yok/i, "Sipariş sayfasındaki Gönderi aç düğmesine basın."],
  [/kargoya verilmedi/i, "Paket hâlâ depodaysa kargoya verin. Verildiyse kargo firmasına sorun."],
  [/teslim edilmedi/i, "Kargo firmasını arayıp paketin nerede olduğunu sorun; gecikme varsa müşteriye haber verin."],
  [/iptal siparişte açık gönderi/i, "Kargo firmasında bu gönderiyi iptal edin."],
  [/aynı gönderi/i, "Teknik sorumluya haber verin."],
]

/** Bu olay için personelin yapacağı iş (yoksa null). Yalnız uyarı ve hatalarda. */
export function opsEventAction(e: Pick<OpsEvent, "kind" | "level" | "title">): string | null {
  if (e.level === "info") return null
  if (e.kind === "shipment.audit") return AUDIT_ACTIONS.find(([re]) => re.test(e.title))?.[1] ?? null
  return OPS_KIND_ACTION[e.kind] ?? null
}

const TL = new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" })

/**
 * Olay metinleri sunucuda düz yazılır ("1800.00 TL", "2026-11-22"); panelde tutar ve tarih
 * tek biçimde görünsün diye gösterirken çevrilir ("₺1.800,00", "22.11.2026").
 */
export function tidyEventText(text: string): string {
  return text
    .replace(/(\d+(?:\.\d{1,2})?) TL\b/g, (_, n: string) => TL.format(Number(n)))
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, "$3.$2.$1")
    .replace(/\s+·\s+(\d{2}\.\d{2}\.\d{4})/g, ", $1")
}

export const OPS_LEVEL_BADGE: Record<OpsEvent["level"], { label: string; color: "green" | "orange" | "red" | "grey" }> = {
  info: { label: "Bilgi", color: "green" },
  warning: { label: "Uyarı", color: "orange" },
  error: { label: "Hata", color: "red" },
}

export const formatEventDate = (value: string): string => formatDateTime(value)

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

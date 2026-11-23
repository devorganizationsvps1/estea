import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { useEffect } from "react"

/**
 * Medusa'nın çeviri dosyasından geçmeyen, koda gömülü İngilizce metinleri
 * Türkçeye çevirir (i18n/json/tr.json bunlara ulaşamaz):
 *   - kenar çubuğu "Drafts" (draft-order eklentisi)
 *   - sipariş ödeme satırı: "Captured/Pending/Canceled", ham sağlayıcı kimliği
 *   - gönderi sağlayıcısı "Manual"
 *   - "06 Nov, 2026, 23:48:38" gibi İngilizce ay adlı tarihler
 *   - "₺ 1.949,90 TRY" → "₺1.949,90" (panelde tek tutar biçimi, bkz. lib/money.ts)
 *   - Özet kartı: indirim yoksa indirim satırları gizlenir; eksi "Kalan tutar"
 *     (iade bekleyen sipariş) "Müşteriye iade edilecek" diye yazılır
 *   - Sipariş listesi: "Satış Kanalı" ve bayrak sütunu gizlenir (tek kanal, tek ülke)
 * Yalnız metnin tamamı eşleşirse değiştirir; görünür bir şey çizmez.
 */
const EXACT: Record<string, string> = {
  Drafts: "Taslak siparişler",
  // Sipariş listesindeki ödeme sütunuyla aynı sözcük (tr.json orders.payment.status.captured)
  Captured: "Alındı",
  Pending: "Bekliyor",
  Canceled: "İptal edildi",
  Manual: "Elle",
  Carrier: "Kargo firması",
  Turkey: "Türkiye",
  pp_paytr_paytr: "PayTR",
  pp_system_default: "Sistem",
  pp_havale_havale: "Havale",
}

const MONTHS: Record<string, string> = {
  Jan: "Oca", Feb: "Şub", Mar: "Mar", Apr: "Nis", May: "May", Jun: "Haz",
  Jul: "Tem", Aug: "Ağu", Sep: "Eyl", Oct: "Eki", Nov: "Kas", Dec: "Ara",
}
const EN_DATE = /^(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec), (\d{4})(.*)$/

const MONEY_WITH_CODE = /^₺\s?(-?[\d.,]+)\s?TRY$/

const leaf = (root: ParentNode, text: string) =>
  [...root.querySelectorAll<HTMLElement>("main p, main span")].filter(
    (e) => e.children.length === 0 && e.textContent?.trim() === text
  )

/** Sipariş Özet kartındaki kafa karıştıran satırlar. */
function tidySummary() {
  for (const label of leaf(document, "Kalan tutar")) {
    const value = label.parentElement?.lastElementChild as HTMLElement | null
    if (!value || value === label || !value.textContent?.includes("-")) continue
    label.textContent = "Müşteriye iade edilecek"
    const walker = document.createTreeWalker(value, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue?.includes("-")) n.nodeValue = n.nodeValue.replace("-", "")
    }
  }
  for (const label of leaf(document, "İndirim Toplamı")) {
    const row = label.closest<HTMLElement>("div.grid")
    const block = row?.parentElement
    const digits = (row?.lastElementChild?.textContent || "").replace(/\D/g, "")
    if (!row || !block || block.children.length > 2) continue
    block.style.display = /^0+$/.test(digits) ? "none" : ""
  }
}

/**
 * Sipariş listesi: tek satış kanalı ve tek ülke var, "Satış Kanalı" ile bayrak sütunu
 * bilgi taşımaz. Sütun numarası tabloya yazılır, gizleme CSS'te (escay-white-theme).
 */
function hideOrderListColumns() {
  for (const table of document.querySelectorAll<HTMLTableElement>("main table")) {
    const heads = [...table.querySelectorAll("thead th")]
    const channel = heads.findIndex((th) => th.textContent?.trim() === "Satış Kanalı")
    if (channel < 0) continue
    const hide = [channel + 1]
    // Bayrak sütunu: başlıksız son sütun (satır menüsü olan tablolarda dokunulmaz).
    const last = heads.length - 1
    if (!heads[last].textContent?.trim() && !table.querySelector("tbody td:last-child button")) hide.push(last + 1)
    const value = hide.join(" ")
    if (table.dataset.escayHide !== value) table.dataset.escayHide = value
  }
}

function translate(text: string): string | null {
  const trimmed = text.trim()
  if (EXACT[trimmed]) return text.replace(trimmed, EXACT[trimmed])
  const money = MONEY_WITH_CODE.exec(trimmed)
  if (money) return `₺${money[1]}`
  const m = EN_DATE.exec(trimmed)
  if (m) return `${m[1]} ${MONTHS[m[2]]} ${m[3]}${m[4]}`
  return null
}

function fix(root: Node) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const next = node.nodeValue ? translate(node.nodeValue) : null
    if (next != null && next !== node.nodeValue) node.nodeValue = next
  }
}

let observer: MutationObserver | null = null
let mounted = 0
let frame: number | null = null

function schedule() {
  if (frame !== null) return
  frame = window.requestAnimationFrame(() => {
    frame = null
    fix(document.body)
    tidySummary()
    hideOrderListColumns()
  })
}

const NativeTextTr = () => {
  useEffect(() => {
    mounted++
    if (!observer) {
      fix(document.body)
      tidySummary()
    hideOrderListColumns()
      observer = new MutationObserver(schedule)
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    }
    return () => {
      mounted--
      if (mounted === 0 && observer) {
        observer.disconnect()
        observer = null
      }
    }
  }, [])
  return null
}

export const config = defineWidgetConfig({
  zone: [
    "order.list.before",
    "order.details.before",
    "product.list.before",
    "product.details.before",
    "customer.list.before",
    "customer.details.before",
    "inventory_item.list.before",
    "inventory_item.details.before",
    "promotion.list.before",
    "price_list.list.before",
  ],
})

export default NativeTextTr

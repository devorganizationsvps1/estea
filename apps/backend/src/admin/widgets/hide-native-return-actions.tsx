import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { useEffect } from "react"

/**
 * Sipariş sayfasında Medusa'nın kendi iade / değişim / talep / düzenleme /
 * gönderi / para iadesi butonlarını gizler. Bunlar Es Çay akışını (PayTR,
 * Paraşüt, kargo, stok, mailler) atlar; işlemler sağdaki Es Çay kutularından
 * yapılır (İade, Değişim, Sipariş durumu, Kargo).
 *
 * Link butonları CSS ile (menüler portalda açıldığı için küresel stil); yalnız
 * tıklama işleyicisi olan "Ödeme al / Ödendi işaretle" menüsü başlıkla bulunup
 * gizlenir. Şeritte başka buton kalmazsa şerit de gizlenir.
 */
const HIDDEN_HREF = ["/returns", "/exchanges", "/claims", "/edits", "/fulfillment", "/refund", "/receive"]

const CSS = `
${HIDDEN_HREF.map((h) => `a[href*="/orders/"][href$="${h}"], a[href*="/orders/"][href*="${h}?"]`).join(",\n")} { display: none !important; }
div.rounded-b-xl.justify-end:has(> a[href$="/receive"], > a[href$="/refund"]):not(:has(> :not(a[href$="/receive"]):not(a[href$="/refund"]))) {
  display: none !important;
}
`

/** Başlığı verilen Medusa kartının sağ üst "…" menü düğmesi (Özet, Ödeme). */
const MENU_HEADINGS = ["Özet", "Summary", "Ödeme", "Payment", "Ödemeler", "Payments"]

/**
 * Medusa'nın "Gönderilmemiş ürünler" kartı Es Çay'ın Kargo kutusuyla aynı şeyi söyler
 * (ürünler Özet'te, gönderi durumu Kargo'da); iki kez görünmesin.
 */
const HIDDEN_CARD_HEADINGS = ["Gönderilmemiş ürünler", "Unfulfilled Items"]

function hideDuplicateCards() {
  for (const h of document.querySelectorAll<HTMLElement>("main h2")) {
    if (!HIDDEN_CARD_HEADINGS.includes(h.textContent?.trim() || "")) continue
    const card = h.closest<HTMLElement>(".shadow-elevation-card-rest")
    if (card) card.style.display = "none"
  }
}

/**
 * Medusa'nın "Gönderi #1" kartındaki "Gönderildi / Teslim edildi olarak işaretle" düğmeleri
 * Es Çay'ın onayından geçmez (müşteriye mail gider, teslimde fatura kesilir). Aynı iş
 * Sipariş durumu kartında, onayla yapılır. Karttaki "…" menüsünün tek işi yerel "İptal"dir;
 * o uç sunucuda kapalı (_native-block), menü de gizlenir.
 */
const NATIVE_MARK = /(olarak işaretle|^Mark as (shipped|delivered))/i

function hideNativeFulfillmentActions() {
  for (const h of document.querySelectorAll<HTMLElement>("main h2")) {
    if (!/^(Gönderi|Fulfillment) #/.test(h.textContent?.trim() || "")) continue
    const card = h.closest<HTMLElement>(".shadow-elevation-card-rest")
    if (!card) continue
    for (const menu of (h.parentElement || card).querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')) {
      menu.style.display = "none"
    }
    for (const btn of card.querySelectorAll<HTMLButtonElement>("button")) {
      if (!NATIVE_MARK.test(btn.textContent?.trim() || "")) continue
      btn.style.display = "none"
      // Şeritte başka görünen düğme kalmadıysa şerit de gizlenir.
      const strip = btn.parentElement
      if (strip && [...strip.children].every((c) => (c as HTMLElement).style.display === "none")) strip.style.display = "none"
    }
  }
}

function hideCardMenus() {
  for (const h of document.querySelectorAll<HTMLElement>("h2")) {
    if (!MENU_HEADINGS.includes(h.textContent?.trim() || "")) continue
    const header = h.parentElement
    if (!header) continue
    for (const btn of header.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')) {
      btn.style.display = "none"
    }
  }
}

const HideNativeReturnActions = () => {
  useEffect(() => {
    const run = () => {
      hideCardMenus()
      hideDuplicateCards()
      hideNativeFulfillmentActions()
    }
    run()
    const observer = new MutationObserver(run)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  return <style>{CSS}</style>
}

export const config = defineWidgetConfig({
  zone: "order.details.before",
})

export default HideNativeReturnActions

import { useEffect } from "react"

type Counts = { returns: number; orders: number; exchanges?: number }

/** Kenar çubuğu linki (href sonu) → sayaç alanı. */
const TARGETS: { suffix: string; key: keyof Counts; title: string }[] = [
  { suffix: "/iadeler", key: "returns", title: "Bekleyen / sorunlu iade" },
  { suffix: "/degisimler", key: "exchanges", title: "Açık değişim" },
  { suffix: "/orders", key: "orders", title: "Kargolanacak sipariş" },
]

const BADGE_CLASS = "escay-nav-badge"
const POLL_MS = 60_000

let counts: Counts | null = null
let timer: number | null = null
let observer: MutationObserver | null = null
let frame: number | null = null
let loading = false

function schedulePaint() {
  if (frame !== null) return
  frame = window.requestAnimationFrame(() => {
    frame = null
    // İlk sayılar: menü çizilir çizilmez (modül menüden önce yüklenir).
    if (!counts && !loading) void refresh()
    else paint()
  })
}

function paint() {
  if (!counts) return
  for (const t of TARGETS) {
    const links = document.querySelectorAll<HTMLAnchorElement>(`nav a[href$="${t.suffix}"]`)
    links.forEach((a) => {
      let badge = a.querySelector<HTMLSpanElement>(`.${BADGE_CLASS}`)
      const n = counts![t.key]
      if (!n) {
        badge?.remove()
        return
      }
      if (!badge) {
        badge = document.createElement("span")
        badge.className = BADGE_CLASS
        badge.style.cssText =
          // Beyaz yazı / #c62a2f: 5,6:1 (AA). 12 px, 20 px yükseklik.
          "margin-left:auto;min-width:20px;height:20px;padding:0 6px;border-radius:10px;" +
          "background:#c62a2f;color:#fff;font-size:12px;font-weight:600;" +
          "display:inline-flex;align-items:center;justify-content:center;line-height:1"
        a.appendChild(badge)
      }
      // Yalnız değişince yaz — aksi halde MutationObserver kendini tetikler.
      const text = n > 99 ? "99+" : String(n)
      if (badge.textContent !== text) badge.textContent = text
      const label = `${n} ${t.title.toLocaleLowerCase("tr-TR")}`
      if (badge.title !== t.title) badge.title = t.title
      if (badge.getAttribute("aria-label") !== label) badge.setAttribute("aria-label", label)
    })
  }
}

async function refresh() {
  // Giriş ekranında menü yok: istek atılmaz.
  if (loading || !document.querySelector("aside nav")) return
  loading = true
  try {
    const res = await fetch("/admin/escay-nav-counts", { credentials: "include" })
    if (!res.ok) return
    counts = (await res.json()) as Counts
    paint()
  } catch {
    // ağ hatası — bir sonraki turda tekrar
  } finally {
    // Başarısız istek her DOM değişiminde yinelenmesin: bir sonraki deneme zamanlayıcıda.
    window.setTimeout(() => { loading = false }, counts ? 0 : 5000)
  }
}

function start() {
  if (timer !== null) return
  void refresh()
  timer = window.setInterval(() => void refresh(), POLL_MS)
  // Menü yeniden çizilince (sayfa geçişi) rozet kaybolmasın.
  observer = new MutationObserver(() => schedulePaint())
  observer.observe(document.body, { childList: true, subtree: true })
}

// Widget modülleri panel açılışında statik yüklenir (bkz. escay-white-theme): rozetler
// belirli sayfalara bağlı kalmadan her sayfada çizilir (iade detayı, değişimler, varyant…).
if (typeof document !== "undefined") {
  if (document.body) start()
  else document.addEventListener("DOMContentLoaded", start, { once: true })
}

/**
 * Kenar çubuğunda "Siparişler", "İadeler" ve "Değişimler" yanında yapılacak iş sayısı.
 * Medusa menüsü genişletilemediği için sayılar DOM'a rozet olarak eklenir.
 * Sayfalar açılınca sayıyı hemen tazelemek için çağırır.
 */
export function useNavBadges() {
  useEffect(() => {
    start()
    void refresh()
  }, [])
}

export function NavBadges() {
  useNavBadges()
  return null
}

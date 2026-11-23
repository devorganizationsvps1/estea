import { defineWidgetConfig } from "@medusajs/admin-sdk"
// Font pakette gelir: personel IP'si Google'a gitmez, CSP/ağ engeli fontu düşürmez.
import "@fontsource/figtree/400.css"
import "@fontsource/figtree/500.css"
import "@fontsource/figtree/600.css"
import "@fontsource/figtree/700.css"
import { nextInVisualOrder } from "../lib/visual-order"

/**
 * Panelin küresel görünümü: aydınlık temada beyaz zemin, ince kenarlıklı kartlar.
 *
 * Tema seçimi (Profil menüsü → Tema: Sistem / Aydınlık / Karanlık) Medusa'nındır
 * ve korunur. Beyaz renkler yalnız aydınlık temada (`.dark` yokken) geçerlidir;
 * karanlıkta Medusa'nın kendi koyu değişkenleri çalışır. Hiç seçim yapılmamışsa
 * panel aydınlık açılır (Medusa varsayılanı "Sistem" koyu Mac'te koyu açardı).
 *
 * Widget modülleri admin açılışında statik yüklenir, bu yüzden tema çizilen
 * bölgeden bağımsız olarak her sayfada geçerlidir (bkz. stale-chunk-reload).
 *
 * Yazı tipi ve yerleşim düzeltmeleri iki temada da geçerlidir; Medusa'nın iç
 * sınıf zincirlerine dayanır, liste ve güncelleme testi: lib/theme-anchors.ts.
 */
const STYLE_ID = "escay-white-theme"
const THEME_KEY = "medusa_admin_theme"

const CSS = `
html:root:not(.dark) {
  color-scheme: light;

  --bg-base: #ffffff;
  --bg-base-hover: #f6f7f8;
  --bg-base-pressed: #eeeff1;
  --bg-subtle: #ffffff;
  --bg-subtle-hover: #f6f7f8;
  --bg-subtle-pressed: #eeeff1;
  --bg-component: #ffffff;
  --bg-component-hover: #f6f7f8;
  --bg-component-pressed: #eeeff1;
  --bg-field: #ffffff;
  --bg-field-hover: #f9fafa;
  --bg-field-component: #ffffff;
  --bg-field-component-hover: #f9fafa;
  --bg-highlight: #f1f4f9;
  --bg-highlight-hover: #e8edf5;
  --bg-interactive: #1d5fbf;
  --bg-disabled: #f3f4f5;
  --bg-overlay: rgba(31, 35, 40, 0.32);

  --fg-base: #1f2328;
  --fg-subtle: #5b6168;
  --fg-muted: #6b7077;
  --fg-disabled: #a4a8ae;
  --fg-interactive: #1d5fbf;
  --fg-interactive-hover: #174d9c;
  --fg-on-color: #ffffff;
  --fg-on-inverted: #ffffff;

  --border-base: #ececee;
  --border-strong: #dcdfe3;
  --border-transparent: rgba(255, 255, 255, 0);
  --border-menu-top: #ececee;
  --border-menu-bot: #ffffff;
  --border-interactive: #1d5fbf;

  --button-neutral: #ffffff;
  --button-neutral-hover: #f6f7f8;
  --button-neutral-pressed: #eeeff1;
  --button-inverted: #1f2328;
  --button-inverted-hover: #32373d;
  --button-inverted-pressed: #41474e;
  --button-transparent: rgba(255, 255, 255, 0);
  --button-transparent-hover: #f6f7f8;
  --button-transparent-pressed: #eeeff1;

  --elevation-card-rest: 0 0 0 1px #ececee;
  --elevation-card-hover: 0 0 0 1px #dcdfe3;
  --borders-base: 0 0 0 1px #dcdfe3;
  --buttons-neutral: 0 0 0 1px #dcdfe3;
  --buttons-inverted: 0 0 0 1px #1f2328;
}

html:not(.dark), html:not(.dark) body { background: #ffffff; }

/* Medusa bileşenleri (tablo hücresi, düğme, giriş) kendi Inter kuralını taşır; panel tek
   yazı tipiyle çizilsin diye hepsi kapsanır. Kod / takip no gibi font-mono alanlar hariç. */
html .font-sans, html body,
html :is(td, th, button, input, select, textarea, summary, p, span, label, a, div):not(.font-mono):not(.font-mono *) {
  font-family: Figtree, Inter, ui-sans-serif, system-ui, sans-serif;
}

/* Telefonda düğmeler parmakla basılacak yükseklikte (Medusa küçük düğmesi 28 px). */
@media (max-width: 640px) {
  html main button.txt-compact-small-plus { min-height: 40px; }
}

/* 13 px uzun oturumda yorar. */
html .txt-compact-small, html .txt-compact-small-plus, html .txt-small, html .txt-small-plus {
  font-size: 0.875rem;
  line-height: 1.25rem;
}

html td, html th { font-variant-numeric: tabular-nums; }

/* Düğmeler dar sütunlarda alt satıra kaymasın. */
html button.txt-compact-small-plus, html a.txt-compact-small-plus[class*="shadow-buttons"] {
  font-size: 0.8125rem;
}

/* Sipariş satırı: adet + durum etiketi sütunu tutara yapışmasın. */
html main .grid-cols-2.items-center.px-6 > .grid-cols-3.items-center.gap-x-4 {
  grid-template-columns: minmax(0, 1fr) 150px minmax(0, 1fr);
  column-gap: 12px;
}

/* Kartlar */
html .shadow-elevation-card-rest.rounded-lg { border-radius: 14px; }

/* Sayfa kenar boşlukları */
html main > .max-w-\\[1600px\\] {
  padding: 24px;
  row-gap: 16px;
}
@media (max-width: 640px) {
  html main > .max-w-\\[1600px\\] { padding: 16px; }
}

/* Kenar çubuğu: etkin satır nötr gri, satırlar rahat aralıklı */
html aside a {
  padding-top: 6px;
  padding-bottom: 6px;
}
html aside a.shadow-elevation-card-rest,
html aside a.shadow-elevation-card-rest:hover {
  background: var(--bg-base-pressed);
  box-shadow: none;
}
/* Eklenti sayfalarının ikonlarındaki kutu, Medusa'nın kendi ikonlarıyla aynı görünsün. */
html aside a .shadow-borders-base {
  background: transparent;
  box-shadow: none;
}

/* Menü sırası: günlük işler üstte (sipariş, iade, değişim, ürün, stok, müşteri, satış),
   seyrek kullanılan araçlar ince bir çizginin altında. Medusa menüsü tek flex sütunu. */
html aside nav .flex.flex-col.gap-y-1 > div:has(> div > a[href$="/orders"]) { order: 1; }
html aside nav .flex.flex-col.gap-y-1 > div:has(> div > a[href$="/iadeler"]) { order: 2; }
html aside nav .flex.flex-col.gap-y-1 > div:has(> div > a[href$="/degisimler"]) { order: 3; }
html aside nav .flex.flex-col.gap-y-1 > div:has(> div > a[href$="/products"]) { order: 4; }
html aside nav .flex.flex-col.gap-y-1 > div:has(> div > a[href$="/inventory"]) { order: 5; }
html aside nav .flex.flex-col.gap-y-1 > div:has(> div > a[href$="/customers"]) { order: 6; }
html aside nav .flex.flex-col.gap-y-1 > div:has(> div > a[href$="/sales-stats"]) { order: 7; }
html aside nav .flex.flex-col.gap-y-1 > div:has(> div > a[href$="/promotions"]) { order: 8; }
html aside nav .flex.flex-col.gap-y-1 > div:has(> div > a[href$="/price-lists"]) { order: 9; }
html aside nav .flex.flex-col.gap-y-1 > div:has(> div > a[href$="/ops-events"]) { order: 10; }
html aside nav .flex.flex-col.gap-y-1 > div:has(> div > a[href$="/kargo-uzlastirma"]) { order: 11; }
html aside nav .flex.flex-col.gap-y-1 > div:has(> div > a[href$="/promotions"]) {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border-base);
}

/* Liste sütunu gizleme: widgets/native-text-tr.tsx tabloya data-escay-hide="4 8" yazar. */
html table[data-escay-hide~="1"] :is(th, td):nth-child(1) { display: none; }
html table[data-escay-hide~="2"] :is(th, td):nth-child(2) { display: none; }
html table[data-escay-hide~="3"] :is(th, td):nth-child(3) { display: none; }
html table[data-escay-hide~="4"] :is(th, td):nth-child(4) { display: none; }
html table[data-escay-hide~="5"] :is(th, td):nth-child(5) { display: none; }
html table[data-escay-hide~="6"] :is(th, td):nth-child(6) { display: none; }
html table[data-escay-hide~="7"] :is(th, td):nth-child(7) { display: none; }
html table[data-escay-hide~="8"] :is(th, td):nth-child(8) { display: none; }
html table[data-escay-hide~="9"] :is(th, td):nth-child(9) { display: none; }
html table[data-escay-hide~="10"] :is(th, td):nth-child(10) { display: none; }

/* Sayı sütunları ve tutarlar aynı hizada */
html .tabular-nums { font-variant-numeric: tabular-nums; }

/* Seçim ve klavye odağı panelin mavisinden */
html:not(.dark) ::selection { background: #d6e4f7; color: #1f2328; }
html aside a:focus-visible { outline: 2px solid var(--fg-interactive); outline-offset: -2px; }

/* Giriş ekranı: Medusa logosu yerine Es Çay harfi (metin i18n/json/tr.json login.title). */
html .max-w-\\[280px\\] > .h-\\[50px\\].w-\\[50px\\] > * { display: none; }
html .max-w-\\[280px\\] > .h-\\[50px\\].w-\\[50px\\]::before {
  content: "E";
  font-size: 22px;
  font-weight: 700;
  color: var(--fg-base);
}

/* Mobil: sipariş Özet satırı (ürün | fiyat-adet | tutar) dar ekranda üst üste binmesin. */
@media (max-width: 640px) {
  html main .grid-cols-2.items-center.px-6:has(> .grid-cols-3.items-center.gap-x-4) {
    grid-template-columns: minmax(0, 1fr);
    row-gap: 8px;
  }
  html main .grid-cols-2.items-center.px-6 > .grid-cols-3.items-center.gap-x-4 {
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  }
}
`

if (typeof document !== "undefined") {
  try {
    // ThemeProvider ilk çizimde okur; modül ondan önce yüklenir. Yalnız seçim
    // hiç yapılmamışsa yazılır — kullanıcının seçimi ezilmez.
    if (!localStorage.getItem(THEME_KEY)) localStorage.setItem(THEME_KEY, "light")
  } catch {
    // Depolama kapalı: Medusa "Sistem"e düşer.
  }

  const style =
    (document.getElementById(STYLE_ID) as HTMLStyleElement | null) ??
    document.head.appendChild(Object.assign(document.createElement("style"), { id: STYLE_ID }))
  style.textContent = CSS
}

if (typeof document !== "undefined") {
  // Sekme başlığı: "Siparişler - Medusa" → "Siparişler - Es Çay".
  const fixTitle = () => {
    if (document.title.endsWith(" - Medusa")) document.title = document.title.replace(/ - Medusa$/, " - Es Çay")
    else if (document.title === "Medusa") document.title = "Es Çay"
  }
  fixTitle()
  new MutationObserver(fixTitle).observe(document.head, { childList: true, subtree: true, characterData: true })

  // Menü sırası CSS `order` ile verildiği için Tab, DOM sırasıyla (eski sıra) gezerdi.
  // Menü içinde Tab / Shift+Tab görünen sırayla ilerler; uçlarda menünün dışına çıkar.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return
    const current = document.activeElement as HTMLElement | null
    const column = current?.closest<HTMLElement>("aside nav .flex.flex-col.gap-y-1")
    if (!current || !column) return
    const next = nextInVisualOrder(
      [...column.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")]
        .filter((el) => el.offsetParent !== null)
        .map((el) => ({ el, top: el.getBoundingClientRect().top })),
      current,
      e.shiftKey ? -1 : 1
    )
    if (next) {
      e.preventDefault()
      next.focus()
      return
    }
    // Uçta: menü sütununun DOM'daki ilk / son öğesinden tarayıcının kendi sırasına bırak.
    const all = [...document.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
      (el) => el.offsetParent !== null
    )
    const inside = all.filter((el) => column.contains(el))
    const edge = all.indexOf(e.shiftKey ? inside[0] : inside[inside.length - 1])
    const target = all[edge + (e.shiftKey ? -1 : 1)]
    if (target) {
      e.preventDefault()
      target.focus()
    }
  })
}

const EscayWhiteTheme = () => null

export const config = defineWidgetConfig({
  zone: "login.before",
})

export default EscayWhiteTheme

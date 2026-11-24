// Figtree repoda (src/fonts), build Google Fonts'a bağlı değil. Dosyalar Fontsource'tan
// (@fontsource-variable/figtree 5.3, OFL-1.1) kopyalandı; aile adı globals.css'teki
// --font-figtree ile aynı. Üç yüz unicode-range ile ayrılır:
//   latin      Temel Latin + ç ö ü ı (20 KB), her sayfada → preload
//   tr         Ğ ğ İ Ş ş (2 KB), her sayfada → preload
//   latin-ext  Latin Extended'ın kalanı (10 KB), Türkçe metinde hiç inmez
// `tr` dosyası latin-ext'ten üretildi:
//   pyftsubset figtree-latin-ext-wght-normal.woff2 --unicodes="U+011E,U+011F,U+0130,U+015E,U+015F" \
//     --layout-features='*' --flavor=woff2 --output-file=figtree-tr-wght-normal.woff2
// next/font: hash'li ad (bir yıl önbellek), <head>'de preload, font inene dek ölçüleri
// eşlenmiş Arial ("Figtree Variable Fallback").
// next/font yalnız düz yazılmış değer kabul eder; aralıklar bu yüzden her çağrıda açık.
import localFont from "next/font/local"

export const figtree = localFont({
  src: "../fonts/figtree-latin-wght-normal.woff2",
  weight: "300 900",
  display: "swap",
  declarations: [
    { prop: "font-family", value: "'Figtree Variable'" },
    { prop: "unicode-range", value: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD" },
  ],
})
export const figtreeTr = localFont({
  src: "../fonts/figtree-tr-wght-normal.woff2",
  weight: "300 900",
  display: "swap",
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "'Figtree Variable'" },
    { prop: "unicode-range", value: "U+011E-011F,U+0130,U+015E-015F" },
  ],
})
export const figtreeExt = localFont({
  src: "../fonts/figtree-latin-ext-wght-normal.woff2",
  weight: "300 900",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "'Figtree Variable'" },
    { prop: "unicode-range", value: "U+0100-011D,U+0120-012F,U+0132-015D,U+0160-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF" },
  ],
})

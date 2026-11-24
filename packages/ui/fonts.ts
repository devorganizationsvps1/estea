// Fontlar repoda (packages/ui/fonts), build Google Fonts'a bağlı değil. Dosyalar
// Fontsource paketlerinden (@fontsource-variable/archivo, .../bricolage-grotesque)
// kopyalandı; aile adları theme.css'teki --font-archivo / --font-bricolage ile aynı.
//
// Her aile üç yüz, unicode-range ile ayrılır; tarayıcı yalnız sayfadaki
// karakterlerin dosyasını indirir:
//   latin      Temel Latin + ç ö ü ı (35-41 KB), her sayfada → preload
//   tr         Ğ ğ İ Ş ş (3 KB), her sayfada → preload
//   latin-ext  Latin Extended'ın kalanı (19-32 KB), Türkçe metinde hiç inmez
// Fontsource'un latin-ext dosyası tek başına kullanılsaydı beş Türkçe harf için
// her ziyarette 50 KB fazladan inerdi. `tr` dosyaları ondan üretildi:
//   pyftsubset <aile>-latin-ext-wght-normal.woff2 --unicodes="U+011E,U+011F,U+0130,U+015E,U+015F" \
//     --layout-features='*' --flavor=woff2 --output-file=<aile>-tr-wght-normal.woff2
//
// next/font: dosyalar hash'li adla bir yıl önbelleklenir, preload'lar <head>'e
// kendiliğinden girer, font inene dek ölçüleri eşlenmiş Arial ("... Fallback")
// görünür (yazı yer değiştirmez).
import localFont from 'next/font/local'

// next/font yalnız düz yazılmış değer kabul eder (sabit ya da fonksiyon olmaz); aralıklar
// bu yüzden her çağrıda açık. latin-ext aralığı Fontsource'unki, `tr`deki beş harf çıkarılmış.
export const archivo = localFont({
  src: './fonts/archivo-latin-wght-normal.woff2',
  weight: '100 900',
  display: 'swap',
  declarations: [
    { prop: 'font-family', value: "'Archivo Variable'" },
    { prop: 'unicode-range', value: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' },
  ],
})
export const archivoTr = localFont({
  src: './fonts/archivo-tr-wght-normal.woff2',
  weight: '100 900',
  display: 'swap',
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: "'Archivo Variable'" },
    { prop: 'unicode-range', value: 'U+011E-011F,U+0130,U+015E-015F' },
  ],
})
export const archivoExt = localFont({
  src: './fonts/archivo-latin-ext-wght-normal.woff2',
  weight: '100 900',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: "'Archivo Variable'" },
    { prop: 'unicode-range', value: 'U+0100-011D,U+0120-012F,U+0132-015D,U+0160-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF' },
  ],
})

export const bricolage = localFont({
  src: './fonts/bricolage-grotesque-latin-wght-normal.woff2',
  weight: '200 800',
  display: 'swap',
  declarations: [
    { prop: 'font-family', value: "'Bricolage Grotesque Variable'" },
    { prop: 'unicode-range', value: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' },
  ],
})
export const bricolageTr = localFont({
  src: './fonts/bricolage-grotesque-tr-wght-normal.woff2',
  weight: '200 800',
  display: 'swap',
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: "'Bricolage Grotesque Variable'" },
    { prop: 'unicode-range', value: 'U+011E-011F,U+0130,U+015E-015F' },
  ],
})
export const bricolageExt = localFont({
  src: './fonts/bricolage-grotesque-latin-ext-wght-normal.woff2',
  weight: '200 800',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: "'Bricolage Grotesque Variable'" },
    { prop: 'unicode-range', value: 'U+0100-011D,U+0120-012F,U+0132-015D,U+0160-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF' },
  ],
})

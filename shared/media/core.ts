/**
 * Es Çay görsel hattı: çalışma zamanı tarafı (landing + mağaza ortak).
 *
 * `build-media.mjs` build'den önce public/ altındaki her fotoğrafı sabit
 * genişlik basamaklarında AVIF + WebP olarak public/_m/ içine üretir, adına
 * içerik hash'i koyar ve src/generated/media.json'a yazar. Bu dosya o
 * manifestten <picture> kaynaklarını kurar. Sunucu istek anında hiçbir şey
 * sıkıştırmaz; dosyalar bir yıl `immutable` önbelleklenir, içerik değişince
 * adı da değişir. Biçimi tarayıcı seçer (<source type>), bu yüzden önüne
 * konacak bir CDN `Vary: Accept`'e ihtiyaç duymaz.
 *
 * Saf TS: React/Next içe aktarmaz, iki uygulama farklı Next sürümünde.
 */

/** [hash, genişlik, yükseklik, baskın renk (#rrggbb), saydamlık 1/0] */
export type MediaEntry = readonly [string, number, number, string, number]

export type MediaManifest = {
  v: 1
  /** Çıktı klasörünün URL'i (public/_m → /_m). */
  base: string
  /** Genişlik basamakları; kaynaktan büyükleri üretilmez. */
  widths: number[]
  images: Record<string, MediaEntry>
  /** Hash'li kopyası çıkarılan diğer dosyalar (video). */
  files: Record<string, string>
}

export type MediaImage = {
  /** <img src> yedeği (WebP, ~1280 px). */
  src: string
  width: number
  height: number
  /** Yüklenene dek zemin rengi; saydam görselde null. */
  color: string | null
  avif: string
  webp: string
}

export type PictureSource = {
  type: 'image/avif' | 'image/webp'
  srcSet: string
  sizes?: string
  media?: string
}

/** build-media.mjs ile aynı kural; ikisi birlikte değişmeli. */
export function widthsFor(ladder: readonly number[], width: number): number[] {
  const top = Math.min(width, ladder[ladder.length - 1])
  return [...ladder.filter((w) => w < top), top]
}

function key(src: string) {
  const path = src.split(/[?#]/)[0]
  try {
    return decodeURI(path)
  } catch {
    return path
  }
}

/** Manifestte olmayan (uzak, yeni eklenmiş) görselde null; çağıran next/image'a düşer. */
export function lookupImage(manifest: MediaManifest, src: string | null | undefined): MediaImage | null {
  if (!src || !src.startsWith('/') || src.startsWith('//')) return null
  const entry = manifest.images[key(src)]
  if (!entry) return null
  const [hash, width, height, color, alpha] = entry
  const widths = widthsFor(manifest.widths, width)
  const set = (ext: string) => widths.map((w) => `${manifest.base}/${hash}-${w}.${ext} ${w}w`).join(', ')
  const fallback = widths.find((w) => w >= 1280) ?? widths[widths.length - 1]
  return {
    src: `${manifest.base}/${hash}-${fallback}.webp`,
    width,
    height,
    color: alpha ? null : color,
    avif: set('avif'),
    webp: set('webp'),
  }
}

/** AVIF önce: destekleyen tarayıcı onu, diğeri WebP'yi alır. */
export function pictureSources(image: MediaImage, sizes: string, media?: string): PictureSource[] {
  return [
    { type: 'image/avif', srcSet: image.avif, sizes, media },
    { type: 'image/webp', srcSet: image.webp, sizes, media },
  ]
}

/** Video gibi hash'li kopyası olan dosyanın adresi; yoksa olduğu gibi. */
export function mediaFile(manifest: MediaManifest, src: string): string {
  return manifest.files[key(src)] ?? src
}

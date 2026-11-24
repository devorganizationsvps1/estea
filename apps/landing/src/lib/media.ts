import { preload } from 'react-dom'
import manifest from '@/generated/media.json'
import {
  lookupImage,
  mediaFile as fileFrom,
  type MediaImage,
  type MediaManifest,
  type PictureSource,
} from '@escay/shared/media/core'

export { pictureSources, type MediaImage, type PictureSource } from '@escay/shared/media/core'

const media = manifest as unknown as MediaManifest

/** public/ altındaki görselin önceden üretilmiş AVIF/WebP basamakları; yoksa null. */
export const mediaImage = (src: string | null | undefined): MediaImage | null => lookupImage(media, src)

/** Video vb. dosyanın hash'li (bir yıl önbelleklenen) adresi. */
export const mediaFile = (src: string) => fileFrom(media, src)

/**
 * Ekranın ilk karesindeki görseli HTML ayrıştırılırken indirmeye başlatır.
 * Yalnız AVIF: `type` desteklemeyen tarayıcıda preload atlanır, <picture>
 * WebP'yi yine kendisi seçer; böylece çift indirme olmaz.
 */
export function preloadSources(sources: PictureSource[]) {
  for (const s of sources) {
    if (s.type !== 'image/avif') continue
    const first = s.srcSet.split(' ')[0]
    preload(first, { as: 'image', type: s.type, imageSrcSet: s.srcSet, imageSizes: s.sizes, media: s.media, fetchPriority: 'high' })
  }
}

type SizeEntry = { condition: string; length: string }

/** `sizes` listesini girdilere ayırır; calc()/min() içindeki virgül ve boşluklar bölmez. */
function parseSizes(sizes: string): SizeEntry[] {
  const entries: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < sizes.length; i++) {
    const ch = sizes[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      entries.push(sizes.slice(start, i))
      start = i + 1
    }
  }
  entries.push(sizes.slice(start))
  return entries
    .map((e) => e.trim())
    .filter(Boolean)
    .map((entry) => {
      // Uzunluk, parantez dışındaki son boşluktan sonraki parçadır; öncesi medya koşulu.
      let d = 0
      for (let i = entry.length - 1; i >= 0; i--) {
        const ch = entry[i]
        if (ch === ')') d++
        else if (ch === '(') d--
        else if (ch === ' ' && d === 0) return { condition: entry.slice(0, i).trim(), length: entry.slice(i + 1) }
      }
      return { condition: '', length: entry }
    })
}

const scaled = (length: string, factor: number) => `calc(${length} * ${Number(factor.toFixed(3))})`

/**
 * `sizes` listesindeki her genişliği `factor` ile çarpar (ör. bir satırı üç kareye
 * bölen küçük resimler için 1/3). `calc(<liste> / 3)` geçersizdir: tarayıcı listeyi
 * çözemez, 100vw varsayar ve üç kat büyük dosya indirir.
 */
export function scaleSizes(sizes: string, factor: number): string {
  return parseSizes(sizes)
    .map(({ condition, length }) => `${condition ? `${condition} ` : ''}${scaled(length, factor)}`)
    .join(', ')
}

/** Listenin koşulsuz (en dar ekran) girdisi. */
export function defaultSize(sizes: string): string {
  const entries = parseSizes(sizes)
  return (entries.find((e) => !e.condition) ?? entries[entries.length - 1]).length
}

/** 3x ekranda fotoğraf ~2,2x yoğunlukta seçilir. */
const DENSE = '(min-resolution: 3dppx)'
const DENSE_FACTOR = 0.72

/**
 * Fotoğraflar için: 3x telefon ekranında (iPhone, çoğu Android amiral gemisi) tarayıcı
 * tam yoğunlukta dosya ister; 390 px'lik ekranda 1280 px'lik, 430'da 1600 px'lik kare.
 * Fotoğrafta 2x üstü gözle ayırt edilmez, dosya ise %35-55 büyür. Bu yüzden 3x ekrana
 * genişlik %72 bildirilir; bir alt basamak (çoğunlukla 960 px) seçilir. Logo ve paket
 * gibi keskin kenarlı saydam görsellere uygulanmaz. `min-resolution`ı sizes içinde
 * tanımayan tarayıcı koşulu atlar, özgün listeyi kullanır.
 */
export function photoSizes(sizes: string): string {
  const dense = parseSizes(sizes)
    // 3x ekranlar telefondur; 1000 px ve üstü koşullar onlarda hiç tutmaz, yazılmaz.
    .filter(({ condition }) => !/min-width:\s*\d{4,}px/.test(condition))
    .map(({ condition, length }) => `${condition ? `${DENSE} and ${condition}` : DENSE} ${scaled(length, DENSE_FACTOR)}`)
    .join(', ')
  return `${dense}, ${sizes}`
}

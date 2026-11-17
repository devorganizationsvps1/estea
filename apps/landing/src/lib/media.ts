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

import { preload } from "react-dom"
import manifest from "@/generated/media.json"
import { lookupImage, type MediaImage, type MediaManifest, type PictureSource } from "@escay/shared/media/core"

export { pictureSources, type MediaImage, type PictureSource } from "@escay/shared/media/core"

const media = manifest as unknown as MediaManifest

/** public/ altındaki görselin build'de üretilmiş AVIF/WebP basamakları; yoksa null. */
export const mediaImage = (src: string | null | undefined): MediaImage | null => lookupImage(media, src)

/**
 * İlk ekrandaki görseli HTML ayrıştırılırken indirmeye başlatır. Yalnız AVIF:
 * desteklemeyen tarayıcı `type` yüzünden atlar, <picture> WebP'yi seçer.
 */
export function preloadSources(sources: PictureSource[]) {
  for (const s of sources) {
    if (s.type !== "image/avif") continue
    preload(s.srcSet.split(" ")[0], {
      as: "image",
      type: s.type,
      imageSrcSet: s.srcSet,
      imageSizes: s.sizes,
      media: s.media,
      fetchPriority: "high",
    })
  }
}

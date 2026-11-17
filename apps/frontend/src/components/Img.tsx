import type { CSSProperties, Ref } from "react"
import NextImage, { type ImageProps } from "next/image"
import { mediaImage, pictureSources, preloadSources } from "@/lib/media"

type Props = Omit<ImageProps, "src" | "loader" | "placeholder" | "blurDataURL" | "unoptimized"> & {
  src: string
  ref?: Ref<HTMLImageElement>
}

const FILL: CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%" }

/**
 * next/image yerine (yerel görseller için): public/ görselleri build'de
 * üretilmiş AVIF/WebP basamaklarından <picture> ile gelir; sunucu istek
 * anında sıkıştırmaz, dosyalar bir yıl önbelleklenir. Manifestte olmayan
 * görsel next/image'a düşer. Ürün görselleri (Medusa) için `optimizedImg`.
 */
export default function Img(props: Props) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- quality: dosyalar build'de sabit kalitede
  const { src, alt, fill, width, height, sizes, priority, quality: _q, loading, fetchPriority, className, style, ...rest } = props
  const image = mediaImage(src)
  if (!image) return <NextImage {...props} />

  const sources = pictureSources(image, sizes ?? (fill ? "100vw" : `${width ?? image.width}px`))
  if (priority) preloadSources(sources)
  const tint = image.color && !className?.includes("object-contain") ? image.color : undefined
  const w = fill ? undefined : (width ?? image.width)
  const h = fill ? undefined : (height ?? (w ? Math.round((Number(w) * image.height) / image.width) : image.height))

  return (
    <picture style={{ display: "contents" }}>
      {sources.map((s) => (
        <source key={s.type} type={s.type} srcSet={s.srcSet} sizes={s.sizes} />
      ))}
      <img
        {...rest}
        alt={alt}
        src={image.src}
        width={w}
        height={h}
        decoding="async"
        loading={priority ? "eager" : (loading ?? "lazy")}
        fetchPriority={priority ? "high" : fetchPriority}
        className={className}
        style={{ ...(fill ? FILL : null), ...(tint ? { backgroundColor: tint } : null), ...style }}
      />
    </picture>
  )
}

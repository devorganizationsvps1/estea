import type { CSSProperties, Ref } from 'react'
import NextImage, { type ImageProps } from 'next/image'
import { mediaImage, pictureSources, preloadSources } from '@/lib/media'

type Props = Omit<ImageProps, 'src' | 'loader' | 'placeholder' | 'blurDataURL' | 'unoptimized'> & { src: string; ref?: Ref<HTMLImageElement> }

const FILL: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' }

/**
 * next/image yerine: public/ görselleri build'de üretilmiş AVIF/WebP
 * basamaklarından <picture> ile gelir; sunucu istek anında sıkıştırmaz,
 * dosyalar bir yıl önbelleklenir. Manifestte olmayan görsel (yeni eklenip
 * build edilmemiş, uzak adres) next/image'a düşer, hiçbir şey kırılmaz.
 *
 * Görsel inene dek kutu baskın renkle dolar (saydam ve object-contain
 * görsellerde boş kalır; yoksa paketin çevresi renklenirdi).
 */
export default function Img(props: Props) {
  const { src, alt, fill, width, height, sizes, priority, preload, quality: _q, loading, fetchPriority, className, style, ...rest } = props
  const image = mediaImage(src)
  if (!image) return <NextImage {...props} />

  const eager = Boolean(priority || preload)
  const sources = pictureSources(image, sizes ?? (fill ? '100vw' : `${width ?? image.width}px`))
  if (eager) preloadSources(sources)
  const tint = image.color && !className?.includes('object-contain') ? image.color : undefined
  const w = fill ? undefined : (width ?? image.width)
  const h = fill ? undefined : (height ?? (w ? Math.round((Number(w) * image.height) / image.width) : image.height))

  return (
    <picture style={{ display: 'contents' }}>
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
        loading={eager ? 'eager' : (loading ?? 'lazy')}
        fetchPriority={eager ? 'high' : fetchPriority}
        className={className}
        style={{ ...(fill ? FILL : null), ...(tint ? { backgroundColor: tint } : null), ...style }}
      />
    </picture>
  )
}

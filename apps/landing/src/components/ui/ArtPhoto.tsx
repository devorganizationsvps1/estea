import type { CSSProperties } from 'react'
import { getImageProps } from 'next/image'
import { mediaImage, pictureSources, preloadSources } from '@/lib/media'

export type ArtSource = { src: string; alt?: string; /** Telefon kırpımı (fotoğraf brief'i mobil kareleri, 400×390). */ mobile?: string; focus?: string }

/** Çoğu kare telefonda tam genişlik, masaüstünde ızgaranın yarısı kadar. */
const DEFAULT_SIZES = '(max-width: 1023px) 100vw, 50vw'
const MOBILE_MQ = '(max-width: 639px)'

/**
 * Fotoğraf brief'inin iki kırpımı tek karede: telefonda (640 px altı) kare
 * mobil kırpım, üstünde masaüstü karesi. Çerçeveyi veren kapsayıcı
 * `relative` olmalı; bu bileşen onu doldurur. Mobil kırpım yoksa yalnız
 * masaüstü karesi kullanılır. Kareler build'de üretilmiş AVIF/WebP
 * basamaklarından gelir (bkz. Img); manifestte yoksa Next optimizer'ı.
 */
export default function ArtPhoto({
  photo,
  alt = photo.alt ?? '',
  priority = false,
  sizes = DEFAULT_SIZES,
  mobileSizes = '100vw',
  className = '',
}: {
  photo: ArtSource
  alt?: string
  priority?: boolean
  /** Karenin ekrandaki genişliği; srcset'ten doğru boy seçilsin. */
  sizes?: string
  /** Telefondaki (640 px altı) genişlik; mobil kırpım için ayrı srcset seçilir. */
  mobileSizes?: string
  className?: string
}) {
  const style: CSSProperties = photo.focus ? { objectPosition: photo.focus } : {}
  const imgClass = `absolute inset-0 h-full w-full object-cover ${className}`
  const desktop = mediaImage(photo.src)
  const mobile = photo.mobile ? mediaImage(photo.mobile) : null

  if (desktop && (mobile || !photo.mobile)) {
    const sources = [
      ...(mobile ? pictureSources(mobile, mobileSizes, MOBILE_MQ) : []),
      ...pictureSources(desktop, sizes),
    ]
    if (priority) preloadSources(mobile ? [...sources.slice(0, 2), ...sources.slice(2).map((s) => ({ ...s, media: '(min-width: 640px)' }))] : sources)
    return (
      <picture>
        {sources.map((s) => (
          <source key={`${s.media ?? ''}${s.type}`} type={s.type} media={s.media} srcSet={s.srcSet} sizes={s.sizes} />
        ))}
        <img
          alt={alt}
          src={desktop.src}
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : 'auto'}
          decoding="async"
          style={desktop.color ? { backgroundColor: (mobile ?? desktop).color ?? undefined, ...style } : style}
          className={imgClass}
        />
      </picture>
    )
  }

  // Manifestte olmayan kare (yeni eklenmiş, build edilmemiş): Next optimizer'ı.
  const common = { alt, fill: true, sizes } as const
  const {
    props: { srcSet: desktopSet, style: _style, ...img },
  } = getImageProps({ ...common, src: photo.src })
  const mobileSet = photo.mobile
    ? getImageProps({ ...common, src: photo.mobile, sizes: mobileSizes }).props.srcSet
    : undefined
  return (
    <picture>
      {mobileSet ? <source media={MOBILE_MQ} srcSet={mobileSet} sizes={mobileSizes} /> : null}
      <img
        {...img}
        srcSet={desktopSet}
        loading={priority ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : 'auto'}
        decoding="async"
        style={photo.focus ? style : undefined}
        className={imgClass}
      />
    </picture>
  )
}

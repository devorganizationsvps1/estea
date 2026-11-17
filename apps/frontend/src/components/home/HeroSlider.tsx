"use client"

import { getImageProps } from "next/image"
import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"
import { mediaImage, pictureSources, preloadSources } from "@/lib/media"

export type HeroSlide = {
  /** Masaüstü bannerı, 16:9 (2560×1440). */
  image: string
  /** Telefon bannerı, 2:3 (1440×2160); 720px ve altında bu gösterilir. */
  mobileImage?: string
  alt: string
  /** Fotoğrafın kadrajı (object-position); dar ekranda özne ortada kalsın. */
  focus?: string
  title: string
  lead: string
  /** `info`: satın alma olmayan hedef (ör. Hakkımızda) — kırmızı yalnız satın almaya ayrılır. */
  cta: { label: string; href: string; info?: boolean }
  /** Slayt sekmesindeki kısa ad. */
  tab: string
  /**
   * Masaüstünde metnin görseldeki boş alana oturduğu yer (mobilde hep altta).
   * left: solda ortada · top: üstte ortada · top-right: sağ üstte.
   */
  place?: "left" | "top" | "top-right"
  /** Telefonda metnin yeri: mobil görselin boş kalan üst ya da alt bandı. */
  mobilePlace?: "top" | "bottom"
}

const INTERVAL_MS = 6500
const SWIPE_PX = 48

export function HeroSlider({ slides }: { slides: HeroSlide[] }) {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [reduced, setReduced] = useState(false)
  const touchX = useRef<number | null>(null)
  const count = slides.length
  // Slaytlar üst üste durduğu için hepsinin görseli "ekranda" sayılıp baştan inerdi
  // (~800 KB). İlk slayt hemen; komşular sayfa yüklenince boşta; gerisi sırası gelince.
  const [warm, setWarm] = useState(false)
  const [seen, setSeen] = useState<ReadonlySet<number>>(() => new Set([0]))

  const go = useCallback((next: number) => setIndex(((next % count) + count) % count), [count])

  useEffect(() => {
    const want = warm ? [index, (index + 1) % count, (index - 1 + count) % count] : [index]
    setSeen((prev) => (want.every((i) => prev.has(i)) ? prev : new Set([...prev, ...want])))
  }, [index, warm, count])

  useEffect(() => {
    let cancel = () => {}
    const ready = () => {
      if (window.requestIdleCallback) {
        const id = window.requestIdleCallback(() => setWarm(true), { timeout: 2000 })
        cancel = () => window.cancelIdleCallback(id)
      } else {
        const id = window.setTimeout(() => setWarm(true), 300)
        cancel = () => window.clearTimeout(id)
      }
    }
    if (document.readyState === "complete") ready()
    else window.addEventListener("load", ready, { once: true })
    return () => {
      window.removeEventListener("load", ready)
      cancel()
    }
  }, [])

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => setReduced(mq.matches)
    update()
    mq.addEventListener("change", update)
    return () => mq.removeEventListener("change", update)
  }, [])

  useEffect(() => {
    if (paused || reduced || count < 2) return
    const timer = window.setTimeout(() => go(index + 1), INTERVAL_MS)
    return () => window.clearTimeout(timer)
  }, [index, paused, reduced, count, go])

  if (!count) return null

  return (
    <section
      className="hero-slider"
      aria-roledescription="carousel"
      aria-label="Öne çıkanlar"
      data-paused={paused || reduced ? "" : undefined}
      onPointerEnter={(e) => e.pointerType === "mouse" && setPaused(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false)
      }}
      onTouchStart={(e) => {
        touchX.current = e.touches[0]?.clientX ?? null
      }}
      onTouchEnd={(e) => {
        const start = touchX.current
        touchX.current = null
        const end = e.changedTouches[0]?.clientX
        if (start == null || end == null) return
        const dx = end - start
        if (Math.abs(dx) > SWIPE_PX) go(dx < 0 ? index + 1 : index - 1)
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") go(index + 1)
        if (e.key === "ArrowLeft") go(index - 1)
      }}
    >
      <div className="hero-slider__track">
        {slides.map((s, i) => {
          const active = i === index
          const showImage = active || seen.has(i)
          return (
            <div
              key={s.image}
              className="hero-slider__slide"
              data-active={active ? "" : undefined}
              data-place={s.place ?? "left"}
              data-mobile-place={s.mobilePlace ?? "bottom"}
              role="group"
              aria-roledescription="slide"
              aria-label={`${i + 1} / ${count}: ${s.tab}`}
              aria-hidden={!active}
            >
              {showImage ? (
                <SlideImage slide={s} priority={i === 0} />
              ) : null}
              <div className="hero-slider__scrim" aria-hidden />
              <div className="hero-slider__copy">
                {i === 0 ? <h1 className="hero-slider__title">{s.title}</h1> : <h2 className="hero-slider__title">{s.title}</h2>}
                <p className="hero-slider__lead">{s.lead}</p>
                <Link
                  href={s.cta.href}
                  className={`hero-slider__cta${s.cta.info ? " hero-slider__cta--info" : ""}`}
                  tabIndex={active ? 0 : -1}
                >
                  {s.cta.label}
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path d="M3 8h9.5M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </Link>
              </div>
            </div>
          )
        })}
      </div>

      {count > 1 ? (
        <>
          <div className="hero-slider__dots" role="tablist" aria-label="Slaytlar">
            {slides.map((s, i) => (
              <button
                key={s.image}
                type="button"
                role="tab"
                aria-selected={i === index}
                aria-label={s.tab}
                className="hero-slider__dot"
                onClick={() => go(i)}
              />
            ))}
          </div>
        </>
      ) : null}
    </section>
  )
}

const MOBILE_MQ = "(max-width: 720px)"
const DESKTOP_MQ = "(min-width: 721px)"

/** Telefonda dikey, masaüstünde yatay banner: tarayıcı yalnız ekrana uyanı indirir. */
function SlideImage({ slide, priority }: { slide: HeroSlide; priority: boolean }) {
  const style = { objectPosition: slide.mobileImage ? undefined : slide.focus || "50% 50%" }
  const desktop = mediaImage(slide.image)
  const mobile = slide.mobileImage ? mediaImage(slide.mobileImage) : null

  // Build'de üretilmiş AVIF/WebP (shared/media): sunucu istek anında sıkıştırmaz.
  if (desktop && (mobile || !slide.mobileImage)) {
    const sources = [
      ...(mobile ? pictureSources(mobile, "100vw", MOBILE_MQ) : []),
      ...pictureSources(desktop, "100vw", mobile ? DESKTOP_MQ : undefined),
    ]
    if (priority) preloadSources(sources)
    return (
      <picture>
        {sources.map((s) => (
          <source key={`${s.media ?? ""}${s.type}`} type={s.type} media={s.media} srcSet={s.srcSet} sizes={s.sizes} />
        ))}
        <img
          alt={slide.alt}
          src={desktop.src}
          width={desktop.width}
          height={desktop.height}
          decoding="async"
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : "auto"}
          className="hero-slider__img"
          style={{ ...style, backgroundColor: (mobile ?? desktop).color ?? undefined }}
        />
      </picture>
    )
  }

  // Manifestte olmayan banner (yeni eklenmiş, build edilmemiş): Next optimizer'ı.
  const common = { alt: slide.alt, sizes: "100vw", quality: 85, priority }
  const { props: desktopProps } = getImageProps({ ...common, src: slide.image, width: 2560, height: 1440 })
  const mobileProps = slide.mobileImage
    ? getImageProps({ ...common, src: slide.mobileImage, width: 1440, height: 2160 }).props
    : null
  return (
    <picture>
      {mobileProps ? <source media={MOBILE_MQ} srcSet={mobileProps.srcSet} sizes={mobileProps.sizes} /> : null}
      {/* eslint-disable-next-line jsx-a11y/alt-text -- alt getImageProps'tan gelir */}
      <img {...desktopProps} className="hero-slider__img" style={style} />
    </picture>
  )
}

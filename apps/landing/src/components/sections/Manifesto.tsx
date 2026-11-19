'use client'

import { useEffect, useRef, useState } from 'react'
import Image from '@/components/ui/Img'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { about } from '@/data/content'
import { corporateLinks } from '@/lib/site'
import { Glass, Sprig, Teapot } from '@/components/ui/Doodles'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import BlobBg from '@/components/ui/BlobBg'

gsap.registerPlugin(ScrollTrigger)

const words = about.lead.split(' ')

/* Photo slider: each of the four frames holds this long before the next fades in. */
const SLIDE_MS = 5500

/* Torn edge for the photo (objectBoundingBox), down its left side. Desktop only:
   on phones and tablets the photo is a plain rounded frame like the Journey tiles. */
const TEAR_FRONT = 'M0.042,0.000 L0.041,0.010 L0.046,0.020 L0.054,0.030 L0.050,0.040 L0.055,0.050 L0.055,0.060 L0.057,0.070 L0.060,0.080 L0.060,0.090 L0.067,0.100 L0.064,0.110 L0.067,0.120 L0.067,0.130 L0.070,0.140 L0.071,0.150 L0.074,0.160 L0.070,0.170 L0.067,0.180 L0.068,0.190 L0.074,0.200 L0.068,0.210 L0.074,0.220 L0.074,0.230 L0.077,0.240 L0.076,0.250 L0.080,0.260 L0.079,0.270 L0.081,0.280 L0.084,0.290 L0.083,0.300 L0.081,0.310 L0.083,0.320 L0.093,0.330 L0.093,0.340 L0.094,0.350 L0.102,0.360 L0.103,0.370 L0.106,0.380 L0.109,0.390 L0.106,0.400 L0.107,0.410 L0.112,0.420 L0.109,0.430 L0.115,0.440 L0.113,0.450 L0.119,0.460 L0.122,0.470 L0.125,0.480 L0.126,0.490 L0.124,0.500 L0.123,0.510 L0.123,0.520 L0.126,0.530 L0.127,0.540 L0.125,0.550 L0.133,0.560 L0.133,0.570 L0.138,0.580 L0.137,0.590 L0.141,0.600 L0.142,0.610 L0.147,0.620 L0.149,0.630 L0.153,0.640 L0.156,0.650 L0.162,0.660 L0.166,0.670 L0.165,0.680 L0.171,0.690 L0.174,0.700 L0.183,0.710 L0.189,0.720 L0.187,0.730 L0.193,0.740 L0.192,0.750 L0.192,0.760 L0.199,0.770 L0.198,0.780 L0.199,0.790 L0.203,0.800 L0.204,0.810 L0.208,0.820 L0.211,0.830 L0.212,0.840 L0.215,0.850 L0.214,0.860 L0.213,0.870 L0.214,0.880 L0.214,0.890 L0.219,0.900 L0.219,0.910 L0.225,0.920 L0.226,0.930 L0.230,0.940 L0.235,0.950 L0.232,0.960 L0.234,0.970 L0.237,0.980 L0.240,0.990 L1.000,1.000 L1.000,0.000 Z'

/* Each fact gets its own brand colour so the row reads as the palette. */
const pointStyle = {
  sprig: { Icon: Sprig, circle: 'bg-leaf text-ink' },
  teapot: { Icon: Teapot, circle: 'bg-gold text-ink' },
  glass: { Icon: Glass, circle: 'bg-brand text-cream' },
}

export default function Manifesto() {
  const ref = useRef<HTMLElement>(null)
  const reduced = usePrefersReducedMotion()
  const [slide, setSlide] = useState(0)
  const count = about.photos.length

  /* Only the frames that have been (or are about to be) shown are in the DOM: four stacked
     full-width photos would otherwise all download as soon as the section nears the screen. */
  const [mounted, setMounted] = useState<ReadonlySet<number>>(() => new Set([0]))
  const mount = (...frames: number[]) =>
    setMounted((prev) => (frames.every((f) => prev.has(f)) ? prev : new Set([...prev, ...frames])))

  /* Showing a frame also fetches the one after it, so the next cross-fade has its photo. */
  const show = (s: number) => {
    setSlide(s)
    mount(s, (s + 1) % count)
  }
  const step = (dir: 1 | -1) => show((slide + dir + count) % count)

  const [visible, setVisible] = useState(false)

  /* The four frames cross-fade while the section is on screen; with reduced motion the first frame stays. */
  useEffect(() => {
    if (reduced) return
    const section = ref.current
    if (!section) return
    const io = new IntersectionObserver(([entry]) => {
      setVisible(entry.isIntersecting)
      // On screen: the second frame starts loading before the first cross-fade.
      if (entry.isIntersecting) setMounted((prev) => (prev.has(1) ? prev : new Set(prev).add(1)))
    })
    io.observe(section)
    return () => io.disconnect()
  }, [reduced])

  /* Keyed on `slide`, so a manual step restarts the countdown instead of jumping right after a click. */
  useEffect(() => {
    if (reduced || !visible) return
    const t = setTimeout(() => {
      const s = (slide + 1) % count
      setSlide(s)
      setMounted((prev) => new Set(prev).add(s).add((s + 1) % count))
    }, SLIDE_MS)
    return () => clearTimeout(t)
  }, [reduced, visible, slide, count])

  useEffect(() => {
    if (reduced) return
    const section = ref.current
    if (!section) return
    const ctx = gsap.context(() => {
      gsap.fromTo(
        section.querySelectorAll('.w'),
        { opacity: 0.18 },
        {
          opacity: 1,
          stagger: 0.08,
          ease: 'none',
          scrollTrigger: {
            trigger: section.querySelector('.about-lead'),
            start: 'top 80%',
            end: 'bottom 50%',
            scrub: true,
          },
        },
      )
    }, section)
    return () => ctx.revert()
  }, [reduced])

  return (
    <section ref={ref} id="hakkimizda" aria-labelledby="hakkimizda-baslik" className="relative z-10 overflow-hidden bg-linen text-ink shadow-[0_-24px_60px_rgba(0,0,0,0.3)]">
      <svg width="0" height="0" className="absolute" aria-hidden="true">
        <defs>
          <clipPath id="tear-front" clipPathUnits="objectBoundingBox">
            <path d={TEAR_FRONT} />
          </clipPath>
        </defs>
      </svg>

      <div className="mx-auto grid max-w-7xl gap-12 px-5 pt-20 pb-20 sm:px-8 sm:pt-24 lg:min-h-[700px] lg:pt-28 lg:grid-cols-12 lg:items-center lg:gap-8 lg:py-28 lg:pb-28">
        <div className="order-1 lg:order-none lg:col-span-5">
          <h2
            id="hakkimizda-baslik"
            className="text-[clamp(2.6rem,4.6vw,4.2rem)] leading-[1] font-bold tracking-[-0.03em] text-olive"
          >
            {about.title}
          </h2>
          <p className="about-lead mt-7 max-w-[30ch] text-[clamp(1.2rem,1.6vw,1.45rem)] leading-[1.45] font-medium text-ink">
            {words.map((w, i) => (
              <span key={`${w}-${i}`} className="w inline-block">
                {w}&nbsp;
              </span>
            ))}
          </p>
          <p className="mt-5 max-w-[42ch] text-[1rem] leading-relaxed text-ink/75">{about.body}</p>

          <ul className="mt-10 grid max-w-md grid-cols-3 gap-4">
            {about.points.map((pt) => {
              const { Icon, circle } = pointStyle[pt.icon]
              return (
                <li key={pt.label} className="flex flex-col items-start gap-3">
                  <span className={`flex h-16 w-16 items-center justify-center rounded-full ${circle}`}>
                    <Icon className="h-10 w-10" />
                  </span>
                  <span className="text-[0.92rem] leading-snug font-semibold">{pt.label}</span>
                </li>
              )
            })}
          </ul>

          <a
            href={corporateLinks[0].href}
            className="group relative isolate mt-10 inline-flex min-h-12 items-center rounded-full px-8 text-[0.8rem] font-bold tracking-[0.14em] text-ink uppercase transition-colors duration-200 hover:text-cream focus-visible:text-cream focus:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-linen"
          >
            <BlobBg className="fill-gold group-hover:fill-garden" />
            <span className="blob-label">{about.link}</span>
          </a>
        </div>

        <div className="relative order-2 lg:order-none lg:col-span-7 lg:self-stretch" data-reveal>
          <div className="lg:absolute lg:inset-0 lg:-inset-y-28 lg:right-[min(-2rem,calc((80rem-100vw)/2-2rem))]">
            <div className="relative aspect-[5/4] overflow-hidden rounded-2xl bg-paper sm:aspect-[16/10] lg:absolute lg:inset-0 lg:aspect-auto lg:rounded-none lg:bg-transparent lg:[clip-path:url(#tear-front)]">
              {about.photos.map((photo, i) => mounted.has(i) || i === slide ? (
                <Image
                  key={photo.src}
                  src={photo.src}
                  alt={photo.alt}
                  fill
                  sizes="(min-width: 1024px) 60vw, 100vw"
                  style={{ objectPosition: 'focus' in photo ? photo.focus : '60% 50%' }}
                  className={`object-cover transition-opacity duration-[1200ms] ease-in-out motion-reduce:transition-none ${i === slide ? 'opacity-100' : 'opacity-0'}`}
                  aria-hidden={i !== slide}
                />
              ) : null)}
              <div
                className="absolute inset-0 hidden bg-[linear-gradient(to_top,rgba(0,0,0,0.35),transparent_35%)] lg:block"
                aria-hidden="true"
              />
            </div>

            {/* Below the frame on phones (caption left, arrows right); over the photo's foot on desktop. */}
            <div className="mt-4 flex items-start justify-between gap-4 lg:absolute lg:right-8 lg:bottom-14 lg:mt-0 lg:flex-col lg:items-end lg:justify-start lg:gap-3">
              <div className="order-2 flex shrink-0 gap-2 lg:order-1">
                <button type="button" onClick={() => step(-1)} aria-label="Önceki fotoğraf" className="gallery-btn">
                  ←
                </button>
                <button type="button" onClick={() => step(1)} aria-label="Sonraki fotoğraf" className="gallery-btn">
                  →
                </button>
              </div>
              <p
                key={slide}
                className="caption-in order-1 min-h-[2.9em] text-[0.95rem] leading-[1.45] text-ink/70 motion-reduce:animate-none lg:order-2 lg:min-h-0 lg:text-[0.85rem] lg:text-cream/90 lg:drop-shadow-[0_1px_3px_rgba(0,0,0,0.5)]"
                aria-live="polite"
              >
                {about.photos[slide].caption}
              </p>
            </div>

            {/* Logo set on the tear like a seal pressed onto the page. */}
            <Image
              src="/logo.png"
              alt=""
              width={341}
              height={182}
              className="absolute top-[16%] left-0 hidden w-56 -rotate-[8deg] drop-shadow-[0_14px_18px_rgba(0,0,0,0.35)] lg:block"
            />
          </div>
        </div>
      </div>
    </section>
  )
}

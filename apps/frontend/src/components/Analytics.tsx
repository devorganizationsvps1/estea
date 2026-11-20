"use client"

import { useEffect, useRef } from "react"
import { usePathname } from "next/navigation"
import { onConsentChange, readConsent, type Consent } from "@/lib/consent"
import { isProductionHostname } from "@/lib/site"
import { maskPath, maskUrl, trackerPolicy } from "@/lib/tracking-privacy"

// TODO(K7): Es Çay adına açılan hesapların ID'leri (Dokploy: Environment + Build-time Arguments).
// Boş bırakılan servis yüklenmez.
const GA4_ID = (process.env.NEXT_PUBLIC_GA4_ID || "").trim()
const GOOGLE_ADS_ID = (process.env.NEXT_PUBLIC_GOOGLE_ADS_ID || "").trim()
const META_PIXEL_ID = (process.env.NEXT_PUBLIC_META_PIXEL_ID || "").trim()
const CLARITY_ID = (process.env.NEXT_PUBLIC_CLARITY_ID || "").trim()

/** Staging / IP / localhost verisi canlı GA / Pixel'e karışmasın. */
function isProductionHost() {
  return isProductionHostname(window.location.hostname)
}

function addScript(id: string, src: string) {
  if (document.getElementById(id)) return
  const s = document.createElement("script")
  s.id = id
  s.async = true
  s.src = src
  document.head.appendChild(s)
}

function ensureGtag() {
  if (window.gtag) return
  if (!GA4_ID && !GOOGLE_ADS_ID) return
  const w = window as unknown as { dataLayer: unknown[] }
  w.dataLayer = w.dataLayer || []
  window.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    w.dataLayer.push(arguments)
  }
  window.gtag("js", new Date())
  addScript("gtag-js", `https://www.googletagmanager.com/gtag/js?id=${GA4_ID || GOOGLE_ADS_ID}`)
}

type ClarityFn = ((...a: unknown[]) => void) & { q?: unknown[] }
type Fbq = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void
  queue: unknown[]
  push: Fbq
  loaded: boolean
  version: string
  /** fbevents.js: true ise history değişiminde kendiliğinden PageView atmaz. */
  disablePushState?: boolean
}

function currentHref() {
  return window.location.href
}

/** GA config / page_view için maskelenmiş adres alanları. */
function gaLocation() {
  const loc: Record<string, string> = {}
  const page = maskUrl(currentHref())
  if (page) loc.page_location = page
  const ref = document.referrer ? maskUrl(document.referrer) : ""
  if (ref) loc.page_referrer = ref
  return loc
}

let ga4Configured = false
let adsConfigured = false
/** Clarity hassas sayfada durduruldu; aynı sayfa ömründe yeniden başlatılmaz. */
let clarityStopped = false
let pixelRevoked = false

function loadAnalytics() {
  const policy = trackerPolicy(currentHref())
  if (GA4_ID && !ga4Configured) {
    ensureGtag()
    ga4Configured = true
    window.gtag?.("config", GA4_ID, gaLocation())
  }
  // Clarity tam URL'yi ve ekranı kaydeder: hassas sayfada hiç yüklenmez. İlk açılış
  // hassassa sonraki güvenli sayfada (client navigasyon) yüklenir.
  if (CLARITY_ID && policy.clarity && !clarityStopped && !document.getElementById("clarity-js")) {
    const w = window as unknown as { clarity?: ClarityFn }
    w.clarity =
      w.clarity ||
      Object.assign(
        function clarity(...args: unknown[]) {
          ;(w.clarity!.q = w.clarity!.q || []).push(args)
        },
        { q: [] as unknown[] }
      )
    addScript("clarity-js", `https://www.clarity.ms/tag/${CLARITY_ID}`)
  }
}

function loadMarketing() {
  const policy = trackerPolicy(currentHref())
  if (GOOGLE_ADS_ID && !adsConfigured) {
    ensureGtag()
    adsConfigured = true
    window.gtag?.("config", GOOGLE_ADS_ID, gaLocation())
  }
  // Pixel her olayda tam URL'yi (dl) yollar: hassas sayfada init edilmez.
  if (META_PIXEL_ID && policy.pixel && !window.fbq) {
    const fbq = function (...args: unknown[]) {
      if (fbq.callMethod) fbq.callMethod(...args)
      else fbq.queue.push(args)
    } as Fbq
    fbq.push = fbq
    fbq.loaded = true
    fbq.version = "2.0"
    fbq.queue = []
    // PageView'i biz atıyoruz (hassas sayfa hariç); fbevents.js'in history dinleyicisi
    // hassas sayfaya geçişte de kendiliğinden atardı.
    fbq.disablePushState = true
    window.fbq = fbq
    addScript("fb-pixel", "https://connect.facebook.net/en_US/fbevents.js")
    // Otomatik olaylar (buton tıklama, sayfa meta verisi) kapalı.
    window.fbq("set", "autoConfig", false, META_PIXEL_ID)
    window.fbq("init", META_PIXEL_ID)
    window.fbq("track", "PageView")
  }
}

/**
 * Client navigasyonunda hassas sayfaya girilirse yüklü takipçiler susturulur.
 * Clarity: "stop" (kayıt sayfa yenilenene dek kapalı kalır). Pixel: consent revoke,
 * güvenli sayfada grant.
 */
function guardNavigation() {
  const policy = trackerPolicy(currentHref())
  if (!policy.clarity && document.getElementById("clarity-js") && !clarityStopped) {
    clarityStopped = true
    ;(window as unknown as { clarity?: ClarityFn }).clarity?.("stop")
  }
  if (window.fbq) {
    if (!policy.pixel && !pixelRevoked) {
      pixelRevoked = true
      window.fbq("consent", "revoke")
    } else if (policy.pixel && pixelRevoked) {
      pixelRevoked = false
      window.fbq("consent", "grant")
    }
  }
}

function apply(consent: Consent | null) {
  if (!consent || !isProductionHost()) return
  if (consent.analytics) loadAnalytics()
  if (consent.marketing) loadMarketing()
}

/**
 * GA4, Google Ads, Meta Pixel, Clarity — CookieYes onayına göre
 * (analytics: GA4 + Clarity, advertisement: Ads + Pixel). Yalnızca canlı domain'de.
 */
export function Analytics() {
  const pathname = usePathname()

  useEffect(() => {
    apply(readConsent())
    return onConsentChange(apply)
  }, [])

  // Client-side navigasyonda sayfa görüntüleme (ilk yükleme config/init ile gider)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    guardNavigation()
    // İlk açılış hassas sayfaysa ertelenen takipçiler güvenli sayfada yüklenir.
    const consent = readConsent()
    const hadPixel = Boolean(window.fbq)
    apply(consent)
    const page = maskUrl(currentHref())
    window.gtag?.("event", "page_view", {
      ...(page ? { page_location: page } : {}),
      page_path: maskPath(pathname),
    })
    // Yeni yüklenen Pixel PageView'ini init'te attı.
    if (hadPixel && trackerPolicy(currentHref()).pixel) window.fbq?.("track", "PageView")
  }, [pathname])

  return null
}

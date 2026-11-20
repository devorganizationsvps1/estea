"use client"

import { useEffect, useRef } from "react"
import { usePathname } from "next/navigation"
import { onConsentChange, readConsent } from "@/lib/consent"
import { trackerPolicy } from "@/lib/tracking-privacy"

const BRAND_ID = process.env.NEXT_PUBLIC_OMNISEND_BRAND_ID?.trim() || ""
const LAUNCHER_SRC = "https://omnisnippet1.com/inshop/launcher-v2.js"

type OmnisendQueue = unknown[][] & { push: (args: unknown[]) => void }

declare global {
  interface Window {
    omnisend?: OmnisendQueue
  }
}

/** Hassas sayfada (token/e-posta URL'de, sipariş/hesap ekranı) Omnisend çalışmaz. */
function allowedHere() {
  return trackerPolicy(window.location.href).omnisend
}

function load() {
  if (!BRAND_ID || document.getElementById("omnisend-launcher")) return
  if (!allowedHere()) return
  window.omnisend = window.omnisend || ([] as unknown as OmnisendQueue)
  window.omnisend.push(["brandID", BRAND_ID])
  window.omnisend.push(["track", "$pageViewed"])
  const script = document.createElement("script")
  script.id = "omnisend-launcher"
  script.async = true
  script.src = LAUNCHER_SRC
  document.head.appendChild(script)
}

/**
 * Omnisend web takibi + pop-up formlar. Yalnızca CookieYes'te
 * "Reklam" (advertisement) onayı varsa yüklenir (KVKK). Sipariş/checkout event'leri
 * backend'den REST API ile gider (lib/omnisend.ts) — buna bağlı değil.
 * İlk açılış hassas sayfaysa launcher ertelenir, ilk güvenli sayfada yüklenir.
 * Sınır: launcher bir kez yüklendikten sonra kendi iç takibi bizden bağımsızdır;
 * hassas sayfaya geçişte yalnız bizim $pageViewed çağrımız atlanır.
 */
export function OmnisendSnippet() {
  const pathname = usePathname()

  useEffect(() => {
    if (!BRAND_ID) return
    if (readConsent()?.marketing) load()
    return onConsentChange((consent) => {
      if (consent?.marketing) load()
    })
  }, [])

  // Client-side navigasyonlarda sayfa görüntüleme (ilk yükleme load() içinde)
  const firstPath = useRef(true)
  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false
      return
    }
    if (!allowedHere()) return
    if (document.getElementById("omnisend-launcher")) {
      window.omnisend?.push(["track", "$pageViewed"])
    } else if (readConsent()?.marketing) {
      load()
    }
  }, [pathname])

  return null
}

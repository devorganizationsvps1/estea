'use client'

import { useEffect } from 'react'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Yalnız `next dev`: landing telefondan Mac'in ağ IP'siyle açıldığında
 * mağaza linkleri (NEXT_PUBLIC_SHOP_URL=http://localhost:3025) telefonun kendisine
 * gider. localhost linklerinin host'u sayfanın host'uyla değiştirilir; yalnız
 * tıklamada değil, href'in kendisinde, ki uzun basıp "yeni sekmede aç" ve orta
 * tık da doğru adrese gitsin. Sonradan eklenen linkler için DOM izlenir.
 */
export function DevLanLinks() {
  useEffect(() => {
    const pageHost = window.location.hostname
    if (LOOPBACK.has(pageHost)) return
    const rewrite = (root: ParentNode) => {
      root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
        try {
          const u = new URL(a.href)
          if (!LOOPBACK.has(u.hostname)) return
          u.hostname = pageHost
          a.href = u.toString()
        } catch {
          /* geçersiz href: dokunma */
        }
      })
    }
    rewrite(document)
    const mo = new MutationObserver(() => rewrite(document))
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] })
    return () => mo.disconnect()
  }, [])
  return null
}

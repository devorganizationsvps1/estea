import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import '@estea/ui/fonts'
import { DevLanLinks } from '@/components/layout/DevLanLinks'
import './globals.css'

/** Paylaşım önizlemelerinin mutlak adresi; geçici Dokploy adresinde build argümanıyla verilir. */
const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || 'https://esteacay.com').replace(/\/+$/, '')

/** Hero.tsx'teki isConstrainedConnection ile aynı kural. */
const LITE_SCRIPT =
  "try{var c=navigator.connection;if(c&&(c.saveData||/2g|3g/.test(c.effectiveType||'')))document.documentElement.setAttribute('data-lite','')}catch(e){}"

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'Esçay — Yapraktan bardağa, gerçek çay',
  description:
    "Karadeniz'in yüksek rakımlı bahçelerinden, katkısız harmanlanan çay. Her yudumda Karadeniz.",
  icons: { icon: '/favicon.svg' },
  openGraph: {
    title: 'Esçay — Yapraktan bardağa, gerçek çay',
    description: "Karadeniz'in yüksek bahçelerinden, katkısız harmanlanan çay.",
    locale: 'tr_TR',
    type: 'website',
  },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: aşağıdaki script <html>'e data-lite ekleyebilir.
    <html lang="tr" suppressHydrationWarning>
      <body>
        {/* İlk boyamadan önce: yavaş bağlantıda hero'nun sabit düzeni (bkz. Hero.tsx, globals.css). */}
        <script dangerouslySetInnerHTML={{ __html: LITE_SCRIPT }} />
        {/* JS kapalıysa kaydırınca beliren bloklar hep görünür olsun. */}
        <noscript>
          <style>{'[data-reveal]{opacity:1!important;transform:none!important}'}</style>
        </noscript>
        {children}
        {process.env.NODE_ENV === 'development' && <DevLanLinks />}
      </body>
    </html>
  )
}

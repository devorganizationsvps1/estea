import type { Metadata } from 'next'
import Navbar from '@/components/layout/Navbar'
import Footer from '@/components/layout/Footer'
import SkipLink from '@/components/layout/SkipLink'
import ErrorView from '@/components/layout/ErrorView'

export const metadata: Metadata = {
  title: 'Sayfa bulunamadı — Esçay',
  robots: { index: false },
}

export default function NotFound() {
  return (
    <>
      <SkipLink />
      <Navbar tone="ink" />
      <main id="icerik">
        <ErrorView
          title="Bu sayfa artık burada değil."
          text="Bağlantı eski sitemizden kalmış olabilir. Harmanlarımıza ve yazılarımıza ana sayfadan ulaşabilirsiniz."
        />
      </main>
      <Footer />
    </>
  )
}

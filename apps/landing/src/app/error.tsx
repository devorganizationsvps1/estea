'use client'

import { useEffect } from 'react'
import Navbar from '@/components/layout/Navbar'
import Footer from '@/components/layout/Footer'
import ErrorView from '@/components/layout/ErrorView'

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <>
      <Navbar tone="ink" />
      <main id="icerik">
        <ErrorView
          title="Bir şeyler ters gitti."
          text="Sayfa şu an açılamadı. Birkaç saniye sonra tekrar deneyebilirsiniz."
          action={
            <button
              type="button"
              onClick={() => reset()}
              className="inline-flex min-h-12 items-center justify-center rounded-full bg-brand px-8 text-[0.8rem] font-bold tracking-[0.14em] text-cream uppercase transition-colors duration-200 hover:bg-brand-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
            >
              Tekrar dene
            </button>
          }
        />
      </main>
      <Footer />
    </>
  )
}

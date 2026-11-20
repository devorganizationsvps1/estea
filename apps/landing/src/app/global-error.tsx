'use client'

// Kök layout'un kendisi hata verdiğinde çalışır: layout yoktur, <html> ve <body>
// burada kurulur. Menü ve footer bilerek yok; bozuk parçaya bağlı olabilirler.
import '@estea/ui/fonts'
import './globals.css'
import { useEffect } from 'react'
import ErrorView from '@/components/layout/ErrorView'

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <html lang="tr">
      <body>
        <main>
          <ErrorView
            title="Bir şeyler ters gitti."
            text="Site şu an açılamadı. Birkaç saniye sonra tekrar deneyebilirsiniz."
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
      </body>
    </html>
  )
}

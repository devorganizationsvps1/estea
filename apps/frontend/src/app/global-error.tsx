"use client"

// Kök layout'un kendisi hata verdiğinde çalışır: layout (header, footer, fontlar)
// yoktur, <html> ve <body> burada kurulur. Bağlantılar düz <a>: istemci yönlendirmesi
// bozuk layout'a geri dönebilir, tam sayfa yüklemesi temiz başlar.
import "@/lib/fonts"
import "./globals.css"
import { useEffect } from "react"
import { COMPANY } from "@/lib/company"

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <html lang="tr">
      <body>
        <main>
          <div className="page-shell">
            <div className="cart-empty">
              <div className="checkout-result">
                <h1 className="checkout-result__title">Bir şeyler ters gitti</h1>
                <p className="checkout-result__text">
                  Mağaza şu an açılamadı. Birkaç saniye sonra tekrar deneyebilirsiniz.
                </p>
                <div className="checkout-result__actions">
                  <button type="button" className="cart-cta cart-cta--ink" onClick={() => reset()}>
                    Tekrar dene
                  </button>
                  {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- tam yükleme bilerek */}
                  <a href="/" className="cart-cta">
                    Ana sayfaya dön
                  </a>
                </div>
                <p className="checkout-result__help">
                  Yardım için <a href={COMPANY.phoneHref}>{COMPANY.phone}</a> numarasından bize
                  ulaşabilirsiniz.
                </p>
              </div>
            </div>
          </div>
        </main>
      </body>
    </html>
  )
}

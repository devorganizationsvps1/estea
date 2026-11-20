import Link from "next/link"
import type { ReactNode } from "react"
import { COMPANY } from "@/lib/company"

/** 404 ve hata sayfalarının ortak gövdesi: başlık, tek cümle, ana sayfa, telefon. */
export function ErrorState({
  title,
  text,
  action,
}: {
  title: string
  text: string
  /** Ana sayfa bağlantısından önce gösterilecek birincil eylem (ör. tekrar dene). */
  action?: ReactNode
}) {
  return (
    <div className="page-shell">
      <div className="cart-empty">
        <div className="checkout-result">
          <h1 className="checkout-result__title">{title}</h1>
          <p className="checkout-result__text">{text}</p>
          <div className="checkout-result__actions">
            {action}
            <Link href="/" className={action ? "cart-cta" : "cart-cta cart-cta--ink"}>
              Ana sayfaya dön
            </Link>
            <Link href="/urun-kategori" className="cart-cta">
              Ürünlere göz at
            </Link>
          </div>
          <p className="checkout-result__help">
            Yardım için <a href={COMPANY.phoneHref}>{COMPANY.phone}</a> numarasından bize
            ulaşabilirsiniz.
          </p>
        </div>
      </div>
    </div>
  )
}

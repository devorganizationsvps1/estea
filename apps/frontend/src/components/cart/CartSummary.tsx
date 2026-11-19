import {
  computeCartDisplayTotals,
  includedVatFromGross,
  roundMoney,
} from "@/lib/cart-pricing"
import { formatTry } from "@/lib/medusa"
import { AnimatedAmount } from "./AnimatedAmount"

type CartSummaryProps = {
  /** Pre-discount product subtotal (tax-inclusive TRY). */
  subtotal: number
  /** Ürün indirimi (KDV dahil); kargo indirimi dahil değil. */
  discountTotal?: number | null
  /**
   * Backend'den gelen kargo ücreti. null → henüz hesaplanamadı (ör. adres
   * yok): "Ödeme adımında hesaplanır" yazılır, toplam kargo hariç gösterilir.
   */
  shipping?: number | null
}

export function CartSummary({
  subtotal,
  discountTotal = 0,
  shipping: shippingEstimate = null,
}: CartSummaryProps) {
  const discount = Math.max(0, Number(discountTotal) || 0)
  const shippingPending = shippingEstimate == null
  const { shipping: displayShipping } = computeCartDisplayTotals(
    subtotal,
    shippingEstimate
  )
  const shipping = shippingPending ? 0 : displayShipping
  // Satırlardan hesaplanır: cart.total önceki denemeden kalan kargoyu içerebilir.
  const itemsAfterDiscount = roundMoney(Math.max(0, subtotal - discount))
  const total = roundMoney(itemsAfterDiscount + shipping)
  const vatNote = includedVatFromGross(itemsAfterDiscount)

  return (
    <dl className="cart-totals">
      <div className="cart-totals__row">
        <dt>Ara toplam</dt>
        <dd>{formatTry(subtotal)}</dd>
      </div>
      {discount > 0 ? (
        <div className="cart-totals__row">
          <dt>İndirim</dt>
          <dd>−{formatTry(discount)}</dd>
        </div>
      ) : null}
      <div className="cart-totals__row">
        <dt>Kargo</dt>
        <dd>
          {shippingPending ? "Ödeme adımında hesaplanır" : formatTry(shipping)}
        </dd>
      </div>
      <div className="cart-totals__divider" aria-hidden />
      <div className="cart-totals__row cart-totals__row--total">
        <dt>{shippingPending ? "Toplam (kargo hariç)" : "Toplam"}</dt>
        <dd>
          <AnimatedAmount
            className="cart-totals__total-amount"
            value={formatTry(total)}
          />
          <span className="cart-totals__vat-note">
            {formatTry(vatNote)} KDV dahil
          </span>
        </dd>
      </div>
    </dl>
  )
}

/**
 * Checkout'ta PayTR dışı ödeme sağlayıcısı (pp_system_default, havale) yalnız aynı
 * süreçte çalışan `medusa exec` betiklerinde (dhl-simulate, test-order-contracts)
 * kabul edilir. Ortam değişkeni değil, süreç içi bayrak: HTTP isteğiyle ya da Dokploy
 * ayarıyla açılamaz. Symbol.for → betik ve sunucu kodu farklı modül kopyası yüklese de
 * aynı bayrağı görür. Bkz. workflows/hooks/validate-cart-checkout.ts
 */
const KEY = Symbol.for("escay.checkout.allowScriptPaymentProviders")

export function allowScriptPaymentProviders(): void {
  ;(globalThis as Record<symbol, unknown>)[KEY] = true
}

export function scriptPaymentProvidersAllowed(): boolean {
  return (globalThis as Record<symbol, unknown>)[KEY] === true
}

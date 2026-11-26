/**
 * PayTR'ye giden her istek süre sınırlıdır: yanıt gelmezse müşteri ödeme adımında,
 * uzlaştırma işi ve iade (sipariş para kilidi altında) süresiz beklemesin.
 * PAYTR_TIMEOUT_MS (varsayılan 20000).
 */
export function paytrTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PAYTR_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20_000
}

/** fetch'e verilecek iptal sinyali; süre dolunca istek TimeoutError ile düşer. */
export function paytrSignal(): AbortSignal {
  return AbortSignal.timeout(paytrTimeoutMs())
}

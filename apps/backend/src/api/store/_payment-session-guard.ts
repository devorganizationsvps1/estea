import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

/**
 * POST /store/payment-collections/:id/payment-sessions süzgeci.
 *
 * Medusa her zaman pp_system_default sağlayıcısını kaydeder ve oturum açarken
 * bölgeyi kontrol etmez; system sağlayıcısı ödemeyi kendiliğinden "authorized"
 * sayar → ödenmeden sipariş açılır. Mağazada yalnız PayTR açık (havale kapalı,
 * 2026-11-07); havale yeniden açılırsa pp_havale_havale buraya eklenmeli.
 *
 * Medusa istemcinin `data` alanını oturuma olduğu gibi yazar
 * ({...input.data, ...provider.data}); sağlayıcının okuduğu kontrol alanları
 * (_stub, manual_review, paytr_last_failed_at …) istemciden gelmesin diye
 * yalnız mağazanın gönderdiği müşteri/sepet alanları geçer.
 */
export const ALLOWED_STORE_PAYMENT_PROVIDERS = new Set(["pp_paytr_paytr"])

const ALLOWED_SESSION_DATA_KEYS = new Set([
  "customer_email",
  "first_name",
  "last_name",
  "phone",
  "address",
  "cart_items",
  "user_ip",
])

function pickAllowed(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (ALLOWED_SESSION_DATA_KEYS.has(k)) out[k] = v
  }
  return out
}

export function guardStorePaymentSession(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  for (const holder of [
    req.body as Record<string, unknown> | undefined,
    (req as { validatedBody?: Record<string, unknown> }).validatedBody,
  ]) {
    if (!holder || typeof holder !== "object") continue
    const providerId = holder.provider_id
    if (typeof providerId !== "string" || !ALLOWED_STORE_PAYMENT_PROVIDERS.has(providerId)) {
      res.status(400).json({
        type: "invalid_data",
        message: "Bu ödeme yöntemi kullanılamıyor.",
      })
      return
    }
    if ("data" in holder) holder.data = pickAllowed(holder.data)
  }
  next()
}

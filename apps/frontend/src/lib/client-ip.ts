/**
 * Mağaza sunucusu backend'i server action'lardan çağırır; backend her müşteriyi
 * mağaza sunucusunun IP'si olarak görür ve IP'ye göre tutulan istek sınırları
 * (giriş, şifre sıfırlama, sipariş sorgulama, iade …) tüm müşteriler için tek
 * sayaç olur. Bu yüzden müşterinin gerçek IP'si ayrı bir başlıkla iletilir; backend
 * ona yalnız STOREFRONT_PROXY_SECRET eşleşirse güvenir (bkz. backend
 * src/api/store/_rate-limit.ts).
 *
 * Bu dosya istemci bileşenlerine de giren medusa.ts'den import edilir: next/headers
 * içermez. İstek başlıklarını okuyan kısım server-client-ip.ts'de, instrumentation'da
 * globalThis'e kaydedilir.
 */

export const CLIENT_IP_HEADER = "x-escay-client-ip"
export const PROXY_SECRET_HEADER = "x-escay-proxy-secret"

const PROVIDER_KEY = Symbol.for("escay.storefront.clientIpHeaders")

type HeaderGetter = (name: string) => string | null | undefined

const IP_RE = /^[0-9A-Fa-f:.]{3,45}$/

/** Proxy'nin (Traefik) yazdığı müşteri IP'si: X-Real-Ip, yoksa X-Forwarded-For'un ilk girdisi. */
export function clientIpFrom(get: HeaderGetter): string | undefined {
  const real = get("x-real-ip")?.trim()
  if (real && IP_RE.test(real)) return real
  const first = get("x-forwarded-for")?.split(",")[0]?.trim()
  if (first && IP_RE.test(first)) return first
  return undefined
}

/** Backend'e iletilecek başlıklar; sır ya da IP yoksa boş (backend kendi IP'sine düşer). */
export function clientIpHeadersFrom(get: HeaderGetter): Record<string, string> {
  const secret = process.env.STOREFRONT_PROXY_SECRET?.trim()
  const ip = clientIpFrom(get)
  if (!secret || !ip) return {}
  return { [CLIENT_IP_HEADER]: ip, [PROXY_SECRET_HEADER]: secret }
}

/**
 * IP'ye göre sınırlanan backend uçları. Yalnız bunlara başlık eklenir: istek
 * başlıklarını okumak sayfayı dinamik yapar, katalog / ürün çağrıları etkilenmesin.
 */
const RATE_LIMITED_PATH =
  /^\/?(auth\/customer\/emailpass(\/(register|reset-password|update))?|auth\/verification\/request|store\/(orders\/lookup|returns\/(guest|request|exchange-options)|paytr-checkout\/(register|status)|contact|customers\/me\/password))\/?(\?|$)/

export function needsClientIp(input: unknown): boolean {
  let path = ""
  if (typeof input === "string") path = input
  else if (input instanceof URL) path = input.pathname
  else return false
  if (/^https?:\/\//.test(path)) {
    try {
      path = new URL(path).pathname
    } catch {
      return false
    }
  }
  return RATE_LIMITED_PATH.test(path)
}

type Provider = () => Promise<Record<string, string>>

export function registerClientIpHeadersProvider(provider: Provider): void {
  ;(globalThis as Record<symbol, unknown>)[PROVIDER_KEY] = provider
}

/** Sunucuda kayıtlı sağlayıcıdan başlıkları al; tarayıcıda / kayıt yoksa / hata olursa boş. */
export async function currentClientIpHeaders(): Promise<Record<string, string>> {
  if (typeof window !== "undefined") return {}
  const provider = (globalThis as Record<symbol, unknown>)[PROVIDER_KEY] as Provider | undefined
  if (!provider) return {}
  try {
    return await provider()
  } catch {
    return {}
  }
}

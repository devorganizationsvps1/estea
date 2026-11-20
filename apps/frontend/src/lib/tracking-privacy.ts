/**
 * Takip script'lerine (GA4, Google Ads, Meta Pixel, Clarity, Omnisend) URL'deki kimlik
 * bilgisinin gitmemesi için tek kaynak. Saf fonksiyonlar: window'a dokunmaz, test edilir.
 *
 * İki seviye:
 * - Kimlik taşıyan sayfalar (reset/verify token'ı, misafir sipariş e-postası, ödeme
 *   token'ı): Pixel, Clarity ve Omnisend hiç yüklenmez / olay göndermez. GA4 ve Ads
 *   yalnız maskelenmiş adresle (dinamik parça ve sorgu atılır) sayfa görüntüleme alır.
 * - Ekranında kişisel veri olan sayfalar (sipariş onayı, hesabım): oturum kaydı
 *   (Clarity) ve Omnisend yok; GA4 / Pixel satın alma dönüşümü için açık kalır.
 */

/** URL'de kimlik bilgisi sayılan sorgu parametreleri (büyük/küçük harf duyarsız). */
export const SENSITIVE_PARAMS = ["email", "token", "code"] as const

/** URL'si kimlik bilgisi taşıyan sayfalar (yol öneki, segment sınırında eşleşir). */
export const SENSITIVE_PATHS = [
  "/reset-password",
  "/verify-email",
  "/order-tracking",
  "/odeme/payment",
  "/odeme/payment-result",
] as const

/** Ekranda ad, adres, sipariş dökümü olan sayfalar: oturum kaydı ve Omnisend yok. */
export const PERSONAL_DATA_PATHS = ["/odeme/confirmation", "/hesabim"] as const

function matchPrefix(pathname: string, prefixes: readonly string[]): string | null {
  // En uzun önek: /odeme/payment-result, /odeme/payment'tan önce denensin.
  let best: string | null = null
  for (const p of prefixes) {
    if ((pathname === p || pathname.startsWith(p + "/")) && (!best || p.length > best.length)) {
      best = p
    }
  }
  return best
}

function toUrl(href: string | URL): URL | null {
  try {
    return href instanceof URL ? href : new URL(href)
  } catch {
    return null
  }
}

export function hasSensitiveQuery(search: URLSearchParams): boolean {
  for (const key of search.keys()) {
    if ((SENSITIVE_PARAMS as readonly string[]).includes(key.toLowerCase())) return true
  }
  return false
}

/** Yol kimlik bilgisi taşıyan bir sayfaysa ya da sorguda email/token/code varsa true. */
export function isSensitiveUrl(href: string | URL): boolean {
  const url = toUrl(href)
  if (!url) return true
  return matchPrefix(url.pathname, SENSITIVE_PATHS) !== null || hasSensitiveQuery(url.searchParams)
}

/** Oturum kaydı (Clarity) ve Omnisend bu adreste çalışmamalı mı? */
export function blocksSessionTracking(href: string | URL): boolean {
  const url = toUrl(href)
  if (!url) return true
  return isSensitiveUrl(url) || matchPrefix(url.pathname, PERSONAL_DATA_PATHS) !== null
}

/** Hassas sayfada dinamik parçayı (sipariş no, ödeme token'ı) atar: /order-tracking/abc → /order-tracking. */
export function maskPath(pathname: string): string {
  return matchPrefix(pathname, SENSITIVE_PATHS) ?? matchPrefix(pathname, PERSONAL_DATA_PATHS) ?? pathname
}

/**
 * Analytics'e giden adres. Hassas sayfada sorgu tamamen atılır; diğer sayfalarda
 * email/token/code değeri "redacted" olur (utm/gclid korunur). Hash hiç gönderilmez.
 * Ayrıştırılamayan adres boş döner (çağıran göndermesin / varsayılana bıraksın).
 */
export function maskUrl(href: string | URL): string {
  const url = toUrl(href)
  if (!url) return ""
  const clean = new URL(url.toString())
  clean.hash = ""
  const prefix = matchPrefix(clean.pathname, SENSITIVE_PATHS)
  if (prefix) {
    clean.pathname = prefix
    clean.search = ""
    return clean.toString()
  }
  clean.pathname = maskPath(clean.pathname)
  for (const key of [...clean.searchParams.keys()]) {
    if ((SENSITIVE_PARAMS as readonly string[]).includes(key.toLowerCase())) {
      clean.searchParams.set(key, "redacted")
    }
  }
  return clean.toString()
}

export type TrackerPolicy = {
  /** GA4 / Google Ads: her yerde, maskelenmiş adresle. */
  gtag: true
  /** Meta Pixel init + PageView. */
  pixel: boolean
  /** Microsoft Clarity oturum kaydı. */
  clarity: boolean
  /** Omnisend launcher + $pageViewed. */
  omnisend: boolean
}

export function trackerPolicy(href: string | URL): TrackerPolicy {
  const sensitive = isSensitiveUrl(href)
  const session = blocksSessionTracking(href)
  return { gtag: true, pixel: !sensitive, clarity: !session, omnisend: !session }
}

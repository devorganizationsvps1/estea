/**
 * In-memory IP rate limiter factory.
 * Each createRateLimiter() call gets its own hits Map (isolated bucket).
 */

import { timingSafeEqual } from "node:crypto"
import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

const CLIENT_IP_HEADER = "x-escay-client-ip"
const PROXY_SECRET_HEADER = "x-escay-proxy-secret"
const IP_RE = /^[0-9A-Fa-f:.]{3,45}$/

function secretMatches(given: unknown): boolean {
  const expected = process.env.STOREFRONT_PROXY_SECRET?.trim()
  if (!expected || typeof given !== "string" || !given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * İstek sınırı anahtarı olan müşteri IP'si.
 *  - Mağaza sunucusu (server action) müşteri adına çağırır: gerçek IP x-escay-client-ip
 *    başlığında gelir; yalnız STOREFRONT_PROXY_SECRET eşleşirse güvenilir.
 *  - Aksi halde req.ip: Medusa "trust proxy 1" ayarlı, yani Traefik'in gördüğü adres.
 *    X-Forwarded-For'un ilk girdisi istemcinin yazabildiği değerdir, kullanılmaz.
 */
export function clientIp(req: MedusaRequest): string {
  const forwardedClient = req.headers[CLIENT_IP_HEADER]
  if (
    typeof forwardedClient === "string" &&
    IP_RE.test(forwardedClient.trim()) &&
    secretMatches(req.headers[PROXY_SECRET_HEADER])
  ) {
    return forwardedClient.trim()
  }
  return req.ip || req.socket?.remoteAddress || "unknown"
}

function clientKey(req: MedusaRequest): string {
  return clientIp(req)
}

export function createRateLimiter(options: {
  name: string
  maxAttempts: number
  windowMs: number
  /** Optional 429 body message (generic — do not include account identifiers). */
  message?: string
}) {
  const hits = new Map<string, number[]>()
  const { maxAttempts, windowMs, name } = options
  const message =
    options.message || "Too many requests. Try again later."

  return function rateLimit(
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction
  ) {
    const key = `${name}:${clientKey(req)}`
    const now = Date.now()
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs)

    if (recent.length >= maxAttempts) {
      hits.set(key, recent)
      res.status(429).json({
        type: "rate_limit",
        message,
      })
      return
    }

    recent.push(now)
    hits.set(key, recent)
    next()
  }
}

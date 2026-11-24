/**
 * Shopside V2 API istemcisi. Tüm uçlar tek adrese form gövdesiyle POST edilir;
 * işlem `process` alanıyla seçilir, oturum `token` alanıyla taşınır.
 */

import type { ShopsideOptions } from "./options"

export type ShopsideTransport = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal?: AbortSignal
  }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

export class ShopsideError extends Error {
  status?: number
  responseBody?: unknown

  constructor(message: string, options?: { status?: number; responseBody?: unknown }) {
    super(message)
    this.name = "ShopsideError"
    this.status = options?.status
    this.responseBody = options?.responseBody
  }
}

export type ShopsideClientOptions = Pick<
  ShopsideOptions,
  "apiKey" | "apiSecret" | "baseUrl" | "timeoutMs"
> & {
  transport?: ShopsideTransport
  logger?: { info: (m: string) => void; warn: (m: string) => void }
}

/** Token ömrü dokümanda yok; kısa tutulur, reddedilirse yeniden giriş yapılır. */
const TOKEN_TTL_MS = 20 * 60 * 1000
const TOKEN_FIELDS = ["token", "access_token", "accessToken"]
const AUTH_ERROR = /token|oturum|yetki|auth|login|unauthor/i

type Params = Record<string, string | number>

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Yanıtta token'ı bulur: üst düzeyde ya da data / result sarmalında. */
export function findToken(body: unknown, depth = 0): string {
  if (!isObject(body) || depth > 2) return ""
  for (const field of TOKEN_FIELDS) {
    const value = body[field]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  for (const value of Object.values(body)) {
    const nested = findToken(value, depth + 1)
    if (nested) return nested
  }
  return ""
}

/**
 * Yanıt başarısızlık bildiriyor mu? Sarmal biçimi dokümanda yok; yaygın biçimler denenir.
 * Tanınmayan biçim hata sayılmaz (satır okuyan taraf ayrıca doğrular).
 */
export function responseError(body: unknown): string {
  if (!isObject(body)) return ""
  const flag = body.status ?? body.success ?? body.result
  const failed =
    flag === false || flag === 0 || flag === "0" || flag === "error" || flag === "fail" || flag === "false"
  const message = [body.message, body.error, body.errorMessage, body.msg].find(
    (m) => typeof m === "string" && m.trim()
  ) as string | undefined
  if (failed) return (message || "Shopside işlemi başarısız").slice(0, 400)
  if (typeof body.error === "string" && body.error.trim()) return body.error.slice(0, 400)
  return ""
}

export class ShopsideClient {
  private readonly options: ShopsideClientOptions
  private readonly transport: ShopsideTransport
  private token_: { value: string; expiresAt: number } | null = null
  requestCount = 0

  constructor(options: ShopsideClientOptions) {
    this.options = options
    // fetch çağrı anında okunur (kurulurken yakalanmaz).
    this.transport =
      options.transport ??
      ((url, init) => (globalThis.fetch as unknown as ShopsideTransport)(url, init))
  }

  private async post(params: Params): Promise<unknown> {
    this.requestCount += 1
    const body = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) body.append(key, String(value))

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs)
    try {
      const res = await this.transport(this.options.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
        signal: controller.signal,
      })
      const text = await res.text()
      let json: unknown
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        throw new ShopsideError(
          `Shopside JSON olmayan yanıt (${res.status}) process=${params.process}: ${text.slice(0, 300)}`,
          { status: res.status, responseBody: text }
        )
      }
      if (!res.ok) {
        throw new ShopsideError(
          `Shopside HTTP ${res.status} process=${params.process}: ${text.slice(0, 300)}`,
          { status: res.status, responseBody: json }
        )
      }
      return json
    } finally {
      clearTimeout(timer)
    }
  }

  async login(): Promise<string> {
    const body = await this.post({
      process: "common/api-login",
      api_key: this.options.apiKey,
      api_secret: this.options.apiSecret,
    })
    const token = findToken(body)
    if (!token) {
      throw new ShopsideError(
        `Shopside girişi başarısız: ${responseError(body) || "yanıtta token yok"}`,
        { responseBody: body }
      )
    }
    this.token_ = { value: token, expiresAt: Date.now() + TOKEN_TTL_MS }
    return token
  }

  private async token(): Promise<string> {
    if (this.token_ && this.token_.expiresAt > Date.now()) return this.token_.value
    return this.login()
  }

  /** Oturumlu çağrı. Token reddedilirse bir kez yeniden giriş yapıp tekrarlar. */
  async call(process: string, params: Params = {}): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const body = await this.post({ process, token: await this.token(), ...params })
      const error = responseError(body)
      if (!error) return body
      if (attempt === 0 && AUTH_ERROR.test(error)) {
        this.token_ = null
        continue
      }
      throw new ShopsideError(`Shopside ${process}: ${error}`, { responseBody: body })
    }
  }

  /** Bağlı platformlar (pazaryeri, e-ticaret, muhasebe, kargo). */
  listApis(): Promise<unknown> {
    return this.call("api/list", { process_type: 1 })
  }

  listProducts(processId?: string): Promise<unknown> {
    return this.call("product/list", processId ? { process_id: processId } : {})
  }

  listOrders(input: { processId?: string; status?: string; page?: number; limit?: number }): Promise<unknown> {
    const params: Params = {}
    if (input.processId) params.process_id = input.processId
    if (input.status) params.order_status = input.status
    if (input.page) params.page = input.page
    if (input.limit) params.limit = input.limit
    return this.call("order/list", params)
  }

  /** Ürünün stoğunu Shopside'da ve bağlı tüm platformlarda günceller. */
  updateStock(productId: string, amount: number): Promise<unknown> {
    return this.call("product/stock", {
      "platforms[all][process_id]": productId,
      "platforms[all][stock_amount]": amount,
    })
  }
}

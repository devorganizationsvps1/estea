/**
 * Paraşüt kimlik doğrulama: OAuth 2.0 Authorization Code + PKCE (Keycloak, id.parasut.com).
 *
 * Paraşüt password grant'i kaldırdı. Akış:
 *  1. Admin "Paraşüt'e bağlan" der → yetkilendirme adresi (state + PKCE) üretilir.
 *  2. Entegrasyon kullanıcısı Paraşüt'te giriş yapıp onaylar → REDIRECT_URI?code=…&state=…
 *  3. Backend code + code_verifier + client_secret ile token alır; refresh token saklanır.
 *  4. Access token (~5 dk) gerektikçe refresh token ile yenilenir. offline_access sayesinde
 *     refresh token kullanıcının Paraşüt oturumundan bağımsızdır; 30 gün kullanılmazsa düşer.
 *
 * Kaynak: https://devhub.parasut.com/oauth-rehberi
 */

import { createHash, randomBytes } from "node:crypto"

import { ParasutError, formatParasutErrorBody, type ParasutTransport } from "./client"

export const PARASUT_OAUTH_SCOPE = "openid offline_access"

export type ParasutTokenResponse = {
  accessToken: string
  refreshToken: string
  /** Access token bitişi (epoch ms) */
  accessExpiresAt: number
  /** Refresh token bitişi (epoch ms); yanıtta yoksa null */
  refreshExpiresAt: number | null
  scope: string | null
}

type OAuthEndpoints = {
  /** Realm kökü, ör. https://id.parasut.com/realms/parasut */
  issuer: string
  clientId: string
  clientSecret: string
  redirectUri: string
}

const base64url = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

/** RFC 7636: 43–128 karakter, [A-Za-z0-9-._~]. 64 bayt → 86 karakter. */
export function createCodeVerifier(): string {
  return base64url(randomBytes(64))
}

export function codeChallengeS256(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest())
}

export function createOAuthState(): string {
  return base64url(randomBytes(32))
}

export function authorizationEndpoint(issuer: string): string {
  return `${issuer.replace(/\/$/, "")}/protocol/openid-connect/auth`
}

export function tokenEndpoint(issuer: string): string {
  return `${issuer.replace(/\/$/, "")}/protocol/openid-connect/token`
}

export function buildAuthorizationUrl(
  cfg: Pick<OAuthEndpoints, "issuer" | "clientId" | "redirectUri">,
  state: string,
  codeVerifier: string
): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: PARASUT_OAUTH_SCOPE,
    state,
    code_challenge: codeChallengeS256(codeVerifier),
    code_challenge_method: "S256",
    // Kimlik sağlayıcı seçimini atla, doğrudan Paraşüt girişi
    kc_idp_hint: "parasut",
  })
  // URLSearchParams boşluğu "+" yapar; rehber %20 istiyor.
  return `${authorizationEndpoint(cfg.issuer)}?${params.toString().replace(/\+/g, "%20")}`
}

/** invalid_grant: refresh token / code artık geçersiz → yeniden yetkilendirme gerekir. */
export class ParasutReauthorizeError extends ParasutError {
  constructor(message: string, responseBody?: unknown, status?: number) {
    super(message, { status, responseBody, retryable: false })
    this.name = "ParasutReauthorizeError"
  }
}

async function postToken(
  transport: ParasutTransport,
  cfg: OAuthEndpoints,
  params: Record<string, string>,
  timeoutMs: number
): Promise<ParasutTokenResponse> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    ...params,
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Awaited<ReturnType<ParasutTransport>>
  try {
    res = await transport(tokenEndpoint(cfg.issuer), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    throw new ParasutError(
      `Paraşüt token yanıtı JSON değil (${res.status}) ${formatParasutErrorBody(text, 300)}`,
      { status: res.status, responseBody: text, retryable: res.status >= 500 }
    )
  }
  const accessToken = typeof json.access_token === "string" ? json.access_token : ""
  const refreshToken = typeof json.refresh_token === "string" ? json.refresh_token : ""
  if (!res.ok || !accessToken) {
    // Token yanıtında sır yok; hata gövdesi (error, error_description) güvenle loglanabilir.
    const error = String(json.error || res.status)
    const description = json.error_description ? ` — ${String(json.error_description)}` : ""
    if (error === "invalid_grant") {
      throw new ParasutReauthorizeError(
        `Paraşüt yetkisi geçersiz (invalid_grant${description}). Admin → Paraşüt sayfasından yeniden bağlanın.`,
        { error: json.error, error_description: json.error_description },
        res.status
      )
    }
    throw new ParasutError(`Paraşüt token alınamadı: ${error}${description}`, {
      status: res.status,
      responseBody: { error: json.error, error_description: json.error_description },
      retryable: res.status === 429 || res.status >= 500,
    })
  }
  const now = Date.now()
  const expiresIn = Number(json.expires_in)
  const refreshExpiresIn = Number(json.refresh_expires_in)
  return {
    accessToken,
    // Yenilemede yeni refresh token gelmezse eskisi geçerli kalır; çağıran birleştirir.
    refreshToken,
    // Süre yanıttan okunur (rehber: sabit varsaymayın). Yoksa 5 dk.
    accessExpiresAt: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 300) * 1000,
    // 0 = süresiz (Keycloak offline token'da sıfır dönebilir)
    refreshExpiresAt:
      Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0
        ? now + refreshExpiresIn * 1000
        : null,
    scope: typeof json.scope === "string" ? json.scope : null,
  }
}

export async function exchangeAuthorizationCode(
  transport: ParasutTransport,
  cfg: OAuthEndpoints,
  input: { code: string; codeVerifier: string },
  timeoutMs = 30000
): Promise<ParasutTokenResponse> {
  const token = await postToken(
    transport,
    cfg,
    {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: cfg.redirectUri,
      code_verifier: input.codeVerifier,
    },
    timeoutMs
  )
  if (!token.refreshToken) {
    throw new ParasutError(
      "Paraşüt refresh token vermedi (offline_access onaylanmadı mı?). Bağlantı kalıcı olmaz.",
      { retryable: false }
    )
  }
  return token
}

export async function refreshAccessToken(
  transport: ParasutTransport,
  cfg: OAuthEndpoints,
  refreshToken: string,
  timeoutMs = 30000
): Promise<ParasutTokenResponse> {
  const token = await postToken(
    transport,
    cfg,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    timeoutMs
  )
  return { ...token, refreshToken: token.refreshToken || refreshToken }
}

import { createHash } from "node:crypto"

import type { ParasutTransport } from "../client"
import {
  ParasutReauthorizeError,
  buildAuthorizationUrl,
  codeChallengeS256,
  createCodeVerifier,
  exchangeAuthorizationCode,
  refreshAccessToken,
  tokenEndpoint,
} from "../oauth"
import { normalizeOptions } from "../options"

const cfg = {
  issuer: "https://id.parasut.com/realms/parasut",
  clientId: "cid",
  clientSecret: "secret",
  redirectUri: "https://api.esteacay.com/parasut/oauth/callback",
}

function transportReplying(status: number, body: unknown) {
  const calls: { url: string; form: URLSearchParams }[] = []
  const transport: ParasutTransport = async (url, init) => {
    calls.push({ url, form: new URLSearchParams(init.body || "") })
    return { ok: status < 300, status, text: async () => JSON.stringify(body) }
  }
  return { transport, calls }
}

describe("PKCE", () => {
  it("verifier RFC 7636 karakter kümesinde ve 43–128 uzunlukta, challenge S256 base64url", () => {
    const v = createCodeVerifier()
    expect(v).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/)
    const expected = createHash("sha256").update(v).digest("base64url")
    expect(codeChallengeS256(v)).toBe(expected)
    expect(codeChallengeS256(v)).not.toContain("=")
  })
})

describe("buildAuthorizationUrl", () => {
  it("Paraşüt rehberindeki parametreler, scope %20 ile", () => {
    const url = buildAuthorizationUrl(cfg, "st", "ver")
    expect(url.startsWith("https://id.parasut.com/realms/parasut/protocol/openid-connect/auth?")).toBe(true)
    expect(url).toContain("scope=openid%20offline_access")
    const q = new URL(url).searchParams
    expect(q.get("client_id")).toBe("cid")
    expect(q.get("redirect_uri")).toBe(cfg.redirectUri)
    expect(q.get("response_type")).toBe("code")
    expect(q.get("state")).toBe("st")
    expect(q.get("code_challenge")).toBe(codeChallengeS256("ver"))
    expect(q.get("code_challenge_method")).toBe("S256")
    expect(q.get("kc_idp_hint")).toBe("parasut")
  })
})

describe("token istekleri", () => {
  it("code değişimi: verifier + redirect_uri + client_secret; süreler yanıttan", async () => {
    const { transport, calls } = transportReplying(200, {
      access_token: "a1",
      refresh_token: "r1",
      expires_in: 300,
      refresh_expires_in: 2592000,
      scope: "openid offline_access",
    })
    const before = Date.now()
    const t = await exchangeAuthorizationCode(transport, cfg, { code: "c", codeVerifier: "v" })
    expect(calls[0].url).toBe(tokenEndpoint(cfg.issuer))
    expect(Object.fromEntries(calls[0].form)).toEqual({
      client_id: "cid",
      client_secret: "secret",
      grant_type: "authorization_code",
      code: "c",
      redirect_uri: cfg.redirectUri,
      code_verifier: "v",
    })
    expect(t.accessToken).toBe("a1")
    expect(t.refreshToken).toBe("r1")
    expect(t.accessExpiresAt).toBeGreaterThanOrEqual(before + 300_000)
    expect(t.refreshExpiresAt).toBeGreaterThanOrEqual(before + 2592000_000)
  })

  it("refresh token gelmezse bağlantı kurulmaz (offline_access yok)", async () => {
    const { transport } = transportReplying(200, { access_token: "a1", expires_in: 300 })
    await expect(
      exchangeAuthorizationCode(transport, cfg, { code: "c", codeVerifier: "v" })
    ).rejects.toThrow(/refresh token/)
  })

  it("yenileme: yeni refresh token gelirse o, gelmezse eskisi", async () => {
    const rotated = transportReplying(200, { access_token: "a2", refresh_token: "r2", expires_in: 300 })
    expect((await refreshAccessToken(rotated.transport, cfg, "r1")).refreshToken).toBe("r2")
    expect(Object.fromEntries(rotated.calls[0].form)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "r1",
    })
    const same = transportReplying(200, { access_token: "a2", expires_in: 300 })
    expect((await refreshAccessToken(same.transport, cfg, "r1")).refreshToken).toBe("r1")
  })

  it("invalid_grant yeniden yetkilendirme hatası, tekrar denenmez", async () => {
    const { transport } = transportReplying(400, {
      error: "invalid_grant",
      error_description: "Offline user session not found",
    })
    const err = await refreshAccessToken(transport, cfg, "r1").catch((e) => e)
    expect(err).toBeInstanceOf(ParasutReauthorizeError)
    expect(err.retryable).toBe(false)
    expect(err.message).toContain("yeniden bağlanın")
  })

  it("5xx tekrar denenebilir", async () => {
    const { transport } = transportReplying(503, { error: "unavailable" })
    const err = await refreshAccessToken(transport, cfg, "r1").catch((e) => e)
    expect(err).not.toBeInstanceOf(ParasutReauthorizeError)
    expect(err.retryable).toBe(true)
  })
})

describe("ortam ayarları", () => {
  it("boş = prod; staging/test → staging kimlik sunucusu; geri dönüş backend adresinden", () => {
    const prev = process.env.MEDUSA_BACKEND_PUBLIC_URL
    process.env.MEDUSA_BACKEND_PUBLIC_URL = "https://api.esteacay.com/"
    expect(normalizeOptions({}).oauthIssuer).toBe("https://id.parasut.com/realms/parasut")
    expect(normalizeOptions({ env: "staging" }).oauthIssuer).toBe(
      "https://id-staging.parasut.com/realms/parasut"
    )
    expect(normalizeOptions({ env: "test" }).env).toBe("staging")
    expect(normalizeOptions({}).redirectUri).toBe("https://api.esteacay.com/parasut/oauth/callback")
    expect(normalizeOptions({ redirectUri: "http://localhost:9000/x" }).redirectUri).toBe(
      "http://localhost:9000/x"
    )
    expect(normalizeOptions({}).eInvoiceScenario).toBe("basic")
    if (prev === undefined) delete process.env.MEDUSA_BACKEND_PUBLIC_URL
    else process.env.MEDUSA_BACKEND_PUBLIC_URL = prev
  })
})

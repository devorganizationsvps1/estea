/**
 * Paraşüt OAuth bağlantısı gerçek Postgres'te: migration, state doğrulama, token saklama,
 * kilit altında yenileme (eşzamanlı istekler tek yenileme), invalid_grant ile düşme.
 *
 * Çalıştırma: DB_HOST=localhost DB_PORT=5433 DB_USERNAME=medusa DB_PASSWORD=medusa \
 *   npm run test:integration:modules -- src/modules/parasut/__tests__/connection.integration.spec.ts
 */
import path from "node:path"

import { moduleIntegrationTestRunner } from "@medusajs/test-utils"

import type { ParasutTransport } from "../client"
import ParasutConnection from "../models/parasut-connection"
import ParasutModuleService from "../service"

jest.setTimeout(60_000)

type OAuthReply = { status: number; body: Record<string, unknown> }

/** id.parasut.com + api.parasut.com sahtesi */
function fakeParasut(service: ParasutModuleService) {
  const tokenCalls: URLSearchParams[] = []
  let tokenReply: () => OAuthReply = () => ({
    status: 200,
    body: { access_token: "a1", refresh_token: "r1", expires_in: 300, refresh_expires_in: 2592000 },
  })
  let companies = ["42"]
  const apiCalls: { url: string; auth: string }[] = []
  let apiStatus = 200

  service.oauthTransport_ = (async (url, init) => {
    tokenCalls.push(new URLSearchParams(init.body || ""))
    // Eşzamanlı yenilemeler gerçekten çakışsın
    await new Promise((r) => setTimeout(r, 50))
    const reply = tokenReply()
    return { ok: reply.status < 300, status: reply.status, text: async () => JSON.stringify(reply.body) }
  }) as ParasutTransport

  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init: { headers: Record<string, string> }) => {
    apiCalls.push({ url, auth: init.headers.Authorization })
    const body = url.includes("/me")
      ? { data: { id: "u1" }, included: companies.map((id) => ({ id, type: "companies" })) }
      : { data: [] }
    const status = apiStatus
    apiStatus = 200
    return { ok: status < 300, status, text: async () => JSON.stringify(body) }
  }) as never

  return {
    tokenCalls,
    apiCalls,
    setTokenReply: (fn: () => OAuthReply) => (tokenReply = fn),
    setCompanies: (ids: string[]) => (companies = ids),
    failNextApiWith: (status: number) => (apiStatus = status),
    restore: () => (globalThis.fetch = realFetch),
  }
}

async function connect(service: ParasutModuleService) {
  const { url } = await service.startAuthorization("user_admin")
  const state = new URL(url).searchParams.get("state")!
  await service.completeAuthorization({ code: "code-1", state, iss: "https://id.parasut.com/realms/parasut" })
  return state
}

// Koşucunun verdiği proxy alan atamasını ve `this`i gerçek servise iletmez; gerçek örnek.
let service: ParasutModuleService

moduleIntegrationTestRunner<ParasutModuleService>({
  moduleName: "parasut",
  resolve: path.join(__dirname, ".."),
  moduleModels: [ParasutConnection],
  // Şema modelden değil elle yazılan migration'dan kurulsun (canlıda o çalışır)
  pathToMigrations: path.join(__dirname, "../migrations"),
  hooks: {
    afterModuleInit: async (_app, svc) => {
      service = svc
    },
  },
  moduleOptions: {
    clientId: "cid",
    clientSecret: "secret",
    companyId: "42",
    redirectUri: "http://localhost:9000/parasut/oauth/callback",
  },
  testSuite: () => {
    let fake: ReturnType<typeof fakeParasut>

    beforeEach(() => {
      fake = fakeParasut(service)
      // Süreç önbelleği testler arasında taşınmasın
      ;(service as unknown as { access_: unknown }).access_ = null
    })
    afterEach(() => fake.restore())

    it("bağlanmadan çağrı açık hata verir", async () => {
      expect(await service.isConnected()).toBe(false)
      await expect(service.getAccessToken()).rejects.toThrow(/bağlantısı yok/)
    })

    it("state + PKCE ile bağlanır, firma erişimi doğrulanır, token saklanır", async () => {
      await connect(service)
      const exchange = fake.tokenCalls[0]
      expect(exchange.get("grant_type")).toBe("authorization_code")
      expect(exchange.get("code")).toBe("code-1")
      expect(exchange.get("code_verifier")).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/)
      expect(exchange.get("redirect_uri")).toBe("http://localhost:9000/parasut/oauth/callback")
      expect(fake.apiCalls[0].url).toBe("https://api.parasut.com/v4/me?include=companies")

      const status = await service.getAuthorizationStatus()
      expect(status).toMatchObject({ connected: true, stale: false, connectedBy: "user_admin", lastError: null })
      expect(await service.getAccessToken()).toBe("a1")
      // Geçerli token için yenileme yok
      expect(fake.tokenCalls.length).toBe(1)
    })

    it("yanlış state reddedilir; doğru state tek kullanımlık", async () => {
      const { url } = await service.startAuthorization("user_admin")
      const state = new URL(url).searchParams.get("state")!
      await expect(
        service.completeAuthorization({ code: "c", state: state + "x" })
      ).rejects.toThrow(/geçersiz/)
      expect(fake.tokenCalls.length).toBe(0)
      // Yanlış istek bekleyen yetkilendirmeyi bozmaz (dışarıdan çöp istekle iptal edilemesin)
      await service.completeAuthorization({ code: "c", state })
      expect(fake.tokenCalls.length).toBe(1)
      // Aynı state ikinci kez kullanılamaz
      await expect(service.completeAuthorization({ code: "c", state })).rejects.toThrow(/geçersiz/)
      expect(fake.tokenCalls.length).toBe(1)
    })

    it("süresi dolan bekleyen yetkilendirme reddedilir", async () => {
      const { url } = await service.startAuthorization("user_admin")
      const state = new URL(url).searchParams.get("state")!
      await (service as any).repo_().transaction((m: any) =>
        m.execute(`update parasut_connection set pending_expires_at = now() - interval '1 second' where id = 'default'`)
      )
      await expect(service.completeAuthorization({ code: "c", state })).rejects.toThrow(/süresi doldu/)
    })

    it("başka ortamın bağlantısı kullanılmaz", async () => {
      await connect(service)
      await (service as any).repo_().transaction((m: any) =>
        m.execute(`update parasut_connection set env = 'staging' where id = 'default'`)
      )
      ;(service as unknown as { access_: unknown }).access_ = null
      expect(await service.getAuthorizationStatus()).toMatchObject({ connected: false, stale: true })
      await expect(service.getAccessToken()).rejects.toThrow(/başka bir istemci\/ortam/)
    })

    it("başka firmaya erişen kullanıcıyla bağlantı kurulmaz", async () => {
      await service.disconnect()
      fake.setCompanies(["7"])
      await expect(connect(service)).rejects.toThrow(/42 numaralı firmaya erişemiyor/)
      expect((await service.getAuthorizationStatus()).connected).toBe(false)
    })

    it("süresi dolan token kilit altında bir kez yenilenir; dönen refresh token saklanır", async () => {
      await connect(service)
      // Access token'ın süresi doldu (DB + süreç)
      await (service as any).repo_().transaction((m: any) =>
        m.execute(`update parasut_connection set access_expires_at = now() - interval '1 minute' where id = 'default'`)
      )
      ;(service as unknown as { access_: unknown }).access_ = null
      let n = 0
      fake.setTokenReply(() => {
        n += 1
        return { status: 200, body: { access_token: `a${n + 1}`, refresh_token: `r${n + 1}`, expires_in: 300 } }
      })
      const before = fake.tokenCalls.length
      const tokens = await Promise.all([service.getAccessToken(), service.getAccessToken(), service.getAccessToken()])
      expect(new Set(tokens).size).toBe(1)
      expect(fake.tokenCalls.length - before).toBe(1)
      expect(fake.tokenCalls.at(-1)!.get("grant_type")).toBe("refresh_token")
      expect(fake.tokenCalls.at(-1)!.get("refresh_token")).toBe("r1")

      // İkinci süreç: önbelleği yok, DB'deki taze token'ı kullanır (yenilemez)
      ;(service as unknown as { access_: unknown }).access_ = null
      expect(await service.getAccessToken()).toBe(tokens[0])
      expect(fake.tokenCalls.length - before).toBe(1)
    })

    it("401 alan token bir kez yenilenir ve istek tekrarlanır", async () => {
      await connect(service)
      fake.setTokenReply(() => ({ status: 200, body: { access_token: "fresh", refresh_token: "r9", expires_in: 300 } }))
      fake.failNextApiWith(401)
      const ids = await service.getClient().listAccessibleCompanyIds()
      expect(ids).toEqual(["42"])
      expect(fake.apiCalls.slice(-2).map((c) => c.auth)).toEqual(["Bearer a1", "Bearer fresh"])
    })

    it("invalid_grant bağlantıyı düşürür ve sebebi kaydeder", async () => {
      await connect(service)
      ;(service as unknown as { access_: unknown }).access_ = null
      await (service as any).repo_().transaction((m: any) =>
        m.execute(`update parasut_connection set access_expires_at = now() - interval '1 minute' where id = 'default'`)
      )
      fake.setTokenReply(() => ({ status: 400, body: { error: "invalid_grant", error_description: "Token is not active" } }))
      await expect(service.getAccessToken()).rejects.toThrow(/yeniden bağlanın/)
      const status = await service.getAuthorizationStatus()
      expect(status.connected).toBe(false)
      expect(status.lastError).toContain("invalid_grant")
    })

    it("bağlantıyı kes", async () => {
      await connect(service)
      await service.disconnect()
      expect(await service.isConnected()).toBe(false)
    })
  },
})

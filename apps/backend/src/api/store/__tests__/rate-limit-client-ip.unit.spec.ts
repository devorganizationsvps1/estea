import { clientIp, createRateLimiter } from "../_rate-limit"

const SECRET = "s3cr3t-proxy-value-for-tests-0123456789"

function req(headers: Record<string, string>, ip = "10.0.0.5") {
  return { headers, ip } as never
}

describe("clientIp (istek sınırı anahtarı)", () => {
  const prev = process.env.STOREFRONT_PROXY_SECRET
  beforeEach(() => {
    process.env.STOREFRONT_PROXY_SECRET = SECRET
  })
  afterAll(() => {
    process.env.STOREFRONT_PROXY_SECRET = prev
  })

  it("X-Forwarded-For'un ilk girdisine güvenmez (istemci yazabilir)", () => {
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4, 10.0.0.5" }))).toBe("10.0.0.5")
  })

  it("sır eşleşirse mağazanın ilettiği müşteri IP'si kullanılır", () => {
    expect(
      clientIp(req({ "x-escay-client-ip": "88.1.2.3", "x-escay-proxy-secret": SECRET }))
    ).toBe("88.1.2.3")
  })

  it.each([
    ["yanlış sır", { "x-escay-client-ip": "88.1.2.3", "x-escay-proxy-secret": "nope" }],
    ["sır yok", { "x-escay-client-ip": "88.1.2.3" }],
    ["geçersiz IP", { "x-escay-client-ip": "<script>", "x-escay-proxy-secret": SECRET }],
  ])("%s → req.ip", (_label, headers) => {
    expect(clientIp(req(headers as Record<string, string>))).toBe("10.0.0.5")
  })

  it("sunucuda sır tanımsızsa başlık yok sayılır", () => {
    process.env.STOREFRONT_PROXY_SECRET = ""
    expect(
      clientIp(req({ "x-escay-client-ip": "88.1.2.3", "x-escay-proxy-secret": "" }))
    ).toBe("10.0.0.5")
  })

  it("mağaza üzerinden gelen müşteriler ayrı sayaç kullanır", () => {
    const limit = createRateLimiter({ name: "t", maxAttempts: 1, windowMs: 60_000 })
    const run = (ip: string) => {
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }
      const next = jest.fn()
      limit(req({ "x-escay-client-ip": ip, "x-escay-proxy-secret": SECRET }) as never, res as never, next)
      return next.mock.calls.length === 1
    }
    expect(run("88.1.1.1")).toBe(true)
    expect(run("88.1.1.1")).toBe(false)
    expect(run("88.2.2.2")).toBe(true)
  })
})

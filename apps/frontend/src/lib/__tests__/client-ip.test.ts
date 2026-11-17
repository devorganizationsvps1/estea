import { afterEach, describe, expect, it } from "vitest"
import { clientIpFrom, clientIpHeadersFrom, needsClientIp } from "../client-ip"

const h = (o: Record<string, string>) => (name: string) => o[name] ?? null

describe("clientIpFrom", () => {
  it("X-Real-Ip öncelikli, yoksa X-Forwarded-For ilk girdi", () => {
    expect(clientIpFrom(h({ "x-real-ip": "88.1.1.1", "x-forwarded-for": "9.9.9.9" }))).toBe("88.1.1.1")
    expect(clientIpFrom(h({ "x-forwarded-for": "88.2.2.2, 10.0.0.1" }))).toBe("88.2.2.2")
    expect(clientIpFrom(h({ "x-forwarded-for": "not an ip" }))).toBeUndefined()
  })
})

describe("clientIpHeadersFrom", () => {
  const prev = process.env.STOREFRONT_PROXY_SECRET
  afterEach(() => {
    process.env.STOREFRONT_PROXY_SECRET = prev
  })

  it("sır yoksa başlık eklenmez", () => {
    process.env.STOREFRONT_PROXY_SECRET = ""
    expect(clientIpHeadersFrom(h({ "x-real-ip": "88.1.1.1" }))).toEqual({})
  })

  it("sır + IP varsa iki başlık", () => {
    process.env.STOREFRONT_PROXY_SECRET = "abc"
    expect(clientIpHeadersFrom(h({ "x-real-ip": "88.1.1.1" }))).toEqual({
      "x-escay-client-ip": "88.1.1.1",
      "x-escay-proxy-secret": "abc",
    })
  })
})

describe("needsClientIp", () => {
  it.each([
    "/auth/customer/emailpass",
    "/auth/customer/emailpass/register",
    "/auth/customer/emailpass/reset-password",
    "/auth/customer/emailpass/update",
    "/auth/verification/request",
    "/store/orders/lookup",
    "/store/returns/guest",
    "/store/returns/request",
    "/store/returns/exchange-options",
    "/store/paytr-checkout/register",
    "/store/paytr-checkout/status?oid=x",
    "/store/contact",
    "/store/customers/me/password",
    "https://api.esteacay.com/store/orders/lookup",
  ])("sınırlı uç: %s", (p) => {
    expect(needsClientIp(p)).toBe(true)
  })

  it.each(["/store/products", "/store/carts/cart_1", "/store/orders/order_1", "/auth/session", undefined])(
    "katalog / diğer: %s",
    (p) => {
      expect(needsClientIp(p)).toBe(false)
    }
  )
})

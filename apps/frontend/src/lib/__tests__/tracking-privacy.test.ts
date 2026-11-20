import { describe, expect, it } from "vitest"
import {
  blocksSessionTracking,
  isSensitiveUrl,
  maskPath,
  maskUrl,
  trackerPolicy,
} from "../tracking-privacy"

const O = "https://market.esteacay.com"

describe("isSensitiveUrl", () => {
  it.each([
    "/reset-password?token=abc&email=a%40b.com",
    "/verify-email?token=abc&email=a%40b.com",
    "/order-tracking/order_01?email=a%40b.com",
    "/order-tracking?order=1001&email=a%40b.com",
    "/odeme/payment/tok_123",
    "/odeme/payment-result?status=success&oid=ES123",
    "/urun-kategori?Email=a%40b.com",
    "/?code=XYZ",
  ])("%s hassas", (path) => {
    expect(isSensitiveUrl(O + path)).toBe(true)
  })

  it.each(["/", "/urun/siyah-cay", "/odeme", "/sepet?utm_source=mail", "/order-trackingx"])(
    "%s hassas değil",
    (path) => {
      expect(isSensitiveUrl(O + path)).toBe(false)
    }
  )

  it("ayrıştırılamayan adres hassas sayılır", () => {
    expect(isSensitiveUrl("not a url")).toBe(true)
  })
})

describe("blocksSessionTracking", () => {
  it("sipariş onayı ve hesabım ekranında oturum kaydı yok", () => {
    expect(blocksSessionTracking(O + "/odeme/confirmation/order_01")).toBe(true)
    expect(blocksSessionTracking(O + "/hesabim/orders/order_01")).toBe(true)
    expect(blocksSessionTracking(O + "/reset-password?token=x")).toBe(true)
    expect(blocksSessionTracking(O + "/urun/siyah-cay")).toBe(false)
  })
})

describe("trackerPolicy", () => {
  it("kimlik taşıyan sayfada Pixel, Clarity, Omnisend kapalı", () => {
    expect(trackerPolicy(O + "/reset-password?token=x&email=y")).toEqual({
      gtag: true,
      pixel: false,
      clarity: false,
      omnisend: false,
    })
  })

  it("onay sayfasında satın alma için Pixel açık, oturum kaydı kapalı", () => {
    expect(trackerPolicy(O + "/odeme/confirmation/order_01")).toEqual({
      gtag: true,
      pixel: true,
      clarity: false,
      omnisend: false,
    })
  })

  it("normal sayfada hepsi açık", () => {
    expect(trackerPolicy(O + "/urun/siyah-cay")).toEqual({
      gtag: true,
      pixel: true,
      clarity: true,
      omnisend: true,
    })
  })
})

describe("maskUrl / maskPath", () => {
  it("hassas sayfada dinamik parça ve sorgu atılır", () => {
    expect(maskUrl(O + "/order-tracking/order_01?email=a%40b.com")).toBe(O + "/order-tracking")
    expect(maskUrl(O + "/reset-password?token=abc&email=a%40b.com")).toBe(O + "/reset-password")
    expect(maskUrl(O + "/odeme/payment/tok_123")).toBe(O + "/odeme/payment")
    expect(maskUrl(O + "/odeme/payment-result?status=success&oid=ES1")).toBe(
      O + "/odeme/payment-result"
    )
  })

  it("diğer sayfada yalnız email/token/code değeri maskelenir, utm kalır", () => {
    const out = new URL(maskUrl(O + "/sepet?utm_source=mail&EMAIL=a%40b.com&code=1#x"))
    expect(out.pathname).toBe("/sepet")
    expect(out.searchParams.get("utm_source")).toBe("mail")
    expect(out.searchParams.get("EMAIL")).toBe("redacted")
    expect(out.searchParams.get("code")).toBe("redacted")
    expect(out.hash).toBe("")
  })

  it("onay sayfasında sipariş kimliği atılır", () => {
    expect(maskUrl(O + "/odeme/confirmation/order_01")).toBe(O + "/odeme/confirmation")
    expect(maskPath("/hesabim/orders/order_01")).toBe("/hesabim")
    expect(maskPath("/urun/siyah-cay")).toBe("/urun/siyah-cay")
  })

  it("ayrıştırılamayan adres boş döner", () => {
    expect(maskUrl("::")).toBe("")
  })
})

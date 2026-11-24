import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { PARASUT_MODULE } from "../../modules/parasut"
import ParasutModuleService from "../../modules/parasut/service"
import {
  issueSalesInvoiceForOrder,
  shippingVatRateOf,
  totalDriftAllowed,
} from "../parasut-invoice"
import { issueRefundInvoiceForReturn } from "../parasut-refund-invoice"
import {
  notifyParasutInvoiceProblem,
  notifyRefundInvoiceProblem,
} from "../parasut-invoice-admin-notify"
import { sendInvoiceIssuedEmail } from "../parasut-invoice-email"
import { recordOpsEvent } from "../ops-events"

jest.mock("../parasut-invoice-admin-notify", () => ({
  notifyParasutInvoiceProblem: jest.fn().mockResolvedValue({ sent: true }),
  notifyRefundInvoiceProblem: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("../parasut-invoice-email", () => ({
  sendInvoiceIssuedEmail: jest.fn().mockResolvedValue({ sent: true }),
}))
jest.mock("../ops-events", () => ({
  recordOpsEvent: jest.fn().mockResolvedValue(undefined),
}))

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
const realFetch = globalThis.fetch

type FakeOrder = Record<string, unknown> & { metadata: Record<string, unknown> | null }
type Call = { method: string; path: string; body: any }
type Reply = { status: number; body: unknown } | "network-error"

const LIVE = {
  clientId: "cid",
  clientSecret: "secret",
  username: "user@escay.test",
  password: "pass",
  companyId: "42",
  maxRetries: 2,
}

function baseOrder(overrides: Partial<FakeOrder> = {}): FakeOrder {
  return {
    id: "order_1",
    display_id: 1,
    status: "pending",
    email: "ayse@example.com",
    currency_code: "try",
    metadata: null,
    total: 184.9,
    discount_total: 0,
    shipping_total: 149.9,
    items: [
      {
        id: "item_1",
        title: "Papatya Çayı",
        detail: { quantity: 1 },
        unit_price: 35,
        is_tax_inclusive: true,
        variant_sku: "ESC-PAPATYA-BP",
        variant_id: "var_1",
        discount_total: 0,
        tax_lines: [{ rate: 1 }],
      },
    ],
    shipping_methods: [{ tax_lines: [{ rate: 20 }] }],
    payment_collections: [
      { payments: [{ captures: [{ amount: 184.9, created_at: "2026-11-20T09:00:00Z" }], refunds: [] }] },
    ],
    shipping_address: {
      first_name: "Ayşe",
      last_name: "Yılmaz",
      phone: "+905000000000",
      city: "Sakarya",
      address_1: "Yeni Mah. 1",
      metadata: { district: "Adapazarı" },
    },
    customer: { id: "cus_1", email: "ayse@example.com" },
    ...overrides,
  }
}

function makeScope(
  order: FakeOrder,
  options: Record<string, unknown> = LIVE,
  returnMeta: Record<string, unknown> | null = null
) {
  const service = new ParasutModuleService({ logger } as never, options)
  const scope = {
    resolve: (key: string) => {
      switch (key) {
        case ContainerRegistrationKeys.LOGGER:
          return logger
        case ContainerRegistrationKeys.QUERY:
          return {
            graph: async ({ entity }: { entity: string }) =>
              entity === "return"
                ? { data: [{ id: "ret_1", metadata: returnMeta }] }
                : entity === "product_variant"
                  ? { data: [] }
                  : { data: [order] },
          }
        case Modules.LOCKING:
          return { execute: (_k: string, job: () => unknown) => job() }
        case Modules.ORDER:
          return {
            updateOrders: async ([u]: { metadata: Record<string, unknown> }[]) => {
              order.metadata = u.metadata
            },
          }
        case PARASUT_MODULE:
          return service
        default:
          throw new Error(`unexpected resolve ${key}`)
      }
    },
  }
  return { scope: scope as never, service }
}

/** Paraşüt API'sini sahteler. `overrides` belirli uçların yanıtını değiştirir. */
function mockParasut(overrides: Partial<Record<string, Reply | (() => Reply)>> = {}) {
  const calls: Call[] = []
  const defaults: Record<string, Reply> = {
    "POST /oauth/token": { status: 200, body: { access_token: "tok", expires_in: 7200 } },
    "GET /42/contacts": { status: 200, body: { data: [] } },
    "POST /42/contacts": { status: 201, body: { data: { id: "c1" } } },
    "GET /42/products": {
      status: 200,
      body: {
        data: [
          { id: "p1", attributes: { code: "ESC-PAPATYA-BP", name: "Papatya Çayı" } },
          { id: "p9", attributes: { code: "KARGO", name: "Kargo" } },
        ],
      },
    },
    "POST /42/sales_invoices": { status: 201, body: { data: { id: "inv1" } } },
    "GET /42/e_invoice_inboxes": { status: 200, body: { data: [] } },
    "POST /42/e_archives": {
      status: 201,
      body: { data: { id: "ea1", attributes: { invoice_no: "ESC2026000000001" } } },
    },
    "POST /42/e_invoices": {
      status: 201,
      body: { data: { id: "ei1", attributes: { invoice_no: "ESF2026000000001" } } },
    },
    "GET /42/sales_invoices/inv1": {
      status: 200,
      body: { data: { attributes: { pdf_url: "https://parasut.test/inv1.pdf" } } },
    },
  }
  const fn = jest.fn(async (url: string, init: { method: string; body?: string }) => {
    const u = new URL(url)
    const path = u.pathname.replace(/^\/v4/, "")
    let body: any = init.body
    try {
      body = init.body ? JSON.parse(init.body) : undefined
    } catch {
      /* form gövdesi */
    }
    calls.push({ method: init.method, path, body })
    const key = `${init.method} ${path}`
    const picked = overrides[key] ?? defaults[key]
    const reply = typeof picked === "function" ? picked() : picked
    if (!reply) throw new Error(`Beklenmeyen istek: ${key}`)
    if (reply === "network-error") throw new TypeError("fetch failed")
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: async () => JSON.stringify(reply.body),
    }
  })
  globalThis.fetch = fn as never
  const count = (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key).length
  return { calls, count }
}

const invoiceOf = (order: FakeOrder) =>
  order.metadata?.parasut_invoice as Record<string, unknown>

const ENV_KEYS = ["PAYTR_OID_PREFIX", "PARASUT_DRY_RUN", "PARASUT_REFUND_INVOICE_AUTO"]
const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
})
beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  jest.clearAllMocks()
})
afterAll(() => {
  globalThis.fetch = realFetch
  for (const key of ENV_KEYS) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key]
  }
})

describe("issueSalesInvoiceForOrder", () => {
  it("başarı: satış faturası + e-arşiv, ikinci çağrı istek atmaz", async () => {
    const order = baseOrder()
    const { scope } = makeScope(order)
    const api = mockParasut()

    const first = await issueSalesInvoiceForOrder(scope, "order_1")
    expect(first.ok).toBe(true)
    expect(invoiceOf(order)).toMatchObject({
      status: "issued",
      mode: "live",
      contact_id: "c1",
      invoice_id: "inv1",
      formal_id: "ea1",
      invoice_number: "ESC2026000000001",
      invoice_type: "e_archive",
      pdf_url: "https://parasut.test/inv1.pdf",
      total: 184.9,
      items: [{ line_item_id: "item_1", quantity: 1 }],
    })
    expect(sendInvoiceIssuedEmail).toHaveBeenCalledTimes(1)

    const before = api.calls.length
    const second = await issueSalesInvoiceForOrder(scope, "order_1")
    expect(second.skipped).toBe(true)
    expect(api.calls.length).toBe(before)
    expect(notifyParasutInvoiceProblem).not.toHaveBeenCalled()
  })

  it("gövde: KDV hariç birim fiyat, ürün bağlantısı, kargo satırı, TRL, ödeme tarihi", async () => {
    const order = baseOrder()
    const { scope } = makeScope(order)
    const api = mockParasut()
    await issueSalesInvoiceForOrder(scope, "order_1")

    const sales = api.calls.find((c) => c.method === "POST" && c.path === "/42/sales_invoices")!
    expect(sales.body.data.attributes).toMatchObject({ currency: "TRL", order_no: "100001" })
    const [tea, shipping] = sales.body.data.relationships.details.data
    // 35,00 KDV dahil, %1 → 34,65 net
    expect(tea.attributes).toMatchObject({ quantity: 1, unit_price: 34.65, vat_rate: 1 })
    expect(tea.relationships.product.data.id).toBe("p1")
    // 149,90 KDV dahil, %20 → 124,92 net
    expect(shipping.attributes).toMatchObject({ quantity: 1, unit_price: 124.92, vat_rate: 20 })
    expect(shipping.relationships.product.data.id).toBe("p9")

    const archive = api.calls.find((c) => c.path === "/42/e_archives")!
    expect(archive.body.data.attributes.internet_sale).toMatchObject({
      payment_type: "KREDIKARTI/BANKAKARTI",
      payment_platform: "PayTR",
      payment_date: "2026-11-20",
    })
  })

  it("kurumsal: vergi numarasıyla cari aranır, e-fatura mükellefine e-fatura kesilir", async () => {
    const order = baseOrder({
      billing_address: {
        first_name: "Ali",
        last_name: "Kaya",
        city: "İstanbul",
        address_1: "Bir Sk. 2",
        metadata: {
          invoice_type: "corporate",
          vkn: "1234567890",
          company_name: "Kaya Gıda A.Ş.",
          tax_office: "Kadıköy",
        },
      },
    })
    const { scope } = makeScope(order)
    const api = mockParasut({
      "GET /42/e_invoice_inboxes": { status: 200, body: { data: [{ id: "x" }] } },
    })
    await issueSalesInvoiceForOrder(scope, "order_1")

    const contact = api.calls.find((c) => c.method === "POST" && c.path === "/42/contacts")!
    expect(contact.body.data.attributes).toMatchObject({
      name: "Kaya Gıda A.Ş.",
      tax_number: "1234567890",
      tax_office: "Kadıköy",
    })
    expect(api.count("POST /42/e_invoices")).toBe(1)
    expect(api.count("POST /42/e_archives")).toBe(0)
    expect(invoiceOf(order)).toMatchObject({ status: "issued", invoice_type: "e_invoice" })
  })

  it("satış faturası 5xx: belirsiz, kör tekrar yok, onaysız yeniden gitmez", async () => {
    const order = baseOrder()
    const { scope } = makeScope(order)
    const api = mockParasut({ "POST /42/sales_invoices": { status: 502, body: { error: "bad gateway" } } })

    const first = await issueSalesInvoiceForOrder(scope, "order_1")
    expect(first.ok).toBe(false)
    expect(invoiceOf(order)).toMatchObject({ status: "unknown", note: "sales_invoice_result_unknown" })
    expect(api.count("POST /42/sales_invoices")).toBe(1)
    expect(notifyParasutInvoiceProblem).toHaveBeenCalledTimes(1)
    expect(recordOpsEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "invoice.failed" })
    )

    const second = await issueSalesInvoiceForOrder(scope, "order_1")
    expect(second).toMatchObject({ ok: false, skipped: true })
    expect(api.count("POST /42/sales_invoices")).toBe(1)

    mockParasut()
    const third = await issueSalesInvoiceForOrder(makeScope(order).scope, "order_1", {
      confirmedNotInParasut: true,
    })
    expect(third.ok).toBe(true)
    expect(invoiceOf(order).status).toBe("issued")
  })

  it("satış faturası yanıtsız kalırsa (ağ hatası) belirsiz sayılır", async () => {
    const order = baseOrder()
    const { scope } = makeScope(order)
    mockParasut({ "POST /42/sales_invoices": "network-error" })
    await issueSalesInvoiceForOrder(scope, "order_1")
    expect(invoiceOf(order).status).toBe("unknown")
  })

  it("satış faturası 422: kesin ret, hata; tekrar denenebilir", async () => {
    const order = baseOrder()
    const { scope } = makeScope(order)
    mockParasut({ "POST /42/sales_invoices": { status: 422, body: { errors: [{ detail: "geçersiz" }] } } })
    const result = await issueSalesInvoiceForOrder(scope, "order_1")
    expect(result.ok).toBe(false)
    expect(invoiceOf(order)).toMatchObject({ status: "error", note: "invoice_not_created" })
    expect(invoiceOf(order).invoice_id).toBeUndefined()

    mockParasut()
    expect((await issueSalesInvoiceForOrder(makeScope(order).scope, "order_1")).ok).toBe(true)
  })

  it("resmileştirme kırılırsa satış faturası korunur, tekrar deneme yeni fatura açmaz", async () => {
    const order = baseOrder()
    const { scope } = makeScope(order)
    mockParasut({ "POST /42/e_archives": { status: 422, body: { errors: [{ detail: "seri yok" }] } } })
    const first = await issueSalesInvoiceForOrder(scope, "order_1")
    expect(first.ok).toBe(false)
    expect(invoiceOf(order)).toMatchObject({
      status: "error",
      invoice_id: "inv1",
      note: "partial_failure_invoice_id_preserved",
      items: [{ line_item_id: "item_1", quantity: 1 }],
    })

    const api = mockParasut()
    const second = await issueSalesInvoiceForOrder(makeScope(order).scope, "order_1")
    expect(second.ok).toBe(true)
    expect(api.count("POST /42/sales_invoices")).toBe(0)
    expect(api.count("POST /42/e_archives")).toBe(1)
    expect(invoiceOf(order)).toMatchObject({ status: "issued", invoice_id: "inv1" })
  })

  it("toplam siparişle tutmuyorsa hiçbir kayıt açılmaz", async () => {
    const order = baseOrder({ total: 250 })
    const { scope } = makeScope(order)
    const api = mockParasut()
    const result = await issueSalesInvoiceForOrder(scope, "order_1")
    expect(result.ok).toBe(false)
    expect(invoiceOf(order).status).toBe("error")
    expect(String(invoiceOf(order).error)).toContain("tutmuyor")
    expect(api.count("POST /42/sales_invoices")).toBe(0)
    expect(api.count("POST /42/contacts")).toBe(0)
  })

  it("Paraşüt'te ürün yoksa ve oluşturma kapalıysa fatura açılmaz", async () => {
    const order = baseOrder()
    const { scope } = makeScope(order, { ...LIVE, productCreate: "false" })
    const api = mockParasut({ "GET /42/products": { status: 200, body: { data: [] } } })
    const result = await issueSalesInvoiceForOrder(scope, "order_1")
    expect(result.ok).toBe(false)
    expect(invoiceOf(order).status).toBe("error")
    expect(String(invoiceOf(order).error)).toContain("ESC-PAPATYA-BP")
    expect(api.count("POST /42/sales_invoices")).toBe(0)
  })

  it("dry-run: taslak açılır, e-belge kesilmez; dry-run kapanınca aynı taslak resmileşir", async () => {
    const order = baseOrder()
    const dry = makeScope(order, { ...LIVE, dryRun: "true" })
    const api = mockParasut()
    const first = await issueSalesInvoiceForOrder(dry.scope, "order_1")
    expect(first.ok).toBe(true)
    expect(invoiceOf(order)).toMatchObject({ status: "draft_dryrun", invoice_id: "inv1" })
    expect(api.count("POST /42/e_archives")).toBe(0)
    expect(sendInvoiceIssuedEmail).not.toHaveBeenCalled()

    const again = await issueSalesInvoiceForOrder(dry.scope, "order_1")
    expect(again.skipped).toBe(true)

    const live = makeScope(order)
    const api2 = mockParasut()
    const real = await issueSalesInvoiceForOrder(live.scope, "order_1")
    expect(real.ok).toBe(true)
    expect(api2.count("POST /42/sales_invoices")).toBe(0)
    expect(api2.count("POST /42/e_archives")).toBe(1)
    expect(invoiceOf(order)).toMatchObject({ status: "issued", invoice_id: "inv1" })
  })

  it("PAYTR_OID_PREFIX doluyken dry-run zorlanır", async () => {
    process.env.PAYTR_OID_PREFIX = "STG"
    const order = baseOrder()
    const { scope } = makeScope(order)
    const api = mockParasut()
    await issueSalesInvoiceForOrder(scope, "order_1")
    expect(invoiceOf(order).status).toBe("draft_dryrun")
    expect(api.count("POST /42/e_archives")).toBe(0)
  })

  it("mock faturası olan sipariş, gerçek bağlantı açılınca gerçekten kesilir", async () => {
    const order = baseOrder()
    const mock = makeScope(order, {})
    const first = await issueSalesInvoiceForOrder(mock.scope, "order_1")
    expect(first.ok).toBe(true)
    expect(invoiceOf(order)).toMatchObject({ status: "issued", mode: "mock" })

    const live = makeScope(order)
    const api = mockParasut()
    await issueSalesInvoiceForOrder(live.scope, "order_1")
    expect(api.count("POST /42/sales_invoices")).toBe(1)
    expect(invoiceOf(order)).toMatchObject({ status: "issued", mode: "live", invoice_id: "inv1" })
  })

  it("iptal ve tamamen iade edilmiş sipariş faturalanmaz", async () => {
    const canceled = baseOrder({ status: "canceled" })
    const api = mockParasut()
    const r1 = await issueSalesInvoiceForOrder(makeScope(canceled).scope, "order_1")
    expect(r1).toMatchObject({ ok: false, skipped: true })
    expect(invoiceOf(canceled)).toMatchObject({ status: "skipped", note: "canceled" })

    const refunded = baseOrder({
      payment_collections: [
        { payments: [{ captures: [{ amount: 184.9 }], refunds: [{ amount: 184.9 }] }] },
      ],
    })
    await issueSalesInvoiceForOrder(makeScope(refunded).scope, "order_1")
    expect(invoiceOf(refunded)).toMatchObject({ status: "skipped", note: "refunded" })
    expect(api.calls.length).toBe(0)
  })
})

describe("issueRefundInvoiceForReturn", () => {
  const issued = {
    parasut_invoice: { status: "issued", mode: "live", invoice_id: "inv1", invoice_number: "ESC1" },
  }
  const input = { return_id: "ret_1", order_id: "order_1", amount: 35 }
  const refundOf = (order: FakeOrder) =>
    (order.metadata?.parasut_refund_invoices as Record<string, Record<string, unknown>>)?.ret_1

  it("varsayılan: elle kesilecek işareti, olay ve mail; ikinci çağrı tekrar uyarmaz", async () => {
    const order = baseOrder({ metadata: { ...issued } })
    const { scope } = makeScope(order)
    const api = mockParasut()
    const first = await issueRefundInvoiceForReturn(scope, input)
    expect(first.ok).toBe(true)
    expect(refundOf(order)).toMatchObject({
      status: "manual_required",
      amount: 35,
      sales_invoice_id: "inv1",
      note: "auto_disabled",
    })
    expect(api.calls.length).toBe(0)
    expect(recordOpsEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "invoice.refund_manual" })
    )
    expect(notifyRefundInvoiceProblem).toHaveBeenCalledTimes(1)

    const second = await issueRefundInvoiceForReturn(scope, input)
    expect(second.skipped).toBe(true)
    expect(notifyRefundInvoiceProblem).toHaveBeenCalledTimes(1)
  })

  it("reddedilen iadede ve sıfır tutarda hareket yok", async () => {
    const order = baseOrder({ metadata: { ...issued } })
    const rejected = makeScope(order, LIVE, { escay_rejection: { rejected: true, reason: "x" } })
    const r1 = await issueRefundInvoiceForReturn(rejected.scope, input)
    expect(r1).toMatchObject({ ok: false, skipped: true })
    const r2 = await issueRefundInvoiceForReturn(makeScope(order).scope, { ...input, amount: 0 })
    expect(r2).toMatchObject({ ok: false, skipped: true })
    expect(order.metadata?.parasut_refund_invoices).toBeUndefined()
    expect(recordOpsEvent).not.toHaveBeenCalled()
  })

  it("otomatik açıkken Paraşüt'te iade faturası keser; hata olursa elle kesim uyarısı", async () => {
    process.env.PARASUT_REFUND_INVOICE_AUTO = "true"
    const order = baseOrder({ metadata: { ...issued } })
    const { scope } = makeScope(order)
    const api = mockParasut({
      "POST /42/sales_invoices": { status: 201, body: { data: { id: "ref1", attributes: { invoice_no: "IADE1" } } } },
    })
    const ok = await issueRefundInvoiceForReturn(scope, input)
    expect(ok.ok).toBe(true)
    expect(refundOf(order)).toMatchObject({ status: "issued", refund_invoice_id: "ref1", invoice_number: "IADE1" })
    const sent = api.calls.find((c) => c.path === "/42/sales_invoices")!
    expect(sent.body.data.attributes.item_type).toBe("refund")

    const failing = baseOrder({ metadata: { ...issued } })
    mockParasut({ "POST /42/sales_invoices": { status: 422, body: { errors: [] } } })
    const bad = await issueRefundInvoiceForReturn(makeScope(failing).scope, input)
    expect(bad.ok).toBe(false)
    expect(refundOf(failing).status).toBe("error")
    expect(notifyRefundInvoiceProblem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ error: expect.any(String) })
    )
  })

  it("otomatik açık ama satış faturası yoksa elle kesime düşer", async () => {
    process.env.PARASUT_REFUND_INVOICE_AUTO = "true"
    const order = baseOrder()
    const api = mockParasut()
    await issueRefundInvoiceForReturn(makeScope(order).scope, input)
    expect(refundOf(order)).toMatchObject({ status: "manual_required", note: "no_sales_invoice" })
    expect(api.calls.length).toBe(0)
  })
})

describe("yardımcılar", () => {
  it("kargo KDV'si siparişin vergi satırından, yoksa varsayılandan", () => {
    expect(shippingVatRateOf({ shipping_methods: [{ tax_lines: [{ rate: 10 }] }] }, 20)).toBe(10)
    expect(shippingVatRateOf({ shipping_methods: [{ tax_lines: [] }] }, 20)).toBe(20)
    expect(shippingVatRateOf({}, 20)).toBe(20)
  })

  it("toplam farkı: adet başına 1 kuruş yuvarlama kabul, fazlası ret", () => {
    expect(totalDriftAllowed(100, 100.05, 1)).toBe(true)
    expect(totalDriftAllowed(2499.95, 2500, 10)).toBe(true)
    expect(totalDriftAllowed(100, 100.2, 1)).toBe(false)
    expect(totalDriftAllowed(184.9, 250, 2)).toBe(false)
  })
})

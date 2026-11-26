/**
 * Parasut API v4 HTTP istemcisi.
 *
 * - Access token dışarıdan gelir (ParasutTokenProvider): bağlantı veritabanında, yenileme
 *   servis katmanında kilit altında (oauth.ts). 401'de token bir kez yenilenip istek tekrarlanır.
 * - Retry/backoff (429 / 5xx); 403 asla tekrar denenmez (Paraşüt çok 401/403 alan istemciyi kapatır).
 * - mockMode: gerçek HTTP yok, mock.ts yanıtları
 *
 * Uç noktalar ve alanlar devhub.parasut.com/openapi.json (2026-11) ile doğrulandı.
 * Env boşken asla HTTP atılmaz.
 */

import {
  mockCancelInvoice,
  mockCreateRefundInvoice,
  mockCreateSalesInvoice,
  mockEnsureContact,
  mockFinalizeInvoice,
  mockGetInvoicePdf,
  resolveMockInvoiceType,
} from "./mock"
import {
  isMockMode,
  isParasutDryRun,
  toParasutCurrency,
  type ParasutOptions,
} from "./options"
import {
  buildSalesInvoicePayload,
  type ParasutSalesInvoicePayload,
} from "./payload"
import type {
  ParasutCancelResult,
  ParasutContactInput,
  ParasutContactResult,
  ParasutFinalizeInput,
  ParasutFinalizeResult,
  ParasutInvoiceLineInput,
  ParasutInvoiceType,
  ParasutPdfResult,
  ParasutProductInput,
  ParasutProductRecord,
  ParasutProductResult,
  ParasutRefundInvoiceInput,
  ParasutRefundInvoiceResult,
  ParasutSalesInvoiceInput,
  ParasutSalesInvoiceResult,
} from "./types"

export type ParasutTransport = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body?: string
    signal?: AbortSignal
  }
) => Promise<{
  ok: boolean
  status: number
  text: () => Promise<string>
}>

/** Smoke / unit: mock yolda belirli adımı zorla kır. */
export type ParasutMockBehavior = {
  failOn?:
    | "ensureContact"
    | "createSalesInvoice"
    | "finalizeInvoice"
    | "createRefundInvoice"
    | "checkVkn"
    | "getInvoicePdf"
  failMessage?: string
  /** findSalesInvoiceByReferenceKey mock yanıtı (yoksa null = bulunamadı) */
  referenceKeyInvoiceId?: string | null
}

/** Access token kaynağı. invalidate: 401 alınan token'ı at, sonraki çağrı yenilesin. */
export type ParasutTokenProvider = {
  getAccessToken: () => Promise<string>
  invalidate: (token: string) => void
}

export type ParasutClientOptions = ParasutOptions & {
  transport?: ParasutTransport
  tokenProvider?: ParasutTokenProvider
  /** e-belge işinin (trackable job) bitmesi için bekleme (ms). Varsayılan 60 sn. */
  jobWaitMs?: number
  /** Yoklama aralığı (ms). Testlerde 0. */
  pollIntervalMs?: number
  forceMock?: boolean
  mockBehavior?: ParasutMockBehavior
  logger?: {
    info: (m: string) => void
    warn: (m: string) => void
    error: (m: string) => void
  }
}

const ERROR_BODY_LOG_MAX = 4000
const ERROR_BODY_MESSAGE_MAX = 1500

/** Parasut 4xx/5xx JSON/text gövdesini log + error.message için düz metin yap. */
export function formatParasutErrorBody(
  body: unknown,
  max = ERROR_BODY_LOG_MAX
): string {
  if (body == null || body === "") return ""
  let text: string
  if (typeof body === "string") {
    text = body
  } else {
    try {
      text = JSON.stringify(body)
    } catch {
      text = String(body)
    }
  }
  if (text.length <= max) return text
  return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`
}

export class ParasutError extends Error {
  status?: number
  responseBody?: unknown
  retryable?: boolean

  constructor(
    message: string,
    options?: { status?: number; responseBody?: unknown; retryable?: boolean }
  ) {
    super(message)
    this.name = "ParasutError"
    this.status = options?.status
    this.responseBody = options?.responseBody
    this.retryable = options?.retryable
  }
}

/** Satış faturasının aktif e-belgesi (e-arşiv / e-fatura). */
export type ParasutActiveEDocument = {
  formalId: string
  invoiceType: ParasutInvoiceType
  invoiceNumber?: string
  uuid?: string
  issueDate?: string
}

type JsonApiResource = {
  id?: string
  type?: string
  attributes?: Record<string, unknown>
  relationships?: Record<string, { data?: { id?: string; type?: string } | null }>
}

const RETRYABLE = (status: number) => status === 429 || status >= 500

/** 429 gövdesindeki "Try again in N seconds." → bekleme (ms), en fazla 30 sn. */
export function retryAfterMs(err: ParasutError): number | null {
  if (err.status !== 429) return null
  const m = /try again in (\d+)\s*second/i.exec(formatParasutErrorBody(err.responseBody))
  if (!m) return null
  return Math.min(Number(m[1]) * 1000 + 250, 30000)
}

export class ParasutClient {
  readonly baseUrl: string
  readonly mockMode: boolean
  readonly companyId: string

  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly dryRun: boolean
  private readonly productCreate: boolean
  private readonly shippingProductId: string
  private readonly shippingProductCode: string
  private readonly transport: ParasutTransport
  private readonly tokenProvider?: ParasutTokenProvider
  private readonly eInvoiceScenario: ParasutOptions["eInvoiceScenario"]
  private readonly jobWaitMs: number
  private readonly pollIntervalMs: number
  private readonly logger?: ParasutClientOptions["logger"]
  private mockBehavior_: ParasutMockBehavior
  private readonly productCache_ = new Map<string, string>()

  /** Son oluşturulan sales invoice payload (mock + live inspection). */
  lastSalesInvoicePayload: ParasutSalesInvoicePayload | null = null
  lastSalesInvoiceInput: ParasutSalesInvoiceInput | null = null
  /** Çağrı sayaçları — çift fatura / retry smoke için */
  createSalesInvoiceCalls = 0
  finalizeInvoiceCalls = 0
  createRefundInvoiceCalls = 0
  createProductCalls = 0
  requestAttempts = 0

  constructor(options: ParasutClientOptions) {
    this.companyId = options.companyId
    this.baseUrl = options.baseUrl.replace(/\/$/, "")
    this.tokenProvider = options.tokenProvider
    this.eInvoiceScenario = options.eInvoiceScenario || "basic"
    this.jobWaitMs = options.jobWaitMs ?? 60_000
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000
    this.timeoutMs = options.timeoutMs
    this.maxRetries = options.maxRetries
    this.dryRun = isParasutDryRun(options)
    this.productCreate = options.productCreate ?? !this.dryRun
    this.shippingProductId = options.shippingProductId || ""
    this.shippingProductCode = options.shippingProductCode || "KARGO"
    this.mockMode = options.forceMock === true || isMockMode(options)
    this.logger = options.logger
    this.mockBehavior_ = options.mockBehavior || {}

    // fetch çağrı anında okunur (kurulurken yakalanmaz): testler ve izleme sarmalayıcıları
    // sonradan değiştirebilir.
    const transport: ParasutTransport | undefined =
      options.transport ??
      (typeof globalThis.fetch === "function"
        ? (url, init) => (globalThis.fetch as unknown as ParasutTransport)(url, init)
        : undefined)
    if (!this.mockMode && !transport) {
      throw new ParasutError(
        "fetch bulunamadı. Node 18+ gerekli veya options.transport verin."
      )
    }
    this.transport = transport as ParasutTransport
  }

  setMockBehavior(behavior: ParasutMockBehavior) {
    this.mockBehavior_ = behavior || {}
  }

  private throwIfMockFail(step: NonNullable<ParasutMockBehavior["failOn"]>) {
    if (!this.mockMode || this.mockBehavior_.failOn !== step) return
    throw new ParasutError(
      this.mockBehavior_.failMessage ||
        `Parasut mock forced failure: ${step}`,
      { status: 500, retryable: false }
    )
  }

  async ensureContact(input: ParasutContactInput): Promise<ParasutContactResult> {
    if (this.mockMode) {
      this.throwIfMockFail("ensureContact")
      this.logger?.info("[parasut] mock ensureContact")
      return mockEnsureContact(input)
    }

    // Canlı: vergi no varsa onunla (aynı e-postayla farklı firmaya fatura kesilebilir),
    // yoksa e-postayla ara; bulunamazsa oluştur.
    const filter = input.taxNumber
      ? `filter[tax_number]=${encodeURIComponent(input.taxNumber)}`
      : input.email
        ? `filter[email]=${encodeURIComponent(input.email)}`
        : ""
    if (filter) {
      const found = await this.requestJson<{
        data?: { id?: string }[]
      }>(
        "GET",
        `/${this.companyId}/contacts?${filter}`,
        undefined,
        { allowEmpty: true }
      )
      const existing = found?.data?.[0]?.id
      if (existing) {
        return { contactId: String(existing), created: false }
      }
    }

    const created = await this.requestJson<{ data?: { id?: string } }>(
      "POST",
      `/${this.companyId}/contacts`,
      {
        data: {
          type: "contacts",
          attributes: {
            name: input.name,
            email: input.email || undefined,
            tax_number: input.taxNumber || undefined,
            tax_office: input.taxOffice || undefined,
            phone: input.phone || undefined,
            city: input.city || undefined,
            district: input.district || undefined,
            address: input.address || undefined,
            account_type: "customer",
          },
        },
      }
    )
    const id = created?.data?.id
    if (!id) {
      throw new ParasutError("Parasut contact create: missing id", {
        responseBody: created,
      })
    }
    return { contactId: String(id), created: true }
  }

  async createSalesInvoice(
    input: ParasutSalesInvoiceInput
  ): Promise<ParasutSalesInvoiceResult> {
    this.createSalesInvoiceCalls += 1
    const body = buildSalesInvoicePayload(input)
    this.lastSalesInvoiceInput = input
    this.lastSalesInvoicePayload = body

    if (this.mockMode) {
      this.throwIfMockFail("createSalesInvoice")
      this.logger?.info(
        `[parasut] mock createSalesInvoice order=${input.orderId}`
      )
      return mockCreateSalesInvoice(input)
    }

    const withProducts = await this.attachProducts(input)
    const liveBody = buildSalesInvoicePayload(withProducts)
    this.lastSalesInvoiceInput = withProducts
    this.lastSalesInvoicePayload = liveBody

    // 5xx / zaman aşımında kayıt açılmış olabilir. external_reference_key aynı anahtarla
    // ikinci faturayı Paraşüt tarafında reddeder (422 + mevcut fatura id); yine de burada
    // yalnız 429 (işlenmedi) tekrar denenir, belirsiz sonuç çağırana `unknown` olarak döner
    // ve findSalesInvoiceByReferenceKey ile çözülür.
    let created: { data?: { id?: string } }
    try {
      created = await this.requestJson<{ data?: { id?: string } }>(
        "POST",
        `/${this.companyId}/sales_invoices`,
        liveBody,
        { retryOnlyRateLimit: true }
      )
    } catch (err) {
      const existingId = input.referenceKey ? existingInvoiceIdFromKeyConflict(err) : null
      if (existingId) {
        this.logger?.warn(
          `[parasut] sales invoice zaten açılmış (external_reference_key) order=${input.orderId} invoice=${existingId}`
        )
        return { invoiceId: existingId, existing: true }
      }
      throw err
    }
    const id = created?.data?.id
    if (!id) {
      throw new ParasutError("Parasut sales invoice create: missing id", {
        responseBody: created,
      })
    }
    return { invoiceId: String(id) }
  }

  /**
   * external_reference_key ile açılmış satış faturası. Yoksa null (Paraşüt gövdesiz 404 döner).
   * Belirsiz kalan oluşturma isteğinin sonucunu kesinleştirir.
   */
  async findSalesInvoiceByReferenceKey(referenceKey: string): Promise<string | null> {
    if (this.mockMode) {
      return this.mockBehavior_.referenceKeyInvoiceId ?? null
    }
    try {
      const res = await this.requestJson<{ data?: { id?: string } }>(
        "GET",
        `/${this.companyId}/sales_invoices/find_by_external_reference_key?external_reference_key=${encodeURIComponent(referenceKey)}`,
        undefined,
        { allowEmpty: true }
      )
      return res?.data?.id ? String(res.data.id) : null
    } catch (err) {
      if (err instanceof ParasutError && err.status === 404) return null
      throw err
    }
  }

  /**
   * Parasut ürün/hizmet: önce code (SKU), code yoksa name ile birebir arar.
   * Bulunamazsa productCreate açıksa oluşturur; kapalıysa null döner.
   */
  async ensureProduct(
    input: ParasutProductInput
  ): Promise<ParasutProductResult | null> {
    const code = (input.code || "").trim()
    const name = (input.name || "").trim() || code
    const cacheKey = code ? `code:${code}` : `name:${name.toLowerCase()}`

    if (this.mockMode) {
      return {
        productId: `mock-product-${code || name}`.replace(/\s+/g, "-"),
        created: false,
        mock: true,
      }
    }

    const cached = this.productCache_.get(cacheKey)
    if (cached) return { productId: cached, created: false }

    const filter = code
      ? `filter[code]=${encodeURIComponent(code)}`
      : `filter[name]=${encodeURIComponent(name)}`
    const found = await this.requestJson<{
      data?: { id?: string; attributes?: { code?: string | null; name?: string | null } }[]
    }>(
      "GET",
      `/${this.companyId}/products?${filter}&page[size]=25`,
      undefined,
      { allowEmpty: true }
    )
    const match = (found?.data || []).find((p) => {
      const a = p.attributes || {}
      return code
        ? (a.code || "").trim() === code
        : (a.name || "").trim().toLowerCase() === name.toLowerCase()
    })
    if (match?.id) {
      this.productCache_.set(cacheKey, String(match.id))
      return { productId: String(match.id), created: false }
    }

    if (!this.productCreate) return null

    this.createProductCalls += 1
    this.logger?.warn(
      `[parasut] product create code=${code || "-"} name=${name}${this.dryRun ? " (DRY-RUN, PARASUT_PRODUCT_CREATE açık)" : ""}`
    )
    const created = await this.requestJson<{ data?: { id?: string } }>(
      "POST",
      `/${this.companyId}/products`,
      {
        data: {
          type: "products",
          attributes: {
            name,
            code: code || undefined,
            vat_rate: input.vatRate,
            list_price: input.listPrice,
            currency: "TRL",
            inventory_tracking: false,
          },
        },
      }
    )
    const id = created?.data?.id
    if (!id) {
      throw new ParasutError("Parasut product create: missing id", {
        responseBody: created,
      })
    }
    this.productCache_.set(cacheKey, String(id))
    return { productId: String(id), created: true }
  }

  /** Salt okuma: ürün listesi tek sayfa (Parasut page[size] en fazla 25). */
  async listProductsPage(
    pageNumber: number,
    pageSize = 25
  ): Promise<{
    products: ParasutProductRecord[]
    totalPages: number
    totalCount: number
  }> {
    if (this.mockMode) {
      return { products: [], totalPages: 0, totalCount: 0 }
    }
    const size = Math.min(Math.max(1, pageSize), 25)
    const res = await this.requestJson<{
      data?: { id?: string; attributes?: Record<string, unknown> }[]
      meta?: { total_pages?: number; total_count?: number }
    }>(
      "GET",
      `/${this.companyId}/products?page[number]=${pageNumber}&page[size]=${size}&sort=id`,
      undefined,
      { allowEmpty: true }
    )
    const products = (res?.data || [])
      .filter((p) => p.id)
      .map((p) => {
        const a = p.attributes || {}
        const str = (v: unknown) =>
          v == null || v === "" ? null : String(v).trim() || null
        const num = (v: unknown) => {
          const n = Number(v)
          return v == null || v === "" || !Number.isFinite(n) ? null : n
        }
        return {
          id: String(p.id),
          name: str(a.name) || "",
          code: str(a.code),
          barcode: str(a.barcode),
          vatRate: num(a.vat_rate),
          listPrice: num(a.list_price),
          currency: str(a.currency),
          archived: a.archived === true,
          inventoryTracking: a.inventory_tracking === true,
          stockCount: num(a.stock_count),
          salesInvoiceDetailsCount: num(a.sales_invoice_details_count),
        }
      })
    return {
      products,
      totalPages: Number(res?.meta?.total_pages) || 0,
      totalCount: Number(res?.meta?.total_count) || products.length,
    }
  }

  /** Her kalemi (ve kargoyu) Parasut ürününe bağlar; eksik varsa fatura POST edilmeden hata. */
  private async attachProducts(
    input: ParasutSalesInvoiceInput
  ): Promise<ParasutSalesInvoiceInput> {
    const missing: string[] = []

    const lines: ParasutInvoiceLineInput[] = []
    for (const line of input.lines) {
      if (line.productId) {
        lines.push(line)
        continue
      }
      const product = await this.ensureProduct({
        code: line.productCode,
        name: line.description,
        vatRate: line.vatRate,
        listPrice: line.unitPrice,
      })
      if (!product) missing.push(line.productCode || line.description)
      lines.push({ ...line, productId: product?.productId ?? null })
    }

    let shipping = input.shipping
    if (shipping && shipping.amount > 0 && !shipping.productId) {
      if (this.shippingProductId) {
        shipping = { ...shipping, productId: this.shippingProductId }
      } else {
        const product = await this.ensureProduct({
          code: this.shippingProductCode,
          name: shipping.description || "Kargo",
          vatRate: shipping.vatRate,
          listPrice: shipping.amount,
        })
        if (!product) missing.push(this.shippingProductCode)
        shipping = { ...shipping, productId: product?.productId ?? null }
      }
    }

    const resolved = { ...input, lines, shipping }
    if (missing.length) {
      this.lastSalesInvoiceInput = resolved
      this.lastSalesInvoicePayload = buildSalesInvoicePayload(resolved)
      throw new ParasutError(
        `Parasut ürün/hizmet bulunamadı (oluşturma kapalı${this.dryRun ? ", DRY-RUN" : ""}): ${missing.join(", ")}. Parasut'ta bu kodla ürün açın, PARASUT_SHIPPING_PRODUCT_ID verin veya PARASUT_PRODUCT_CREATE=true.`,
        { retryable: false }
      )
    }
    return resolved
  }

  /**
   * DRY-RUN: resmileştirme (e_archives / e_invoices / iade) YASAK.
   * Env veya options.dryRun — çağrılsa bile HTTP atılmaz.
   */
  private assertFormalizationAllowed(step: string): void {
    if (!this.dryRun && !isParasutDryRun()) return
    this.logger?.error(
      `[parasut] DRY-RUN: ${step} BLOCKED — e_archive/e_invoice/refund POST yok invoice/order guard`
    )
    throw new ParasutError(
      `DRY-RUN: ${step} blocked — no e_archive/e_invoice formalization`,
      { retryable: false }
    )
  }

  /**
   * Satış faturasını resmileştir: alıcı e-fatura mükellefiyse e-fatura, değilse e-arşiv.
   *
   * Tekrar çağrıya dayanıklı: faturanın zaten aktif e-belgesi varsa yeni belge POST edilmez.
   * Paraşüt e-belgeyi arka planda keser (202 + trackable job); iş bitene kadar beklenir,
   * belge numarası faturanın active_e_document'ından okunur.
   */
  async finalizeInvoice(
    input: ParasutFinalizeInput
  ): Promise<ParasutFinalizeResult> {
    // GÜVENLİK: DRY-RUN'da ilk satır — GİB/e-belge POST yok
    this.assertFormalizationAllowed("finalizeInvoice")
    this.finalizeInvoiceCalls += 1
    if (this.mockMode) {
      this.throwIfMockFail("finalizeInvoice")
      this.logger?.info(
        `[parasut] mock finalizeInvoice invoice=${input.invoiceId}`
      )
      return mockFinalizeInvoice(input)
    }

    const before = await this.getSalesInvoiceEDocument(input.invoiceId)
    if (before.document) {
      this.logger?.info(
        `[parasut] finalize: fatura zaten resmileşmiş invoice=${input.invoiceId} ${before.document.invoiceType}=${before.document.formalId}`
      )
      return toFinalizeResult(input.invoiceId, before.document)
    }

    const issueDate = before.issueDate || new Date().toISOString().slice(0, 10)
    const recipient = await this.checkVknType(input.taxNumber, issueDate)
    const invoiceType = recipient.type

    const body =
      invoiceType === "e_invoice"
        ? {
            data: {
              type: "e_invoices",
              attributes: {
                scenario: this.eInvoiceScenario,
                to: recipient.address,
              },
              relationships: {
                invoice: { data: { type: "sales_invoices", id: input.invoiceId } },
              },
            },
          }
        : {
            data: {
              type: "e_archives",
              // e-Arşiv: internet satışında internet_sale zorunlu (GİB e-ticaret)
              ...(input.internetSale
                ? {
                    attributes: {
                      internet_sale: {
                        url: input.internetSale.url,
                        payment_type: input.internetSale.payment_type,
                        payment_platform: input.internetSale.payment_platform,
                        payment_date: input.internetSale.payment_date,
                      },
                    },
                  }
                : {}),
              relationships: {
                sales_invoice: { data: { type: "sales_invoices", id: input.invoiceId } },
              },
            },
          }

    const job = await this.requestJson<{ data?: JsonApiResource }>(
      "POST",
      `/${this.companyId}/${invoiceType === "e_invoice" ? "e_invoices" : "e_archives"}`,
      body,
      // İstek işlenmiş olabilir; tekrar denemede önce aktif e-belgeye bakılır (yukarıda).
      { retryOnlyRateLimit: true }
    )
    const jobId = job?.data?.type === "trackable_jobs" ? job.data.id : undefined
    if (jobId) {
      await this.waitForTrackableJob(String(jobId), `${invoiceType} invoice=${input.invoiceId}`)
    }

    const after = await this.getSalesInvoiceEDocument(input.invoiceId)
    if (!after.document) {
      throw new ParasutError(
        `Paraşüt e-belge işi bitti ama faturada aktif e-belge yok (invoice=${input.invoiceId}). Tekrar denenecek.`,
        { retryable: true, responseBody: job }
      )
    }
    return toFinalizeResult(input.invoiceId, after.document)
  }

  /** Token sahibinin erişebildiği Paraşüt firma numaraları (GET /me?include=companies). */
  async listAccessibleCompanyIds(): Promise<string[]> {
    if (this.mockMode) return [this.companyId]
    const res = await this.requestJson<{ included?: JsonApiResource[] }>(
      "GET",
      "/me?include=companies"
    )
    return (res?.included || [])
      .filter((r) => r.type === "companies" && r.id)
      .map((r) => String(r.id))
  }

  /** Satış faturası + aktif e-belgesi (include=active_e_document). */
  async getSalesInvoiceEDocument(invoiceId: string): Promise<{
    issueDate?: string
    invoiceNo?: string
    document: ParasutActiveEDocument | null
  }> {
    const res = await this.requestJson<{
      data?: JsonApiResource
      included?: JsonApiResource[]
    }>(
      "GET",
      `/${this.companyId}/sales_invoices/${encodeURIComponent(invoiceId)}?include=active_e_document`
    )
    const attrs = res?.data?.attributes || {}
    const invoiceNo = typeof attrs.invoice_no === "string" && attrs.invoice_no ? attrs.invoice_no : undefined
    const issueDate = typeof attrs.issue_date === "string" ? attrs.issue_date.slice(0, 10) : undefined
    const rel = res?.data?.relationships?.active_e_document?.data
    if (!rel?.id) return { issueDate, invoiceNo, document: null }
    const doc = (res?.included || []).find((r) => r.id === rel.id && r.type === rel.type)
    const docAttrs = doc?.attributes || {}
    const invoiceType: ParasutInvoiceType | null =
      rel.type === "e_invoices" ? "e_invoice" : rel.type === "e_archives" ? "e_archive" : null
    if (!invoiceType) {
      // e_smms vb. — bu entegrasyon kesmez; resmileşmiş sayma.
      return { issueDate, invoiceNo, document: null }
    }
    const number =
      (typeof docAttrs.invoice_number === "string" && docAttrs.invoice_number) || invoiceNo
    return {
      issueDate,
      invoiceNo,
      document: {
        formalId: String(rel.id),
        invoiceType,
        invoiceNumber: number || undefined,
        uuid: typeof docAttrs.uuid === "string" ? docAttrs.uuid : undefined,
        issueDate,
      },
    }
  }

  /** trackable_jobs: running → done | error. Süre aşılırsa tekrar denenebilir hata. */
  private async waitForTrackableJob(jobId: string, label: string): Promise<void> {
    const deadline = Date.now() + this.jobWaitMs
    for (;;) {
      const res = await this.requestJson<{ data?: JsonApiResource }>(
        "GET",
        `/${this.companyId}/trackable_jobs/${encodeURIComponent(jobId)}`
      )
      const attrs = res?.data?.attributes || {}
      const status = String(attrs.status || "")
      if (status === "done") return
      if (status === "error") {
        const errors = Array.isArray(attrs.errors) ? attrs.errors.map(String).join("; ") : ""
        throw new ParasutError(`Paraşüt e-belge kesilemedi (${label}): ${errors || "bilinmeyen hata"}`, {
          responseBody: res,
          retryable: false,
        })
      }
      if (Date.now() >= deadline) {
        throw new ParasutError(
          `Paraşüt e-belge işi ${Math.round(this.jobWaitMs / 1000)} sn'de bitmedi (${label}, job=${jobId}). Tekrar denemede aktif e-belge kontrol edilir.`,
          { retryable: true }
        )
      }
      await sleep(this.pollIntervalMs)
    }
  }

  /**
   * e-belge PDF'i. Paraşüt'ün verdiği adres süreli (expires_at); kalıcı saklamayın,
   * gerektiğinde yeniden isteyin. PDF hazır değilse 204 döner, kısa süre beklenir.
   */
  async getInvoicePdf(
    invoiceId: string,
    formal?: { formalId?: string | null; invoiceType?: ParasutInvoiceType | null }
  ): Promise<ParasutPdfResult> {
    if (this.mockMode) {
      this.throwIfMockFail("getInvoicePdf")
      this.logger?.info(`[parasut] mock getInvoicePdf invoice=${invoiceId}`)
      return mockGetInvoicePdf(invoiceId)
    }

    let formalId = formal?.formalId || ""
    let invoiceType = formal?.invoiceType || null
    if (!formalId || !invoiceType) {
      const { document } = await this.getSalesInvoiceEDocument(invoiceId)
      if (!document) {
        throw new ParasutError(`Faturanın e-belgesi yok, PDF alınamaz (invoice=${invoiceId})`, {
          retryable: false,
        })
      }
      formalId = document.formalId
      invoiceType = document.invoiceType
    }
    const path = `/${this.companyId}/${invoiceType === "e_invoice" ? "e_invoices" : "e_archives"}/${encodeURIComponent(formalId)}/pdf`
    const deadline = Date.now() + Math.min(this.jobWaitMs, 20_000)
    for (;;) {
      const res = await this.requestJson<{ data?: JsonApiResource }>("GET", path, undefined, {
        allowEmpty: true,
      })
      const url = res?.data?.attributes?.url
      if (typeof url === "string" && url) {
        const expires = res?.data?.attributes?.expires_at
        return {
          invoiceId,
          pdfUrl: url,
          expiresAt: typeof expires === "string" ? expires : undefined,
        }
      }
      if (Date.now() >= deadline) {
        throw new ParasutError(`Paraşüt PDF henüz hazır değil (invoice=${invoiceId})`, {
          retryable: true,
        })
      }
      await sleep(this.pollIntervalMs)
    }
  }
  async cancelInvoice(invoiceId: string): Promise<ParasutCancelResult> {
    if (this.mockMode) {
      this.logger?.info(`[parasut] mock cancelInvoice invoice=${invoiceId}`)
      return mockCancelInvoice(invoiceId)
    }

    await this.requestJson(
      "DELETE",
      `/${this.companyId}/sales_invoices/${invoiceId}`
    )
    return { invoiceId, canceled: true }
  }

  async createRefundInvoice(
    input: ParasutRefundInvoiceInput
  ): Promise<ParasutRefundInvoiceResult> {
    // GÜVENLİK: DRY-RUN'da iade faturası da resmileşmez
    this.assertFormalizationAllowed("createRefundInvoice")
    this.createRefundInvoiceCalls += 1
    if (this.mockMode) {
      this.throwIfMockFail("createRefundInvoice")
      this.logger?.info(
        `[parasut] mock createRefundInvoice return=${input.returnId}`
      )
      return mockCreateRefundInvoice(input)
    }

    // Canlı: satış faturasına bağlı iade / credit note — iskelet.
    const created = await this.requestJson<{
      data?: {
        id?: string
        attributes?: { invoice_no?: string }
      }
    }>("POST", `/${this.companyId}/sales_invoices`, {
      data: {
        type: "sales_invoices",
        attributes: {
          item_type: "refund",
          description:
            input.description ||
            `Es Çay iade ${input.returnId} (sipariş ${input.orderId})`,
          issue_date: new Date().toISOString().slice(0, 10),
          currency: toParasutCurrency(input.currencyCode),
        },
        relationships: {
          linked_invoice: {
            data: { type: "sales_invoices", id: input.originalInvoiceId },
          },
        },
      },
    })

    const id = created?.data?.id
    if (!id) {
      throw new ParasutError("Parasut refund invoice: missing id", {
        responseBody: created,
      })
    }

    return {
      refundInvoiceId: String(id),
      invoiceNumber:
        created?.data?.attributes?.invoice_no || `REF-${id}`,
      invoiceType: "e_archive",
      amount: input.amount,
    }
  }

  /**
   * Alıcı e-fatura mükellefi mi? (e_invoice_inbox_checks — GİB hesap kapatma listesiyle)
   * Liste doluysa e-fatura (posta kutusu adresiyle), boşsa e-arşiv.
   *
   * Kontrol yapılamazsa (503 / ağ) e-arşive DÜŞÜLMEZ: mükellefe e-arşiv kesmek hatalı belge
   * olur. Hata fırlatılır, resmileştirme sonra tekrar denenir.
   * Hesabı kapanmış VKN'ye fatura kesilemez: 422 → tekrar denenmeyen hata.
   */
  async checkVknType(
    taxNumber?: string | null,
    issueDate?: string
  ): Promise<{ type: ParasutInvoiceType; address?: string }> {
    if (this.mockMode) {
      if (this.mockBehavior_.failOn === "checkVkn") {
        throw new ParasutError("Parasut mock forced failure: checkVkn", {
          status: 503,
          retryable: true,
        })
      }
      // Mock simülasyon: 10 haneli + "9" ile başlayan → e_invoice (kayıtlı);
      // diğer VKN / TCKN / yok → e_archive (kayıtsız).
      const type = resolveMockInvoiceType(taxNumber)
      return type === "e_invoice"
        ? { type, address: "urn:mail:defaultpk@mock.parasut" }
        : { type }
    }

    const digits = (taxNumber || "").replace(/\D/g, "")
    // Vergi/TC kimlik no yoksa ya da nihai tüketici yer tutucusu (11111111111) → e-arşiv.
    // TCKN de sorgulanır: şahıs şirketleri TCKN ile e-fatura mükellefi olabilir.
    if ((digits.length !== 10 && digits.length !== 11) || /^1{11}$/.test(digits)) {
      return { type: "e_archive" }
    }
    const date = issueDate || new Date().toISOString().slice(0, 10)

    let res: { data?: JsonApiResource[] }
    try {
      res = await this.requestJson<{ data?: JsonApiResource[] }>(
        "GET",
        `/${this.companyId}/e_invoice_inbox_checks?tax_number=${encodeURIComponent(digits)}&issue_date=${encodeURIComponent(date)}`,
        undefined,
        { allowEmpty: true }
      )
    } catch (err) {
      if (err instanceof ParasutError && err.status === 422) {
        throw new ParasutError(
          `Alıcıya bu tarihle fatura kesilemez (e-belge hesabı kapalı): ${firstErrorDetail(err.responseBody) || err.message}`,
          { status: 422, responseBody: err.responseBody, retryable: false }
        )
      }
      throw new ParasutError(
        `Alıcının e-fatura durumu kontrol edilemedi; belge gönderilmedi, tekrar denenecek: ${String(err instanceof Error ? err.message : err)}`,
        {
          status: err instanceof ParasutError ? err.status : undefined,
          responseBody: err instanceof ParasutError ? err.responseBody : undefined,
          retryable: true,
        }
      )
    }
    const inboxes = Array.isArray(res?.data) ? res.data : []
    if (!inboxes.length) return { type: "e_archive" }
    const address = inboxes
      .map((i) => i.attributes?.e_invoice_address)
      .find((a): a is string => typeof a === "string" && a.length > 0)
    if (!address) {
      throw new ParasutError("Alıcı e-fatura mükellefi ama posta kutusu adresi yok", {
        responseBody: res,
        retryable: false,
      })
    }
    return { type: "e_invoice", address }
  }

  // --- HTTP ---

  private async accessToken(): Promise<string> {
    if (!this.tokenProvider) {
      throw new ParasutError(
        "Paraşüt bağlantısı yok: Admin → Paraşüt sayfasından 'Paraşüt'e bağlan' yapın.",
        { retryable: false }
      )
    }
    return this.tokenProvider.getAccessToken()
  }
  private async requestJson<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { allowEmpty?: boolean; retryOnlyRateLimit?: boolean }
  ): Promise<T> {
    let lastError: unknown
    let reauthorized = false

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      this.requestAttempts += 1
      try {
        const token = await this.accessToken()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeoutMs)
        try {
          const res = await this.transport(`${this.baseUrl}${path}`, {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: controller.signal,
          })
          // Süresi beklenenden önce dolmuş token: bir kez yenileyip aynı isteği tekrarla
          // (401'de istek işlenmemiştir). İkinci 401 hatadır; Paraşüt çok 401 alan istemciyi kapatır.
          if (res.status === 401 && !reauthorized && this.tokenProvider) {
            reauthorized = true
            this.tokenProvider.invalidate(token)
            attempt -= 1
            continue
          }
          const text = await res.text()
          let json: T | null = null
          if (text) {
            try {
              json = JSON.parse(text) as T
            } catch {
              const bodyText = formatParasutErrorBody(text)
              this.logger?.error(
                `Parasut HTTP ${res.status} ${method} ${path} non-JSON body=${bodyText || "(empty)"}`
              )
              throw new ParasutError(
                `Non-JSON response (${res.status}) ${method} ${path}${
                  bodyText ? ` ${formatParasutErrorBody(text, ERROR_BODY_MESSAGE_MAX)}` : ""
                }`,
                {
                  status: res.status,
                  responseBody: text,
                }
              )
            }
          }
          if (!res.ok) {
            const rawBody = json ?? text
            const bodyText = formatParasutErrorBody(rawBody)
            this.logger?.error(
              `Parasut HTTP ${res.status} ${method} ${path} body=${bodyText || "(empty)"}`
            )
            throw new ParasutError(
              `Parasut HTTP ${res.status} ${method} ${path}${
                bodyText
                  ? ` ${formatParasutErrorBody(rawBody, ERROR_BODY_MESSAGE_MAX)}`
                  : ""
              }`,
              {
                status: res.status,
                responseBody: rawBody,
                retryable: RETRYABLE(res.status),
              }
            )
          }
          if (json == null && !opts?.allowEmpty) {
            throw new ParasutError(`Empty response ${method} ${path}`, {
              status: res.status,
            })
          }
          return (json ?? ({} as T)) as T
        } finally {
          clearTimeout(timer)
        }
      } catch (err) {
        lastError = err
        const retryable =
          err instanceof ParasutError
            ? Boolean(err.retryable)
            : err instanceof Error && err.name === "AbortError"
        const rateLimited = err instanceof ParasutError && err.status === 429
        if (
          !retryable ||
          attempt >= this.maxRetries ||
          (opts?.retryOnlyRateLimit && !rateLimited)
        ) {
          throw err
        }
        const hinted = err instanceof ParasutError ? retryAfterMs(err) : null
        const delay = Math.max(Math.min(1000 * 2 ** attempt, 8000), hinted ?? 0)
        this.logger?.warn(
          `[parasut] retry ${attempt + 1}/${this.maxRetries} after ${delay}ms — ${String(err)}`
        )
        await sleep(delay)
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new ParasutError(String(lastError))
  }
}

/** 422 "Bu key ile daha önce bir fatura oluşturulmuş." → mevcut fatura id (meta.sales_invoice_id). */
export function existingInvoiceIdFromKeyConflict(err: unknown): string | null {
  if (!(err instanceof ParasutError) || err.status !== 422) return null
  const body = err.responseBody as {
    errors?: { meta?: { sales_invoice_id?: unknown } }[]
    meta?: { sales_invoice_id?: unknown }
  } | null
  const id =
    body?.errors?.find((e) => e?.meta?.sales_invoice_id != null)?.meta?.sales_invoice_id ??
    body?.meta?.sales_invoice_id
  return id != null && String(id) ? String(id) : null
}

function firstErrorDetail(body: unknown): string {
  const errors = (body as { errors?: { detail?: unknown; title?: unknown }[] } | null)?.errors
  const first = Array.isArray(errors) ? errors[0] : undefined
  return first ? String(first.detail || first.title || "") : ""
}

function toFinalizeResult(
  invoiceId: string,
  doc: ParasutActiveEDocument
): ParasutFinalizeResult {
  return {
    invoiceId,
    formalId: doc.formalId,
    invoiceType: doc.invoiceType,
    invoiceNumber: doc.invoiceNumber || `${doc.invoiceType}-${doc.formalId}`,
    uuid: doc.uuid,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

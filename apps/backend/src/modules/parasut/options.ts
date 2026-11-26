/**
 * Paraşüt (Parasut) e-fatura / e-arşiv seçenekleri.
 *
 * Kimlik bilgisi yoksa / yer tutucuysa → mock mod (gerçek HTTP yok).
 * Kimlik gelince aynı kod yolu canlı client'a geçer.
 */

/** prod: id.parasut.com; staging: id-staging.parasut.com (Paraşüt'ün açtığı 6 aylık staging firması). */
export type ParasutEnv = "prod" | "staging"

/** Paraşüt e-fatura senaryosu: basic = temel (alıcı reddedemez), commercial = ticari. */
export type ParasutEInvoiceScenario = "basic" | "commercial"

export type ParasutRawOptions = {
  clientId?: string
  clientSecret?: string
  companyId?: string
  baseUrl?: string
  /** Keycloak realm kökü; boşsa env'e göre id.parasut.com / id-staging.parasut.com */
  oauthIssuer?: string
  /** Paraşüt başvurusunda kayıtlı geri dönüş adresi (birebir aynı olmalı) */
  redirectUri?: string
  env?: string
  eInvoiceScenario?: string
  defaultVatRate?: string | number
  /** Kargo kalemi KDV % — canlı fatura kanıtı: 20 (ürün 10) */
  shippingVatRate?: string | number
  timeoutMs?: string | number
  maxRetries?: string | number
  /** true → taslak sales invoice; finalize / e-belge YOK */
  dryRun?: boolean | string
  /** Parasut'ta bulunamayan ürün/hizmet oluşturulsun mu. Boş → DRY-RUN'da kapalı, canlıda açık. */
  productCreate?: boolean | string
  /** Kargo kalemi için sabit Parasut ürün id (varsa arama yapılmaz) */
  shippingProductId?: string
  /** Kargo ürün/hizmet kodu — id yoksa bu code ile aranır */
  shippingProductCode?: string
  /** true → stok eşitlemesi Medusa stoğuna yazar; kapalıyken yalnız rapor */
  stockApply?: boolean | string
  /** Birden çok stok konumu varsa eşitlenecek Medusa konumu */
  stockLocationId?: string
  stockMaxZeroRatio?: string | number
}

export type ParasutOptions = {
  clientId: string
  clientSecret: string
  companyId: string
  baseUrl: string
  oauthIssuer: string
  redirectUri: string
  env: ParasutEnv
  eInvoiceScenario: ParasutEInvoiceScenario
  defaultVatRate: number
  shippingVatRate: number
  timeoutMs: number
  maxRetries: number
  dryRun: boolean
  productCreate: boolean
  shippingProductId: string
  shippingProductCode: string
  stockApply: boolean
  stockLocationId: string
  stockMaxZeroRatio: number
}

/** Parasut `currency` enum: TRL | USD | EUR | GBP (TRY kabul edilmez). */
export function toParasutCurrency(code?: string | null): string {
  const c = text(code).toUpperCase()
  if (!c || c === "TRY" || c === "TL" || c === "TRL") return "TRL"
  return c
}

export const PARASUT_DEFAULT_BASE_URL = "https://api.parasut.com/v4"
export const PARASUT_OAUTH_ISSUERS: Record<ParasutEnv, string> = {
  prod: "https://id.parasut.com/realms/parasut",
  staging: "https://id-staging.parasut.com/realms/parasut",
}
export const PARASUT_CALLBACK_PATH = "/parasut/oauth/callback"

/** PARASUT_REDIRECT_URI yoksa backend'in dış adresinden türetilir. */
export function defaultRedirectUri(): string {
  const base = (process.env.MEDUSA_BACKEND_PUBLIC_URL || "http://localhost:9000").replace(/\/$/, "")
  return `${base}${PARASUT_CALLBACK_PATH}`
}

const PLACEHOLDER = new Set([
  "",
  "changeme",
  "change-me",
  "placeholder",
  "todo",
  "your-parasut-client-id",
  "your-parasut-client-secret",
  "your-parasut-company-id",
])

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim()
}

export function isPlaceholderCredential(value?: string | null): boolean {
  return PLACEHOLDER.has((value ?? "").trim().toLowerCase())
}

/**
 * PARASUT_DRY_RUN — taslak fatura, resmileştirme YOK.
 * Env VEYA options.dryRun. Default false (prod davranışı değişmez).
 */
export function parseDryRunFlag(value?: unknown): boolean {
  const s = text(value).toLowerCase()
  return s === "1" || s === "true" || s === "yes" || s === "on"
}

/**
 * Canlı dışı ortam işareti: PAYTR_OID_PREFIX dolu (ör. staging "STG").
 * Omnisend / Meta CAPI / PayTR iade ile aynı kural. Mareen'de test siparişi
 * gerçek e-fatura kesti; burada bu işaret DRY-RUN'ı zorlar (env false olsa bile).
 */
export function isNonProdDeployment(): boolean {
  return Boolean((process.env.PAYTR_OID_PREFIX || "").trim())
}

export function isParasutDryRun(options?: { dryRun?: boolean }): boolean {
  if (options?.dryRun === true) return true
  if (isNonProdDeployment()) return true
  return parseDryRunFlag(process.env.PARASUT_DRY_RUN)
}

/**
 * İade faturası API'den kesilsin mi? Varsayılan kapalı: iade faturası Paraşüt'ten elle
 * kesilir, sistem yalnız işi kayda geçirir. Açmadan önce gerçek hesapta bir iade deneyin.
 */
export function isRefundInvoiceAuto(): boolean {
  return parseDryRunFlag(process.env.PARASUT_REFUND_INVOICE_AUTO)
}

/** Test script: DRY-RUN kapalıysa çalışmayı REDDET (canlı fatura kesilmesin). */
export function assertParasutDryRunEnabled(): void {
  if (!isParasutDryRun()) {
    throw new Error(
      "REDDEDİLDİ: PARASUT_DRY_RUN=true zorunlu. Bu script taslak dışında fatura kesmez; env false/boş iken çalışmaz."
    )
  }
}

/**
 * Retry job: `error` her zaman; `pending` yalnız satış faturası açılmışsa (invoice_id var,
 * resmileştirme kalmış). Satış faturası açılmadan kalan pending / unknown yalnız
 * external_reference_key varsa denenir: gönderim önce Paraşüt'te bu anahtarla fatura arar,
 * bulursa onu kullanır, bulamazsa aynı anahtarla açar (Paraşüt ikinciyi reddeder).
 * Anahtarsız eski kayıtlar otomatik denenmez: kör tekrar çift fatura yazar.
 */
export function shouldRetryParasutInvoice(
  status?: string | null,
  invoiceId?: string | null,
  referenceKey?: string | null
): boolean {
  if (status === "error") return true
  if (status === "pending" && invoiceId) return true
  return (status === "unknown" || status === "pending") && !invoiceId && Boolean(referenceKey)
}

/**
 * İstemci kimliği + secret + firma no dolu ve yer tutucu değilse canlı mod.
 * Aksi halde mock — boot çökmez, gerçek HTTP atılmaz.
 * Canlı modda API çağrısı için ayrıca admin'den "Paraşüt'e bağlan" yapılmış olmalı
 * (refresh token veritabanında); bağlantı yoksa çağrılar hata verir, mock'a düşmez.
 */
export function isMockMode(
  options: Pick<ParasutOptions, "clientId" | "clientSecret" | "companyId">
): boolean {
  return (
    isPlaceholderCredential(options.clientId) ||
    isPlaceholderCredential(options.clientSecret) ||
    isPlaceholderCredential(options.companyId)
  )
}

export function normalizeOptions(raw: ParasutRawOptions = {}): ParasutOptions {
  const envRaw = text(raw.env).toLowerCase()
  // Eski şablondaki "test" staging sayılır; boş = prod.
  const env: ParasutEnv = envRaw === "staging" || envRaw === "test" ? "staging" : "prod"
  const scenarioRaw = text(raw.eInvoiceScenario).toLowerCase()

  const timeout = Number(raw.timeoutMs)
  const retries = Number(raw.maxRetries)
  const vat = Number(raw.defaultVatRate || process.env.KDV_RATE)
  const shipVat = Number(raw.shippingVatRate)
  const dryRun =
    parseDryRunFlag(raw.dryRun) ||
    parseDryRunFlag(process.env.PARASUT_DRY_RUN) ||
    isNonProdDeployment()
  const productCreateRaw = text(raw.productCreate)
  const zeroRatio = Number(raw.stockMaxZeroRatio)

  return {
    clientId: text(raw.clientId),
    clientSecret: text(raw.clientSecret),
    companyId: text(raw.companyId),
    baseUrl: text(raw.baseUrl) || PARASUT_DEFAULT_BASE_URL,
    oauthIssuer: (text(raw.oauthIssuer) || PARASUT_OAUTH_ISSUERS[env]).replace(/\/$/, ""),
    redirectUri: text(raw.redirectUri) || defaultRedirectUri(),
    env,
    eInvoiceScenario: scenarioRaw === "commercial" ? "commercial" : "basic",
    // Yalnız tax_lines boş satırda kullanılır. Çay %1 (K2: mali müşavir teyidi).
    defaultVatRate: Number.isFinite(vat) && vat > 0 ? vat : 1,
    shippingVatRate:
      text(raw.shippingVatRate) && Number.isFinite(shipVat) && shipVat >= 0 ? shipVat : 20,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30000,
    maxRetries: Number.isFinite(retries) && retries >= 0 ? retries : 2,
    dryRun,
    productCreate: productCreateRaw
      ? parseDryRunFlag(productCreateRaw)
      : !dryRun,
    shippingProductId: text(raw.shippingProductId),
    shippingProductCode: text(raw.shippingProductCode) || "KARGO",
    stockApply: parseDryRunFlag(raw.stockApply),
    stockLocationId: text(raw.stockLocationId),
    stockMaxZeroRatio:
      text(raw.stockMaxZeroRatio) && Number.isFinite(zeroRatio) && zeroRatio > 0 && zeroRatio <= 1
        ? zeroRatio
        : 0.5,
  }
}

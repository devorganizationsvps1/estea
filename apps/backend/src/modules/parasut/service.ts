import { createHash, timingSafeEqual } from "node:crypto"

import type { Logger } from "@medusajs/framework/types"
import { MedusaService } from "@medusajs/framework/utils"

import {
  ParasutClient,
  ParasutError,
  type ParasutTokenProvider,
  type ParasutTransport,
} from "./client"
import ParasutConnection from "./models/parasut-connection"
import {
  ParasutReauthorizeError,
  buildAuthorizationUrl,
  createCodeVerifier,
  createOAuthState,
  exchangeAuthorizationCode,
  refreshAccessToken,
  type ParasutTokenResponse,
} from "./oauth"
import {
  isMockMode,
  isNonProdDeployment,
  isParasutDryRun,
  isPlaceholderCredential,
  normalizeOptions,
  type ParasutOptions,
  type ParasutRawOptions,
} from "./options"
import type {
  ParasutAuthorizationStatus,
  ParasutCancelResult,
  ParasutConnectionStatus,
  ParasutContactInput,
  ParasutContactResult,
  ParasutFinalizeInput,
  ParasutFinalizeResult,
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

/** 25'lik sayfalarla 5.000 ürün; aşılırsa yanıt bozuktur. */
const MAX_PRODUCT_PAGES = 200

const CONNECTION_ID = "default"
/** Yetkilendirme ekranında kalınabilecek süre */
const PENDING_TTL_MS = 10 * 60 * 1000
/** Access token bu kadar kala yenilenir (rehber: son 30–60 sn) */
const ACCESS_SKEW_MS = 60 * 1000

type InjectedDependencies = {
  logger: Logger
}

type ConnectionRow = {
  client_id: string | null
  env: string | null
  refresh_token: string | null
  refresh_expires_at: Date | string | null
  access_token: string | null
  access_expires_at: Date | string | null
  connected_at: Date | string | null
  connected_by: string | null
  last_refreshed_at: Date | string | null
  last_error: string | null
  last_error_at: Date | string | null
  pending_state: string | null
  pending_verifier: string | null
  pending_expires_at: Date | string | null
  pending_actor: string | null
}

type SqlManager = {
  execute: (sql: string, params?: unknown[]) => Promise<unknown[]>
}
type TransactionalRepository = {
  transaction: <T>(task: (manager: SqlManager) => Promise<T>) => Promise<T>
}

const ROW_COLUMNS = `client_id, env, refresh_token, refresh_expires_at, access_token, access_expires_at,
  connected_at, connected_by, last_refreshed_at, last_error, last_error_at,
  pending_state, pending_verifier, pending_expires_at, pending_actor`

const time = (v: Date | string | null | undefined): number =>
  v ? new Date(v).getTime() : 0
const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null

function sameSecret(a: string, b: string): boolean {
  // Uzunluk sızmasın diye özetler karşılaştırılır.
  const ha = createHash("sha256").update(a).digest()
  const hb = createHash("sha256").update(b).digest()
  return timingSafeEqual(ha, hb)
}

/**
 * Parasut e-fatura / e-arşiv modül servisi.
 *
 * Sipariş faturası metadata'da tutulur; tek tablo OAuth bağlantısıdır (parasut_connection).
 * Bağlantı admin'den kurulur (Authorization Code + PKCE); refresh token bu tabloda,
 * yenileme satır kilidi altında — sunucu ve worker aynı token'ı yarıştırmadan paylaşır.
 */
class ParasutModuleService extends MedusaService({ ParasutConnection }) {
  protected readonly logger_: Logger
  protected readonly options_: ParasutOptions
  private client_: ParasutClient | null = null
  /** Bu süreçte geçerli access token (DB'deki ile aynı) */
  private access_: { token: string; expiresAt: number } | null = null
  /** 401 alınan token: DB'de hâlâ "geçerli" görünse de kullanılmaz */
  private rejectedToken_: string | null = null
  private refreshing_: Promise<string> | null = null
  /** Testler: OAuth uçlarına giden fetch */
  oauthTransport_: ParasutTransport | null = null
  /** Testler: veritabanı yerine sabit token */
  private tokenProviderOverride_: ParasutTokenProvider | null = null

  constructor(container: InjectedDependencies, options?: ParasutRawOptions) {
    // eslint-disable-next-line prefer-rest-params
    super(...(arguments as unknown as [InjectedDependencies]))
    this.logger_ = container.logger
    this.options_ = normalizeOptions(options ?? {})

    if (isMockMode(this.options_)) {
      this.logger_.info(
        "[parasut] Credentials missing/placeholder — mock mode (no real HTTP)"
      )
    } else {
      this.logger_.info(
        `[parasut] Live mode — company=${this.options_.companyId} env=${this.options_.env}; bağlantı admin → Paraşüt sayfasından`
      )
    }
    if (this.options_.dryRun || isParasutDryRun(this.options_)) {
      this.logger_.warn(
        "[parasut] DRY-RUN ON — taslak sales invoice oluşur; finalize/e-belge ASLA çağrılmaz"
      )
      if (isNonProdDeployment()) {
        this.logger_.warn(
          `[parasut] DRY-RUN zorlandı: PAYTR_OID_PREFIX=${(process.env.PAYTR_OID_PREFIX || "").trim()} (canlı dışı ortam). Canlıya geçerken öneki BOŞALT.`
        )
      }
      this.logger_.warn(
        `[parasut] DRY-RUN product create=${this.options_.productCreate ? "AÇIK (PARASUT_PRODUCT_CREATE)" : "kapalı — yalnızca mevcut ürünler aranır"}`
      )
    }
  }

  static validateOptions(options: Record<string, unknown>) {
    for (const key of ["clientId", "clientSecret", "companyId"] as const) {
      if (isPlaceholderCredential(options[key] as string)) {
        console.warn(
          `[parasut] Missing/placeholder "${key}". Mock mode until PARASUT_* env is set.`
        )
      }
    }
  }

  // --- OAuth bağlantısı ---

  private repo_(): TransactionalRepository {
    return (this as unknown as { baseRepository_: TransactionalRepository }).baseRepository_
  }

  private oauthConfig_() {
    return {
      issuer: this.options_.oauthIssuer,
      clientId: this.options_.clientId,
      clientSecret: this.options_.clientSecret,
      redirectUri: this.options_.redirectUri,
    }
  }

  private oauthTransport(): ParasutTransport {
    return (
      this.oauthTransport_ ??
      ((url, init) => (globalThis.fetch as unknown as ParasutTransport)(url, init))
    )
  }

  private async readRow_(manager: SqlManager, forUpdate: boolean): Promise<ConnectionRow | null> {
    const rows = (await manager.execute(
      `select ${ROW_COLUMNS} from parasut_connection where id = ? and deleted_at is null${forUpdate ? " for update" : ""}`,
      [CONNECTION_ID]
    )) as ConnectionRow[]
    return rows[0] ?? null
  }

  private isRowForThisClient_(row: ConnectionRow | null): boolean {
    return Boolean(
      row && row.client_id === this.options_.clientId && row.env === this.options_.env
    )
  }

  async getAuthorizationStatus(): Promise<ParasutAuthorizationStatus> {
    const row = isMockMode(this.options_)
      ? null
      : await this.repo_().transaction((m) => this.readRow_(m, false))
    const forThisClient = this.isRowForThisClient_(row)
    return {
      connected: Boolean(row?.refresh_token) && forThisClient,
      stale: Boolean(row?.refresh_token) && !forThisClient,
      connectedAt: iso(row?.connected_at),
      connectedBy: row?.connected_by ?? null,
      lastRefreshedAt: iso(row?.last_refreshed_at),
      refreshExpiresAt: iso(row?.refresh_expires_at),
      lastError: row?.last_error ?? null,
      lastErrorAt: iso(row?.last_error_at),
    }
  }

  /** Yetkilendirme adresi üretir; state + PKCE verifier 10 dk saklanır. */
  async startAuthorization(actorId?: string | null): Promise<{ url: string; expiresAt: string }> {
    if (isMockMode(this.options_)) {
      throw new ParasutError(
        "PARASUT_CLIENT_ID / PARASUT_CLIENT_SECRET / PARASUT_COMPANY_ID tanımlı değil (mock mod).",
        { retryable: false }
      )
    }
    const state = createOAuthState()
    const verifier = createCodeVerifier()
    const expiresAt = new Date(Date.now() + PENDING_TTL_MS)
    await this.repo_().transaction((m) =>
      m.execute(
        `insert into parasut_connection (id, pending_state, pending_verifier, pending_expires_at, pending_actor)
         values (?, ?, ?, ?, ?)
         on conflict (id) do update set pending_state = excluded.pending_state,
           pending_verifier = excluded.pending_verifier, pending_expires_at = excluded.pending_expires_at,
           pending_actor = excluded.pending_actor, deleted_at = null, updated_at = now()`,
        [CONNECTION_ID, state, verifier, expiresAt, actorId || null]
      )
    )
    return {
      url: buildAuthorizationUrl(this.oauthConfig_(), state, verifier),
      expiresAt: expiresAt.toISOString(),
    }
  }

  /**
   * Geri dönüş: state doğrulanır (tek kullanımlık), code token'a çevrilir, token sahibinin
   * PARASUT_COMPANY_ID firmasına erişimi kontrol edilir, refresh token saklanır.
   */
  async completeAuthorization(input: { code: string; state: string; iss?: string | null }) {
    if (isMockMode(this.options_)) {
      throw new ParasutError("Paraşüt mock modda; bağlanacak istemci yok.", { retryable: false })
    }
    if (input.iss && input.iss.replace(/\/$/, "") !== this.options_.oauthIssuer) {
      throw new ParasutError(`Beklenmeyen kimlik sağlayıcı: ${input.iss}`, { retryable: false })
    }
    const result = await this.repo_().transaction(async (m) => {
      const row = await this.readRow_(m, true)
      const valid =
        row?.pending_state &&
        row.pending_verifier &&
        time(row.pending_expires_at) > Date.now() &&
        sameSecret(row.pending_state, input.state)
      if (!valid) {
        return { error: "Bağlantı isteği geçersiz ya da süresi doldu. Admin'den yeniden başlatın." } as const
      }
      // State tek kullanımlık: token değişimi başarısız olsa da silinir.
      await m.execute(
        `update parasut_connection set pending_state = null, pending_verifier = null,
           pending_expires_at = null, updated_at = now() where id = ?`,
        [CONNECTION_ID]
      )
      let token: ParasutTokenResponse
      try {
        token = await exchangeAuthorizationCode(this.oauthTransport(), this.oauthConfig_(), {
          code: input.code,
          codeVerifier: row!.pending_verifier!,
        }, this.options_.timeoutMs)
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) } as const
      }

      // Firma erişimi: yanlış kullanıcıyla bağlanılırsa faturalar başka firmaya gitmesin.
      const probe = new ParasutClient({
        ...this.options_,
        logger: this.logger_,
        tokenProvider: { getAccessToken: async () => token.accessToken, invalidate: () => {} },
      })
      let companies: string[]
      try {
        companies = await probe.listAccessibleCompanyIds()
      } catch (err) {
        return { error: `Paraşüt kullanıcı bilgisi okunamadı: ${err instanceof Error ? err.message : String(err)}` } as const
      }
      if (!companies.includes(this.options_.companyId)) {
        return {
          error: `Giriş yapan Paraşüt kullanıcısı ${this.options_.companyId} numaralı firmaya erişemiyor (erişebildikleri: ${companies.join(", ") || "yok"}). Doğru kullanıcıyla bağlanın ya da PARASUT_COMPANY_ID'yi düzeltin.`,
        } as const
      }

      await m.execute(
        `update parasut_connection set client_id = ?, env = ?, refresh_token = ?, refresh_expires_at = ?,
           access_token = ?, access_expires_at = ?, scope = ?, connected_at = now(), connected_by = ?,
           last_refreshed_at = now(), last_error = null, last_error_at = null, pending_actor = null,
           updated_at = now() where id = ?`,
        [
          this.options_.clientId,
          this.options_.env,
          token.refreshToken,
          token.refreshExpiresAt ? new Date(token.refreshExpiresAt) : null,
          token.accessToken,
          new Date(token.accessExpiresAt),
          token.scope,
          row!.pending_actor,
          CONNECTION_ID,
        ]
      )
      return { ok: true, token } as const
    })
    if ("error" in result) {
      throw new ParasutError(result.error!, { retryable: false })
    }
    this.access_ = { token: result.token.accessToken, expiresAt: result.token.accessExpiresAt }
    this.rejectedToken_ = null
    this.logger_.info(`[parasut] Bağlantı kuruldu company=${this.options_.companyId} env=${this.options_.env}`)
  }

  /** Yerel bağlantıyı siler. Paraşüt'teki uygulama izni Paraşüt'ten ayrıca kaldırılabilir. */
  async disconnect(): Promise<void> {
    await this.repo_().transaction((m) =>
      m.execute(
        `update parasut_connection set refresh_token = null, refresh_expires_at = null,
           access_token = null, access_expires_at = null, last_error = null, last_error_at = null,
           pending_state = null, pending_verifier = null, pending_expires_at = null, updated_at = now()
         where id = ?`,
        [CONNECTION_ID]
      )
    )
    this.access_ = null
  }

  /** ParasutTokenProvider: süreç önbelleği → DB → (kilit altında) yenileme. */
  async getAccessToken(): Promise<string> {
    const cached = this.access_
    if (cached && cached.expiresAt - ACCESS_SKEW_MS > Date.now() && cached.token !== this.rejectedToken_) {
      return cached.token
    }
    if (!this.refreshing_) {
      this.refreshing_ = this.loadOrRefresh_().finally(() => {
        this.refreshing_ = null
      })
    }
    return this.refreshing_
  }

  invalidateAccessToken(token: string): void {
    this.rejectedToken_ = token
    if (this.access_?.token === token) this.access_ = null
  }

  private async loadOrRefresh_(): Promise<string> {
    const rejected = this.rejectedToken_
    const outcome = await this.repo_().transaction(async (m) => {
      const row = await this.readRow_(m, true)
      if (!row?.refresh_token) {
        return { error: new ParasutError(
          "Paraşüt bağlantısı yok: Admin → Paraşüt sayfasından 'Paraşüt'e bağlan' yapın.",
          { retryable: false }
        ) }
      }
      if (!this.isRowForThisClient_(row)) {
        return { error: new ParasutError(
          "Paraşüt bağlantısı başka bir istemci/ortam için kurulmuş (PARASUT_CLIENT_ID ya da PARASUT_ENV değişti). Yeniden bağlanın.",
          { retryable: false }
        ) }
      }
      // Başka süreç az önce yenilediyse onu kullan.
      const dbExpires = time(row.access_expires_at)
      if (row.access_token && row.access_token !== rejected && dbExpires - ACCESS_SKEW_MS > Date.now()) {
        return { token: row.access_token, expiresAt: dbExpires }
      }
      try {
        const t = await refreshAccessToken(
          this.oauthTransport(),
          this.oauthConfig_(),
          row.refresh_token,
          this.options_.timeoutMs
        )
        await m.execute(
          `update parasut_connection set access_token = ?, access_expires_at = ?, refresh_token = ?,
             refresh_expires_at = coalesce(?, refresh_expires_at), last_refreshed_at = now(),
             last_error = null, last_error_at = null, updated_at = now() where id = ?`,
          [
            t.accessToken,
            new Date(t.accessExpiresAt),
            t.refreshToken,
            t.refreshExpiresAt ? new Date(t.refreshExpiresAt) : null,
            CONNECTION_ID,
          ]
        )
        return { token: t.accessToken, expiresAt: t.accessExpiresAt }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // invalid_grant: refresh token öldü (30 gün kullanılmadı / izin kaldırıldı) → bağlantı düşer.
        await m.execute(
          `update parasut_connection set last_error = ?, last_error_at = now(), updated_at = now()${
            err instanceof ParasutReauthorizeError
              ? ", refresh_token = null, access_token = null, access_expires_at = null"
              : ""
          } where id = ?`,
          [message.slice(0, 1000), CONNECTION_ID]
        )
        return { error: err }
      }
    })
    if ("error" in outcome) {
      this.access_ = null
      if (outcome.error instanceof ParasutReauthorizeError) {
        this.logger_.error(`[parasut] ${outcome.error.message}`)
      }
      throw outcome.error
    }
    this.access_ = { token: outcome.token, expiresAt: outcome.expiresAt }
    if (this.rejectedToken_ === rejected) this.rejectedToken_ = null
    return outcome.token
  }

  getOptions(): ParasutOptions {
    return this.options_
  }

  getConnectionStatus(): ParasutConnectionStatus {
    const mock = isMockMode(this.options_)
    return {
      mode: mock ? "mock" : "live",
      env: this.options_.env,
      clientIdConfigured: !isPlaceholderCredential(this.options_.clientId),
      companyIdConfigured: !isPlaceholderCredential(this.options_.companyId),
      baseUrl: this.options_.baseUrl,
      oauthIssuer: this.options_.oauthIssuer,
      redirectUri: this.options_.redirectUri,
      dryRun: this.options_.dryRun || isParasutDryRun(this.options_),
    }
  }

  isDryRun(): boolean {
    return this.options_.dryRun || isParasutDryRun(this.options_)
  }

  getDefaultVatRate(): number {
    return this.options_.defaultVatRate
  }

  /** Kargo kalemi KDV % — PARASUT_SHIPPING_VAT_RATE, default 20. */
  getShippingVatRate(): number {
    return this.options_.shippingVatRate
  }

  /** Stok eşitlemesi yalnız gerçek bağlantıda çalışır (mock'ta okunacak stok yok). */
  isStockConfigured(): boolean {
    return !isMockMode(this.options_)
  }

  /** Kimlikler var ve admin'den bağlanılmış: API çağrısı yapılabilir. */
  async isConnected(): Promise<boolean> {
    if (isMockMode(this.options_)) return false
    return (await this.getAuthorizationStatus()).connected
  }

  getStockOptions(): { apply: boolean; locationId: string; maxZeroRatio: number } {
    return {
      apply: this.options_.stockApply,
      locationId: this.options_.stockLocationId,
      maxZeroRatio: this.options_.stockMaxZeroRatio,
    }
  }

  /** Tüm ürünler (sayfa sayfa). Stok eşitlemesi ve eşleştirme raporu kullanır. */
  async listAllProducts(): Promise<ParasutProductRecord[]> {
    const client = this.getClient()
    const all: ParasutProductRecord[] = []
    for (let page = 1; page <= MAX_PRODUCT_PAGES; page++) {
      const { products, totalPages } = await client.listProductsPage(page)
      all.push(...products)
      if (!products.length || page >= totalPages) return all
    }
    throw new Error(`Paraşüt ürün listesi ${MAX_PRODUCT_PAGES} sayfayı aştı`)
  }

  getClient(): ParasutClient {
    if (!this.client_) {
      this.client_ = new ParasutClient({
        ...this.options_,
        logger: this.logger_,
        tokenProvider: this.tokenProviderOverride_ ?? {
          getAccessToken: () => this.getAccessToken(),
          invalidate: (token) => this.invalidateAccessToken(token),
        },
      })
    }
    return this.client_
  }

  /**
   * Smoke / derin test: client'ı mock-fail veya sayaçlı instance ile değiştir.
   * Prod akışında çağrılmamalı.
   */
  replaceClientForTests(client: ParasutClient | null) {
    this.client_ = client
  }

  /** Testler: bağlantı tablosu olmadan canlı istemci (sabit access token). */
  replaceTokenProviderForTests(provider: ParasutTokenProvider | null) {
    this.tokenProviderOverride_ = provider
    this.client_ = null
  }

  async ensureContact(input: ParasutContactInput): Promise<ParasutContactResult> {
    return this.getClient().ensureContact(input)
  }

  async ensureProduct(
    input: ParasutProductInput
  ): Promise<ParasutProductResult | null> {
    return this.getClient().ensureProduct(input)
  }

  async createSalesInvoice(
    input: ParasutSalesInvoiceInput
  ): Promise<ParasutSalesInvoiceResult> {
    return this.getClient().createSalesInvoice(input)
  }

  async finalizeInvoice(
    input: ParasutFinalizeInput
  ): Promise<ParasutFinalizeResult> {
    if (this.isDryRun()) {
      this.logger_.error(
        `[parasut] DRY-RUN: service.finalizeInvoice BLOCKED invoice=${input.invoiceId}`
      )
      throw new Error(
        "DRY-RUN: finalizeInvoice blocked — no e_archive/e_invoice formalization"
      )
    }
    return this.getClient().finalizeInvoice(input)
  }

  async getInvoicePdf(
    invoiceId: string,
    formal?: { formalId?: string | null; invoiceType?: ParasutInvoiceType | null }
  ): Promise<ParasutPdfResult> {
    return this.getClient().getInvoicePdf(invoiceId, formal)
  }

  async findSalesInvoiceByReferenceKey(referenceKey: string): Promise<string | null> {
    return this.getClient().findSalesInvoiceByReferenceKey(referenceKey)
  }

  async cancelInvoice(invoiceId: string): Promise<ParasutCancelResult> {
    return this.getClient().cancelInvoice(invoiceId)
  }

  async createRefundInvoice(
    input: ParasutRefundInvoiceInput
  ): Promise<ParasutRefundInvoiceResult> {
    if (this.isDryRun()) {
      this.logger_.error(
        `[parasut] DRY-RUN: service.createRefundInvoice BLOCKED return=${input.returnId}`
      )
      throw new Error(
        "DRY-RUN: createRefundInvoice blocked — no refund formalization"
      )
    }
    return this.getClient().createRefundInvoice(input)
  }
}

export default ParasutModuleService

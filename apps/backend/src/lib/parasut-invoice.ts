/**
 * Satış faturası: order → contact → sales invoice → e_archive/e_invoice → metadata.parasut_invoice.
 *
 * Tutarlar: Medusa KDV dahil → Paraşüt unit_price KDV hariç, major-unit TL (×100 YOK).
 *
 * Çift fatura koruması:
 *  - gönderim sipariş kilidi altında, satış faturası isteğinden önce `pending` yazılır
 *  - satış faturası isteğinin sonucu belirsizse (zaman aşımı / 5xx) `unknown` olur,
 *    admin Paraşüt'te kontrol edip onay vermeden tekrar gitmez
 *  - satış faturası açıldıysa (invoice_id var) tekrar deneme yeni fatura AÇMAZ,
 *    aynı faturayı resmileştirir
 *  - toplam siparişle tutmuyorsa hiç gönderilmez
 */

import type { MedusaContainer } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils"
import { formatOrderNumber } from "@escay/shared/order-number"
import {
  PARASUT_MODULE,
  type ParasutOrderInvoiceMeta,
} from "../modules/parasut"
import {
  ParasutError,
  formatParasutErrorBody,
} from "../modules/parasut/client"
import ParasutModuleService from "../modules/parasut/service"
import type {
  ParasutInternetSale,
  ParasutInvoiceLineInput,
} from "../modules/parasut/types"
import { isBankTransferOrder } from "./bank-transfer"
import { resolveInvoiceCustomer } from "./invoice-customer"
import { recordOpsEvent } from "./ops-events"
import { sendInvoiceIssuedEmail } from "./parasut-invoice-email"
import { parasutProductIdFromMetadata } from "./parasut-mapping-apply"
import { notifyParasutInvoiceProblem } from "./parasut-invoice-admin-notify"

export type IssueSalesInvoiceResult = {
  ok: boolean
  skipped?: boolean
  meta: ParasutOrderInvoiceMeta
}

export type IssueSalesInvoiceOptions = {
  /** Yalnızca DRY-RUN: mevcut metadata.parasut_invoice yok sayılır, taze taslak. Finalize yok. */
  forceFreshDraft?: boolean
  /** Admin Paraşüt'te kaydın olmadığını doğruladı: pending/unknown yeniden gönderilebilir. */
  confirmedNotInParasut?: boolean
}

/** Sipariş toplamı ile fatura toplamı arasında yuvarlama dışı kabul edilen fark (TL). */
const TOTAL_TOLERANCE = 0.05
/** KDV hariç birim fiyat 2 haneye yuvarlandığı için adet başına oluşabilecek sapma (TL). */
const ROUNDING_PER_UNIT = 0.01

export function asNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0
  if (typeof value === "string") {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  if (value != null && typeof value === "object" && "value" in value) {
    return asNumber((value as { value: unknown }).value)
  }
  if (
    value != null &&
    typeof (value as { toString?: () => string }).toString === "function"
  ) {
    const n = Number(String(value))
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100
}

/** Medusa major-unit → Parasut (aynı major unit, 2 ondalık). ×100 YOK. */
export function toParasutAmount(value: unknown): number {
  return roundMoney(asNumber(value))
}

/** KDV dahil brüt → KDV hariç net. net = brüt / (1 + vatRate/100) */
export function grossToNet(gross: number, vatRatePercent: number): number {
  const g = asNumber(gross)
  const r = asNumber(vatRatePercent)
  if (g === 0) return 0
  if (r <= 0) return roundMoney(g)
  return roundMoney(g / (1 + r / 100))
}

/** KDV hariç net → KDV dahil brüt (doğrulama). */
export function netToGross(net: number, vatRatePercent: number): number {
  const n = asNumber(net)
  const r = asNumber(vatRatePercent)
  if (n === 0) return 0
  if (r <= 0) return roundMoney(n)
  return roundMoney(n * (1 + r / 100))
}

function lineDiscountAmount(item: {
  discount_total?: unknown
  adjustments?: { amount?: unknown }[] | null
}): number {
  const fromTotal = toParasutAmount(item.discount_total)
  if (fromTotal > 0) return fromTotal
  return roundMoney(
    (item.adjustments || []).reduce((s, a) => s + Math.abs(asNumber(a.amount)), 0)
  )
}

/** Medusa tax_lines.rate → Parasut vat_rate (%). 1 → 1 (çay), 0.1 → 10, 10 → 10, 0.2 → 20. */
export function mapMedusaTaxRateToParasutVat(
  rate: unknown,
  fallback: number
): number {
  const r = asNumber(rate)
  if (r > 0) {
    // Medusa tax_rate.rate / tax_lines.rate YÜZDE saklar (çay: 1 = %1, kargo: 20 = %20).
    // 1'in altı kesir sayılır (0.01 → 1, 0.2 → 20). `r <= 1` olsaydı %1 → %100 olurdu.
    return r < 1 ? roundMoney(r * 100) : r
  }
  return fallback
}

/** Kargo KDV oranı siparişteki kargo vergi satırından (fatura KDV dökümü siparişle aynı olsun). */
export function shippingVatRateOf(
  order: { shipping_methods?: { tax_lines?: { rate?: unknown }[] | null }[] | null },
  fallback: number
): number {
  const rate = order.shipping_methods?.find((m) => m.tax_lines?.length)?.tax_lines?.[0]?.rate
  return rate == null ? fallback : mapMedusaTaxRateToParasutVat(rate, fallback)
}

/**
 * Parasut satırlarından tahmini KDV dahil toplam.
 * Kalem: (net_unit - net_discount) * qty * (1+vat) + kargo − fatura indirimi
 */
export function estimateGrossFromParasutLines(input: {
  lines: ParasutInvoiceLineInput[]
  shipping?: { amount: number; vatRate: number } | null
  orderDiscountNet?: number | null
  orderDiscountVatRate?: number
}): number {
  let sum = 0
  for (const line of input.lines) {
    const disc = line.discountValue || 0
    const netLine = (line.unitPrice - disc) * line.quantity
    sum += netToGross(netLine, line.vatRate)
  }
  if (input.shipping && input.shipping.amount > 0) {
    sum += netToGross(input.shipping.amount, input.shipping.vatRate)
  }
  const residualNet = asNumber(input.orderDiscountNet)
  if (residualNet > 0) {
    const vat = input.orderDiscountVatRate ?? 10
    sum -= netToGross(residualNet, vat)
  }
  return roundMoney(sum)
}

/**
 * Sipariş toplamı ile fatura tahmini arasındaki fark kabul edilebilir mi?
 * Birim fiyat yuvarlaması adet başına en çok 1 kuruş oynatır; bunu aşan fark
 * hesap hatasıdır ve fatura gönderilmez.
 */
export function totalDriftAllowed(
  estimatedGross: number,
  orderTotal: number,
  totalUnits: number
): boolean {
  const limit = TOTAL_TOLERANCE + ROUNDING_PER_UNIT * Math.max(0, totalUnits)
  return Math.abs(estimatedGross - orderTotal) <= roundMoney(limit) + 1e-9
}

type InvoicePaymentRow = {
  captures?: { amount?: unknown; created_at?: string | Date | null }[] | null
  refunds?: { amount?: unknown }[] | null
}

/** İlk tahsilatın günü (YYYY-MM-DD, İstanbul); yoksa undefined → bugün. */
export function firstCaptureDate(payments: InvoicePaymentRow[]): string | undefined {
  const dates = payments
    .flatMap((p) => p.captures || [])
    .map((c) => (c.created_at ? new Date(c.created_at) : null))
    .filter((d): d is Date => Boolean(d) && !Number.isNaN((d as Date).getTime()))
    .sort((a, b) => a.getTime() - b.getTime())
  if (!dates.length) return undefined
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul" }).format(dates[0])
}

/**
 * Canlı Parasut e-arşiv şablonu ile hizalı:
 *   Ödeme Şekli = KREDIKARTI/BANKAKARTI  (kısa "KREDIKARTI" DEĞİL)
 *   Ödeme Aracısı = PayTR
 * Havale siparişi: Ödeme Şekli = EFT/HAVALE, aracı alanına banka adı.
 * Tarih ödemenin tarihidir (fatura teslimde kesilir, ödeme günler önce alınmıştır).
 */
export function buildParasutInternetSale(
  paymentDate = new Date().toISOString().slice(0, 10),
  opts: { bankTransfer?: boolean } = {}
): ParasutInternetSale {
  // Açıkça verilen e-arşiv satış URL'i önce gelir; STOREFRONT_URL geçiş öncesi
  // IP adresi olabilir ve faturaya yanlış site yazılır.
  const rawUrl = (
    process.env.PARASUT_INTERNET_SALE_URL ||
    process.env.STOREFRONT_URL ||
    "https://market.esteacay.com"
  ).replace(/\/$/, "")
  let url = rawUrl
  try {
    const u = new URL(rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`)
    url = `${u.protocol}//${u.host}`
  } catch {
    url = "https://market.esteacay.com"
  }
  if (opts.bankTransfer) {
    return {
      url,
      payment_type: "EFT/HAVALE",
      payment_platform: (process.env.BANK_TRANSFER_BANK_NAME || "").trim() || "Banka",
      payment_date: paymentDate,
    }
  }
  return {
    url,
    payment_type: "KREDIKARTI/BANKAKARTI",
    payment_platform: "PayTR",
    payment_date: paymentDate,
  }
}

/** Metadata taze okunur: aynı anda yazan başka akışın alanları ezilmesin. */
async function writeInvoiceMeta(
  scope: MedusaContainer,
  orderId: string,
  invoiceMeta: ParasutOrderInvoiceMeta
) {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: ["metadata"],
    filters: { id: orderId },
  })
  const fresh = (data?.[0] as { metadata?: Record<string, unknown> | null } | undefined)
    ?.metadata
  await scope.resolve(Modules.ORDER).updateOrders([
    {
      id: orderId,
      metadata: { ...(fresh || {}), parasut_invoice: invoiceMeta },
    },
  ])
}

async function reportProblem(
  scope: MedusaContainer,
  orderId: string,
  meta: ParasutOrderInvoiceMeta
) {
  const logger = scope.resolve(ContainerRegistrationKeys.LOGGER)
  await recordOpsEvent(scope, {
    kind: "invoice.failed",
    level: "error",
    title:
      meta.status === "unknown"
        ? "Paraşüt faturası belirsiz — Paraşüt'ten kontrol edin"
        : "Paraşüt faturası kesilemedi",
    detail: meta.error,
    orderId,
    data: { status: meta.status, retry_count: meta.retry_count ?? 0 },
    once: true,
  })
  try {
    await notifyParasutInvoiceProblem(scope, orderId, meta)
  } catch (err) {
    logger.warn(`[parasut-invoice] Admin notify failed order=${orderId}: ${String(err)}`)
  }
}

/** variant_id → metadata.parasut_product_id (parasut-apply-mapping ile yazılır). */
async function loadVariantParasutProductIds(
  query: { graph: (args: Record<string, unknown>) => Promise<{ data: unknown[] }> },
  variantIds: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const ids = [...new Set(variantIds.filter(Boolean))]
  if (!ids.length) return out
  const { data } = await query.graph({
    entity: "product_variant",
    fields: ["id", "metadata"],
    filters: { id: ids },
  })
  for (const v of data as { id: string; metadata?: Record<string, unknown> | null }[]) {
    const pid = parasutProductIdFromMetadata(v.metadata)
    if (pid) out.set(v.id, pid)
  }
  return out
}

/** İstek Paraşüt'e ulaşmış ve işlenmiş olabilir mi? (4xx kesin rettir.) */
function isUncertainFailure(err: unknown): boolean {
  if (err instanceof ParasutError) {
    return err.status == null ? false : err.status >= 500
  }
  // ParasutError dışı: ağ hatası / zaman aşımı (AbortError) — yanıt alınamadı
  return true
}

/** Sipariş teslim edildikten sonra e-arşiv / e-fatura kes. */
export async function issueSalesInvoiceForOrder(
  scope: MedusaContainer,
  orderId: string,
  options?: IssueSalesInvoiceOptions
): Promise<IssueSalesInvoiceResult> {
  // Aynı sipariş için eşzamanlı iki gönderim (tekrarlanan event, job, admin) çift fatura keser.
  const locking = scope.resolve(Modules.LOCKING) as {
    execute: <T>(
      keys: string | string[],
      job: () => Promise<T>,
      args?: { timeout?: number; ttl?: number }
    ) => Promise<T>
  }
  return locking.execute(
    `parasut-invoice:${orderId}`,
    () => issueUnderLock(scope, orderId, options),
    { timeout: 90, ttl: 240 }
  )
}

async function issueUnderLock(
  scope: MedusaContainer,
  orderId: string,
  options?: IssueSalesInvoiceOptions
): Promise<IssueSalesInvoiceResult> {
  const logger = scope.resolve(ContainerRegistrationKeys.LOGGER)
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "status",
      "email",
      "currency_code",
      "metadata",
      "total",
      "discount_total",
      "shipping_total",
      "items.id",
      "items.title",
      "items.quantity",
      // Sipariş kalemi adedi order_item'da (detail) durur; yalnız "items.quantity"
      // istenirse Medusa adedi boş döner ve toplamlar 0 hesaplanır.
      "items.detail.quantity",
      "items.unit_price",
      // Olmazsa birim fiyat KDV hariç sanılıp KDV iki kez düşülür.
      "items.is_tax_inclusive",
      "items.variant_sku",
      "items.variant_id",
      "items.discount_total",
      "items.tax_lines.rate",
      "items.adjustments.amount",
      "shipping_methods.tax_lines.rate",
      "payment_collections.payments.captures.amount",
      "payment_collections.payments.captures.created_at",
      "payment_collections.payments.refunds.amount",
      "shipping_address.first_name",
      "shipping_address.last_name",
      "shipping_address.phone",
      "shipping_address.city",
      "shipping_address.province",
      "shipping_address.address_1",
      "shipping_address.address_2",
      "shipping_address.metadata",
      "billing_address.first_name",
      "billing_address.last_name",
      "billing_address.phone",
      "billing_address.city",
      "billing_address.province",
      "billing_address.address_1",
      "billing_address.address_2",
      "billing_address.metadata",
      "customer.id",
      "customer.email",
      "customer.first_name",
      "customer.last_name",
      "customer.metadata",
    ],
    filters: { id: orderId },
  })

  type Address = {
    first_name?: string | null
    last_name?: string | null
    phone?: string | null
    city?: string | null
    province?: string | null
    address_1?: string | null
    address_2?: string | null
    metadata?: Record<string, unknown> | null
  }
  const order = orders?.[0] as
    | {
        id: string
        display_id?: number | string | null
        status?: string | null
        email?: string | null
        currency_code?: string | null
        metadata?: Record<string, unknown> | null
        total?: unknown
        discount_total?: unknown
        shipping_total?: unknown
        items?: {
          id: string
          title?: string | null
          quantity?: unknown
          detail?: { quantity?: unknown } | null
          unit_price?: unknown
          is_tax_inclusive?: boolean | null
          variant_sku?: string | null
          variant_id?: string | null
          discount_total?: unknown
          tax_lines?: { rate?: unknown }[] | null
          adjustments?: { amount?: unknown }[] | null
        }[]
        shipping_address?: Address | null
        billing_address?: Address | null
        shipping_methods?: { tax_lines?: { rate?: unknown }[] | null }[] | null
        payment_collections?: { payments?: InvoicePaymentRow[] | null }[] | null
        customer?: {
          id?: string | null
          email?: string | null
          first_name?: string | null
          last_name?: string | null
          metadata?: Record<string, unknown> | null
        } | null
      }
    | undefined

  if (!order?.id) {
    logger.error(`[parasut-invoice] Order not found id=${orderId}`)
    return {
      ok: false,
      meta: {
        status: "error",
        mode: "mock",
        error: "Order not found",
        at: new Date().toISOString(),
      },
    }
  }

  const parasut = scope.resolve(PARASUT_MODULE) as ParasutModuleService
  const mode = parasut.getConnectionStatus().mode
  const dryRun = parasut.isDryRun()
  const sendsForReal = mode === "live" && !dryRun

  const existing = (order.metadata?.parasut_invoice ||
    null) as ParasutOrderInvoiceMeta | null
  const forceFreshDraft = options?.forceFreshDraft === true && dryRun
  if (options?.forceFreshDraft === true && !dryRun) {
    logger.warn(
      `[parasut-invoice] forceFreshDraft yok sayıldı — PARASUT_DRY_RUN kapalı (finalize yolu korunur)`
    )
  }

  // Mock / dry-run sonucu gerçek fatura değildir: gerçek bağlantı açılınca fatura kesilir
  // (yoksa kimlikler sonradan girilse de bu siparişler "kesildi" sanılıp hiç kesilmez).
  const existingIsMock = existing?.mode === "mock"
  const promoteToReal =
    sendsForReal &&
    Boolean(existing) &&
    ((existing!.status === "issued" && existingIsMock) ||
      existing!.status === "draft_dryrun")

  if (!forceFreshDraft && !promoteToReal) {
    if (existing?.status === "issued" && existing.invoice_id) {
      logger.info(
        `[parasut-invoice] Idempotent skip — order=${orderId} invoice=${existing.invoice_number || existing.invoice_id}`
      )
      return { ok: true, skipped: true, meta: existing }
    }
    if (existing?.status === "draft_dryrun" && existing.invoice_id) {
      logger.info(
        `[parasut-invoice] DRY-RUN idempotent skip — order=${orderId} draft=${existing.invoice_id} (resmileştirilmedi)`
      )
      return { ok: true, skipped: true, meta: existing }
    }
  } else if (promoteToReal) {
    logger.warn(
      `[parasut-invoice] Önceki kayıt ${existing!.mode}/${existing!.status} — order=${orderId}; gerçek fatura şimdi kesiliyor`
    )
  }

  // Satış faturası isteği yarıda kaldı / sonucu bilinmiyor: Paraşüt'te kayıt olabilir.
  const createUncertain =
    existing?.status === "unknown" ||
    (existing?.status === "pending" && !existing.invoice_id)
  if (createUncertain && !forceFreshDraft && !options?.confirmedNotInParasut) {
    logger.warn(
      `[parasut-invoice] Skip — order=${orderId} status=${existing!.status}: kayıt açılmış olabilir, admin onayı gerekir`
    )
    return { ok: false, skipped: true, meta: existing! }
  }

  // Parası tamamen iade edilmiş (iptalsiz) sipariş faturalanmaz.
  const payments = (order.payment_collections || []).flatMap((pc) => pc.payments || [])
  const capturedTotal = payments.reduce(
    (s, p) => s + (p.captures || []).reduce((a, c) => a + asNumber(c.amount), 0),
    0
  )
  const refundedTotal = payments.reduce(
    (s, p) => s + (p.refunds || []).reduce((a, r) => a + asNumber(r.amount), 0),
    0
  )
  const skipReason =
    order.status === "canceled"
      ? { error: "Order canceled", note: "canceled" }
      : capturedTotal > 0 && refundedTotal >= capturedTotal - 0.01
        ? { error: "Order fully refunded", note: "refunded" }
        : null
  if (skipReason) {
    const meta: ParasutOrderInvoiceMeta = {
      status: "skipped",
      mode: existing?.mode || mode,
      // Açılmış taslak varsa kaybolmasın (Paraşüt'ten silinmesi gerekebilir)
      invoice_id: existing?.invoice_id,
      contact_id: existing?.contact_id,
      ...skipReason,
      at: new Date().toISOString(),
    }
    await writeInvoiceMeta(scope, orderId, meta)
    return { ok: false, skipped: true, meta }
  }

  const vatDefault = parasut.getDefaultVatRate()
  const displayId =
    formatOrderNumber(order.display_id) || String(order.display_id ?? order.id)

  // Fatura adresi metadata'sı önce; müşteri kartı yalnız invoice_type'sız eski siparişte.
  const invoiceCustomer = resolveInvoiceCustomer(order)
  const taxNumber = invoiceCustomer.taxNo
  const internetSale = buildParasutInternetSale(firstCaptureDate(payments), {
    bankTransfer: isBankTransferOrder(order),
  })

  // Devam edilecek satış faturası: yalnız aynı (canlı) bağlantıda açılmış gerçek kayıt.
  const resumeInvoiceId =
    !forceFreshDraft &&
    existing?.invoice_id &&
    existing.mode === mode &&
    (existing.status === "pending" ||
      existing.status === "error" ||
      existing.status === "draft_dryrun")
      ? existing.invoice_id
      : undefined

  const carry = {
    retry_count: existing?.retry_count,
    admin_notified_at: existing?.admin_notified_at,
  }
  const invoicedItems = (order.items || []).map((item) => ({
    line_item_id: item.id,
    quantity: Math.max(1, asNumber(item.detail?.quantity) || asNumber(item.quantity) || 1),
  }))
  const orderTotal = toParasutAmount(order.total)

  /** Hata anında hangi adımdaydık: satış faturası açılmış mıydı? */
  let invoiceId: string | undefined = resumeInvoiceId
  let contactId: string | undefined = resumeInvoiceId ? existing?.contact_id : undefined
  let creating = false

  const finalizeAndStore = async (note?: string): Promise<IssueSalesInvoiceResult> => {
    const formal = await parasut.finalizeInvoice({
      invoiceId: invoiceId!,
      taxNumber,
      orderId: order.id,
      internetSale,
    })
    let pdfUrl: string | undefined
    try {
      pdfUrl = (await parasut.getInvoicePdf(invoiceId!)).pdfUrl
    } catch (pdfErr) {
      logger.warn(`[parasut-invoice] PDF alınamadı order=${orderId}: ${String(pdfErr)}`)
    }
    const meta: ParasutOrderInvoiceMeta = {
      status: "issued",
      mode,
      contact_id: contactId,
      invoice_id: invoiceId,
      formal_id: formal.formalId,
      invoice_number: formal.invoiceNumber,
      invoice_type: formal.invoiceType,
      pdf_url: pdfUrl,
      tax_number: taxNumber,
      total: orderTotal,
      items: invoicedItems,
      at: new Date().toISOString(),
      note,
      retry_count: existing?.retry_count,
    }
    try {
      await writeInvoiceMeta(scope, orderId, meta)
    } catch (markErr) {
      // Fatura kesildi; metadata `pending` + invoice_id kalır, tekrar deneme yeni fatura açmaz.
      logger.error(
        `[parasut-invoice] Fatura kesildi ama metadata yazılamadı order=${orderId} no=${meta.invoice_number}: ${String(markErr)}`
      )
    }
    logger.info(
      `[parasut-invoice] Issued — order=${orderId} no=${meta.invoice_number} type=${meta.invoice_type} mode=${mode}`
    )
    try {
      await sendInvoiceIssuedEmail(scope, orderId, meta)
    } catch (mailErr) {
      logger.warn(`[parasut-invoice] Invoice email failed order=${orderId}: ${String(mailErr)}`)
    }
    return { ok: true, meta }
  }

  try {
    if (resumeInvoiceId) {
      // DRY-RUN: yarım kalmış kayıt bile resmileştirilmez
      if (dryRun) {
        logger.warn(
          `[parasut-invoice] DRY-RUN: resume finalize ATLANDI order=${orderId} invoice=${resumeInvoiceId}`
        )
        const meta: ParasutOrderInvoiceMeta = {
          ...existing!,
          status: "draft_dryrun",
          mode,
          note: "dry_run_resume_not_formalized",
          at: new Date().toISOString(),
        }
        await writeInvoiceMeta(scope, orderId, meta)
        return { ok: true, skipped: true, meta }
      }
      // Satış faturası var, resmileştirme kalmış — yeni fatura AÇMA
      logger.info(
        `[parasut-invoice] Resume formalize — order=${orderId} invoice=${resumeInvoiceId}`
      )
      return await finalizeAndStore(
        existing?.status === "draft_dryrun"
          ? "formalized_from_dry_run_draft"
          : "resumed_after_partial_failure"
      )
    }

    const variantProductIds = await loadVariantParasutProductIds(
      query as never,
      (order.items || []).map((item) => item.variant_id || "")
    )

    // KDV dahil (Medusa) → KDV hariç (Parasut)
    const lines: ParasutInvoiceLineInput[] = (order.items || []).map((item, index) => {
      const qty = invoicedItems[index].quantity
      const vatRate = mapMedusaTaxRateToParasutVat(item.tax_lines?.[0]?.rate, vatDefault)
      const rawUnit = toParasutAmount(item.unit_price)
      // Vergi satırı yoksa siparişe KDV eklenmemiştir; fiyat KDV dahil sayılır.
      const taxExclusive = item.is_tax_inclusive === false && Boolean(item.tax_lines?.length)
      const unit = taxExclusive ? rawUnit : grossToNet(rawUnit, vatRate)
      const lineDiscountGross = lineDiscountAmount(item)
      const discountValue =
        lineDiscountGross > 0
          ? grossToNet(roundMoney(lineDiscountGross / qty), vatRate)
          : undefined
      return {
        description: item.title || item.variant_sku || "Ürün",
        quantity: qty,
        unitPrice: unit,
        vatRate,
        discountValue,
        // SKU = Paraşüt ürün kodu; ad değişse de aynı ürüne bağlanır.
        productCode: item.variant_sku,
        productId: item.variant_id
          ? variantProductIds.get(item.variant_id) ?? null
          : null,
      }
    })

    const itemsDiscountSumGross = roundMoney(
      (order.items || []).reduce((s, item) => s + lineDiscountAmount(item), 0)
    )
    const residualOrderDiscountGross = roundMoney(
      Math.max(0, toParasutAmount(order.discount_total) - itemsDiscountSumGross)
    )
    const residualOrderDiscountNet =
      residualOrderDiscountGross > 0
        ? grossToNet(residualOrderDiscountGross, vatDefault)
        : null

    // Siparişin kargo vergi satırı; yoksa env (PARASUT_SHIPPING_VAT_RATE)
    const vatShipping = shippingVatRateOf(order, parasut.getShippingVatRate())
    const shippingGross = toParasutAmount(order.shipping_total)
    const shippingNet = shippingGross > 0 ? grossToNet(shippingGross, vatShipping) : 0

    const estimatedGross = estimateGrossFromParasutLines({
      lines,
      shipping: shippingNet > 0 ? { amount: shippingNet, vatRate: vatShipping } : null,
      orderDiscountNet: residualOrderDiscountNet,
      orderDiscountVatRate: vatDefault,
    })
    const totalUnits = lines.reduce((s, l) => s + l.quantity, 0)
    if (!totalDriftAllowed(estimatedGross, orderTotal, totalUnits)) {
      throw new ParasutError(
        `Fatura toplamı siparişle tutmuyor: fatura=${estimatedGross} sipariş=${orderTotal}. Gönderilmedi.`,
        { retryable: false }
      )
    }
    if (Math.abs(estimatedGross - orderTotal) > TOTAL_TOLERANCE) {
      logger.warn(
        `[parasut-invoice] Yuvarlama farkı order=${orderId} fatura=${estimatedGross} sipariş=${orderTotal} adet=${totalUnits}`
      )
    }

    const customer = invoiceCustomer.customer
    const contact = await parasut.ensureContact({
      orderId: order.id,
      name: customer.title,
      email: customer.email,
      taxNumber,
      taxOffice: customer.taxOffice,
      phone: customer.phone,
      city: customer.city,
      district: customer.district,
      address: customer.street || customer.address,
    })
    contactId = contact.contactId

    await writeInvoiceMeta(scope, orderId, {
      ...carry,
      status: "pending",
      mode,
      contact_id: contactId,
      tax_number: taxNumber,
      total: orderTotal,
      at: new Date().toISOString(),
      note: "creating_sales_invoice",
    })

    creating = true
    const sales = await parasut.createSalesInvoice({
      contactId: contact.contactId,
      orderId: order.id,
      orderDisplayId: displayId,
      currencyCode: order.currency_code || "TRY",
      description: `Es Çay sipariş ${displayId}`,
      lines,
      orderDiscount: residualOrderDiscountNet,
      shipping:
        shippingNet > 0
          ? { description: "Kargo", amount: shippingNet, vatRate: vatShipping }
          : null,
    })
    creating = false
    invoiceId = sales.invoiceId

    if (dryRun) {
      const draftMeta: ParasutOrderInvoiceMeta = {
        ...carry,
        status: "draft_dryrun",
        mode,
        contact_id: contactId,
        invoice_id: invoiceId,
        tax_number: taxNumber,
        total: orderTotal,
        // Taslak da Paraşüt'te gerçek satış faturasıdır ve stoğu düşer.
        items: invoicedItems,
        at: new Date().toISOString(),
        note: "dry_run_draft_not_formalized",
      }
      await writeInvoiceMeta(scope, orderId, draftMeta)
      logger.info(
        `[parasut-invoice] DRY-RUN: taslak oluşturuldu, resmileştirilmedi, id=${invoiceId} order=${orderId}`
      )
      return { ok: true, meta: draftMeta }
    }

    await writeInvoiceMeta(scope, orderId, {
      ...carry,
      status: "pending",
      mode,
      contact_id: contactId,
      invoice_id: invoiceId,
      tax_number: taxNumber,
      total: orderTotal,
      // Satış faturası Paraşüt stoğunu düşer; resmileşmese de stok hesabı bunu bilmeli.
      items: invoicedItems,
      at: new Date().toISOString(),
      note: "sales_invoice_created_awaiting_formalization",
    })

    return await finalizeAndStore()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const apiBody =
      err instanceof ParasutError ? formatParasutErrorBody(err.responseBody) : ""
    if (apiBody) {
      logger.error(`[parasut-invoice] Parasut API error body order=${orderId}: ${apiBody}`)
    }
    // Yalnız satış faturası isteği belirsiz olabilir: yanıt gelmediyse kayıt açılmış olabilir.
    const uncertain = creating && !invoiceId && isUncertainFailure(err)
    const meta: ParasutOrderInvoiceMeta = {
      ...carry,
      status: uncertain ? "unknown" : "error",
      mode,
      tax_number: taxNumber,
      invoice_id: invoiceId,
      contact_id: contactId,
      total: orderTotal,
      items: invoiceId ? invoicedItems : undefined,
      error: message.slice(0, 1500),
      at: new Date().toISOString(),
      note: uncertain
        ? "sales_invoice_result_unknown"
        : invoiceId
          ? "partial_failure_invoice_id_preserved"
          : "invoice_not_created",
      retry_count: existing?.retry_count || 0,
    }
    try {
      await writeInvoiceMeta(scope, orderId, meta)
    } catch (markErr) {
      logger.error(
        `[parasut-invoice] Failed to mark ${meta.status} — order=${orderId}: ${String(markErr)}`
      )
    }
    logger.error(
      `[parasut-invoice] ${meta.status.toUpperCase()} (yasal risk — fatura kesilemedi) order=${orderId}: ${message}`
    )
    await reportProblem(scope, orderId, meta)
    return { ok: false, meta }
  }
}

/** Süresi geçmiş, satış faturası açılmadan kalmış `pending`: belirsiz sayılır, uyarı gider. */
export async function markStalePendingInvoiceUnknown(
  scope: MedusaContainer,
  orderId: string,
  existing: ParasutOrderInvoiceMeta
): Promise<void> {
  const meta: ParasutOrderInvoiceMeta = {
    ...existing,
    status: "unknown",
    error:
      "Gönderim yarıda kaldı; satış faturası açılmış olabilir. Paraşüt'te sipariş numarasıyla kontrol edin.",
    at: new Date().toISOString(),
  }
  await writeInvoiceMeta(scope, orderId, meta)
  await reportProblem(scope, orderId, meta)
}

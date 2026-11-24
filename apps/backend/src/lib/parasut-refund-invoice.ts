/**
 * İade faturası: escay.return_refunded sonrası.
 *
 * Varsayılan: iade faturası Paraşüt'ten elle kesilir; iş kaybolmasın diye metadata +
 * olay bırakılır. PARASUT_REFUND_INVOICE_AUTO=true ise Paraşüt API'siyle kesilir.
 * Reddedilen iade → işlem YOK. Idempotent: aynı return_id için ikinci kez çalışmaz.
 */

import type { MedusaContainer } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils"
import {
  PARASUT_MODULE,
  isRefundInvoiceAuto,
  type ParasutOrderInvoiceMeta,
  type ParasutRefundInvoiceMeta,
} from "../modules/parasut"
import ParasutModuleService from "../modules/parasut/service"
import { recordOpsEvent } from "./ops-events"
import { asNumber, roundMoney } from "./parasut-invoice"
import { notifyRefundInvoiceProblem } from "./parasut-invoice-admin-notify"
import { isReturnRejected } from "./return-rejection"

export type RefundInvoiceResult = {
  ok: boolean
  skipped?: boolean
  meta: ParasutRefundInvoiceMeta
}

function readRefundMap(
  orderMeta: Record<string, unknown> | null | undefined
): Record<string, ParasutRefundInvoiceMeta> {
  const raw = orderMeta?.parasut_refund_invoices
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  return { ...(raw as Record<string, ParasutRefundInvoiceMeta>) }
}

/** Metadata taze okunur: aynı anda yazan başka akışın alanları ezilmesin. */
async function writeRefundMeta(
  scope: MedusaContainer,
  orderId: string,
  meta: ParasutRefundInvoiceMeta
) {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: ["metadata"],
    filters: { id: orderId },
  })
  const fresh = (data?.[0] as { metadata?: Record<string, unknown> | null } | undefined)
    ?.metadata
  const map = readRefundMap(fresh)
  map[meta.return_id] = meta
  await scope.resolve(Modules.ORDER).updateOrders([
    { id: orderId, metadata: { ...(fresh || {}), parasut_refund_invoices: map } },
  ])
}

export async function issueRefundInvoiceForReturn(
  scope: MedusaContainer,
  input: {
    return_id: string
    order_id: string
    amount: number
  }
): Promise<RefundInvoiceResult> {
  const logger = scope.resolve(ContainerRegistrationKeys.LOGGER)
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const returnId = input.return_id
  const orderId = input.order_id
  const amount = roundMoney(asNumber(input.amount))
  const at = new Date().toISOString()

  const parasut = scope.resolve(PARASUT_MODULE) as ParasutModuleService
  const mode = parasut.getConnectionStatus().mode

  const { data: returns } = await query.graph({
    entity: "return",
    fields: ["id", "metadata"],
    filters: { id: returnId },
  })
  const ret = returns?.[0] as
    | { metadata?: Record<string, unknown> | null }
    | undefined

  // CRITICAL: rejected → fatura hareketi YOK
  if (ret && isReturnRejected(ret.metadata)) {
    logger.info(`[parasut-refund] Skip — return=${returnId} rejected`)
    return {
      ok: false,
      skipped: true,
      meta: { status: "skipped", mode, return_id: returnId, note: "escay_rejection", at },
    }
  }
  if (amount <= 0) {
    return {
      ok: false,
      skipped: true,
      meta: { status: "skipped", mode, return_id: returnId, amount: 0, note: "zero_amount", at },
    }
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["id", "metadata", "currency_code"],
    filters: { id: orderId },
  })
  const order = orders?.[0] as
    | { id: string; metadata?: Record<string, unknown> | null; currency_code?: string | null }
    | undefined
  if (!order?.id) {
    logger.error(`[parasut-refund] Order not found order=${orderId} return=${returnId}`)
    return {
      ok: false,
      meta: { status: "skipped", mode, return_id: returnId, amount, note: "order_not_found", at },
    }
  }

  const previous = readRefundMap(order.metadata)[returnId]
  if (previous && previous.status !== "error") {
    return { ok: true, skipped: true, meta: previous }
  }

  const sales = (order.metadata?.parasut_invoice ||
    null) as ParasutOrderInvoiceMeta | null
  const salesIssued = sales?.status === "issued" && Boolean(sales.invoice_id)

  // Elle kesim: otomatik kapalı, dry-run, ya da bağlanacak resmi satış faturası yok
  // (fatura teslimde kesilir; teslimden önce iade edilen sipariş faturasızdır).
  const manualReason = !isRefundInvoiceAuto()
    ? "auto_disabled"
    : parasut.isDryRun()
      ? "dry_run"
      : !salesIssued
        ? "no_sales_invoice"
        : null

  if (manualReason) {
    const meta: ParasutRefundInvoiceMeta = {
      status: "manual_required",
      mode,
      return_id: returnId,
      amount,
      sales_invoice_id: sales?.invoice_id,
      note: manualReason,
      at,
    }
    await writeRefundMeta(scope, orderId, meta)
    await recordOpsEvent(scope, {
      kind: "invoice.refund_manual",
      level: "warning",
      title: `İade faturası Paraşüt'ten elle kesilecek — ${amount.toFixed(2)} TL`,
      orderId,
      data: {
        return_id: returnId,
        amount,
        sales_invoice_id: sales?.invoice_id ?? null,
        invoice_number: sales?.invoice_number ?? null,
      },
    })
    try {
      await notifyRefundInvoiceProblem(scope, {
        order_id: orderId,
        return_id: returnId,
        amount,
      })
    } catch (err) {
      logger.warn(`[parasut-refund] Admin notify failed return=${returnId}: ${String(err)}`)
    }
    logger.warn(
      `[parasut-refund] Elle kesilecek (${manualReason}) — return=${returnId} amount=${amount}`
    )
    return { ok: true, meta }
  }

  try {
    const result = await parasut.createRefundInvoice({
      originalInvoiceId: sales!.invoice_id!,
      orderId,
      returnId,
      amount,
      currencyCode: order.currency_code || "TRY",
      description: `Es Çay iade ${returnId}`,
    })
    const meta: ParasutRefundInvoiceMeta = {
      status: "issued",
      mode,
      return_id: returnId,
      sales_invoice_id: sales!.invoice_id,
      refund_invoice_id: result.refundInvoiceId,
      invoice_number: result.invoiceNumber,
      invoice_type: result.invoiceType,
      amount: result.amount,
      pdf_url: result.pdfUrl,
      at,
    }
    await writeRefundMeta(scope, orderId, meta)
    logger.info(
      `[parasut-refund] Issued — return=${returnId} no=${meta.invoice_number} amount=${amount} mode=${mode}`
    )
    return { ok: true, meta }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const meta: ParasutRefundInvoiceMeta = {
      status: "error",
      mode,
      return_id: returnId,
      sales_invoice_id: sales!.invoice_id,
      amount,
      error: message.slice(0, 500),
      at,
    }
    try {
      await writeRefundMeta(scope, orderId, meta)
    } catch (markErr) {
      logger.error(`[parasut-refund] Failed to mark error — return=${returnId}: ${String(markErr)}`)
    }
    logger.error(`[parasut-refund] FAILED (yasal risk) return=${returnId}: ${message}`)
    await recordOpsEvent(scope, {
      kind: "invoice.refund_manual",
      level: "error",
      title: `İade faturası kesilemedi, Paraşüt'ten elle kesin — ${amount.toFixed(2)} TL`,
      detail: meta.error,
      orderId,
      data: { return_id: returnId, amount, sales_invoice_id: sales!.invoice_id ?? null },
    })
    try {
      await notifyRefundInvoiceProblem(scope, {
        order_id: orderId,
        return_id: returnId,
        amount,
        error: meta.error || "bilinmeyen hata",
      })
    } catch (notifyErr) {
      logger.warn(`[parasut-refund] Admin notify failed return=${returnId}: ${String(notifyErr)}`)
    }
    return { ok: false, meta }
  }
}

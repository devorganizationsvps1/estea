/**
 * Fatura PDF'i: Paraşüt'ün PDF adresi süreli olduğu için saklanmaz.
 * Müşteri mailinde imzalı kalıcı bağlantı (/parasut/invoice-pdf?o=…&s=…) bulunur; açıldığında
 * Paraşüt'ten taze adres alınıp oraya yönlendirilir. Admin aynı işi oturumla yapar.
 */

import { createHmac, timingSafeEqual } from "node:crypto"

import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { PARASUT_MODULE, type ParasutOrderInvoiceMeta } from "../modules/parasut"
import type ParasutModuleService from "../modules/parasut/service"

export const INVOICE_PDF_PATH = "/parasut/invoice-pdf"

function linkSecret(): string {
  const secret = (process.env.PARASUT_PDF_LINK_SECRET || process.env.JWT_SECRET || "").trim()
  if (!secret) throw new Error("PARASUT_PDF_LINK_SECRET / JWT_SECRET tanımlı değil")
  return secret
}

export function signInvoicePdfOrder(orderId: string): string {
  return createHmac("sha256", linkSecret())
    .update(`parasut-invoice-pdf:${orderId}`)
    .digest("base64url")
}

export function verifyInvoicePdfSignature(orderId: string, signature: string): boolean {
  if (!orderId || !signature) return false
  const expected = Buffer.from(signInvoicePdfOrder(orderId))
  const given = Buffer.from(signature)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/** Müşteri mailindeki kalıcı PDF bağlantısı. */
export function invoicePdfLink(orderId: string): string {
  const base = (process.env.MEDUSA_BACKEND_PUBLIC_URL || "http://localhost:9000").replace(/\/$/, "")
  const params = new URLSearchParams({ o: orderId, s: signInvoicePdfOrder(orderId) })
  return `${base}${INVOICE_PDF_PATH}?${params.toString()}`
}

export class InvoicePdfUnavailableError extends Error {
  constructor(message: string, readonly httpStatus: 404 | 503) {
    super(message)
    this.name = "InvoicePdfUnavailableError"
  }
}

/** Kesilmiş faturanın şu an geçerli PDF adresi. */
export async function resolveInvoicePdfUrl(
  scope: MedusaContainer,
  orderId: string
): Promise<string> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: ["id", "metadata"],
    filters: { id: orderId },
  })
  const meta = (data?.[0] as { metadata?: Record<string, unknown> | null } | undefined)?.metadata
    ?.parasut_invoice as ParasutOrderInvoiceMeta | undefined
  if (!meta || meta.status !== "issued" || !meta.invoice_id) {
    throw new InvoicePdfUnavailableError("Bu sipariş için kesilmiş fatura yok.", 404)
  }
  if (meta.mode === "mock") {
    if (!meta.pdf_url) throw new InvoicePdfUnavailableError("Mock faturada PDF yok.", 404)
    return meta.pdf_url
  }
  const parasut = scope.resolve(PARASUT_MODULE) as ParasutModuleService
  try {
    const pdf = await parasut.getInvoicePdf(meta.invoice_id, {
      formalId: meta.formal_id,
      invoiceType: meta.invoice_type,
    })
    return pdf.pdfUrl
  } catch (err) {
    scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .warn(`[parasut-pdf] PDF alınamadı order=${orderId}: ${String(err)}`)
    throw new InvoicePdfUnavailableError("Fatura PDF'i şu an alınamıyor, biraz sonra tekrar deneyin.", 503)
  }
}

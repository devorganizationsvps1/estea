import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import {
  InvoicePdfUnavailableError,
  resolveInvoicePdfUrl,
  verifyInvoicePdfSignature,
} from "../../../lib/parasut-invoice-pdf"

const page = (message: string) =>
  `<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fatura</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222"><p>${message}</p></body></html>`

/**
 * GET /parasut/invoice-pdf?o=<order_id>&s=<imza>
 * Müşteri mailindeki fatura bağlantısı: imza doğrulanır, Paraşüt'ten taze (süreli) PDF
 * adresi alınıp oraya yönlendirilir. Oturum gerekmez; imza sipariş başına sabittir.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const orderId = String(req.query.o || "")
  const signature = String(req.query.s || "")
  res.setHeader("Cache-Control", "no-store")
  res.setHeader("Referrer-Policy", "no-referrer")
  if (!verifyInvoicePdfSignature(orderId, signature)) {
    res.status(404).type("html").send(page("Fatura bulunamadı."))
    return
  }
  try {
    const url = await resolveInvoicePdfUrl(req.scope, orderId)
    res.redirect(302, url)
  } catch (err) {
    const status = err instanceof InvoicePdfUnavailableError ? err.httpStatus : 503
    const message =
      err instanceof InvoicePdfUnavailableError ? err.message : "Fatura şu an açılamıyor."
    res.status(status).type("html").send(page(message))
  }
}

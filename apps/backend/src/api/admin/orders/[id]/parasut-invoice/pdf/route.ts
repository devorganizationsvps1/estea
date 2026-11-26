import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import {
  InvoicePdfUnavailableError,
  resolveInvoicePdfUrl,
} from "../../../../../../lib/parasut-invoice-pdf"

/**
 * Admin: GET /admin/orders/:id/parasut-invoice/pdf → Paraşüt'ün taze PDF adresine yönlendirir.
 * Paraşüt PDF adresleri süreli olduğu için metadata'da tutulmaz.
 */
export const GET = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  res.setHeader("Cache-Control", "no-store")
  try {
    res.redirect(302, await resolveInvoicePdfUrl(req.scope, req.params.id))
  } catch (err) {
    const status = err instanceof InvoicePdfUnavailableError ? err.httpStatus : 503
    res.status(status).json({ message: err instanceof Error ? err.message : String(err) })
  }
}

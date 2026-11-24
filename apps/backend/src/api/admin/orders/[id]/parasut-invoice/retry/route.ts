import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { issueSalesInvoiceForOrder } from "../../../../../../lib/parasut-invoice"

/**
 * Admin: POST /admin/orders/:id/parasut-invoice/retry
 * Faturayı yeniden kes (issued ise skip; satış faturası açıldıysa yalnız resmileştirir).
 * Belirsiz kayıt (pending/unknown) yalnız `confirm_not_in_parasut: true` ile gider:
 * admin Paraşüt'te kaydın olmadığını görmüştür.
 */
export const POST = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const orderId = req.params.id
  if (!orderId) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "Order id required")
  }
  const body = (req.body || {}) as { confirm_not_in_parasut?: unknown }

  try {
    const result = await issueSalesInvoiceForOrder(req.scope, orderId, {
      confirmedNotInParasut: body.confirm_not_in_parasut === true,
    })
    res.status(200).json({
      ok: result.ok,
      skipped: result.skipped || false,
      meta: result.meta,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, message)
  }
}

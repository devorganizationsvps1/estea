import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { loadRenewTarget, renewCarrierReturnCode, ReturnCodeRenewError } from "../../../../../../lib/return-code-renew"

/**
 * Admin: GET /admin/returns/:id/return-code/renew
 * Kargo firmasından kod alınabilir mi (firma kodlu iade sunuyor, iade bekliyor, siparişte
 * bu firmanın gönderisi var)? Panel düğmeyi yalnız `available` iken gösterir.
 */
export const GET = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  try {
    await loadRenewTarget(req.scope, req.params.id)
    res.json({ available: true, reason: null })
  } catch (error) {
    if (error instanceof ReturnCodeRenewError) {
      res.json({ available: false, reason: error.message })
      return
    }
    throw error
  }
}

/**
 * Admin: POST /admin/returns/:id/return-code/renew
 * Kargo firmasında iade kodunu yeniden açar (varsa eskisini iptal eder) ve müşteriye gönderir.
 */
export const POST = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  try {
    const result = await renewCarrierReturnCode(req.scope, {
      returnId: req.params.id,
      actorId: req.auth_context?.actor_id || null,
    })
    res.json({ ok: true, ...result })
  } catch (error) {
    if (error instanceof ReturnCodeRenewError) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, error.message)
    throw error
  }
}

import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"

import { PARASUT_MODULE } from "../../../../modules/parasut"
import type ParasutModuleService from "../../../../modules/parasut/service"

/**
 * POST /admin/parasut/connect → { url }
 * Admin bu adrese gider, Paraşüt entegrasyon kullanıcısıyla giriş yapıp onaylar;
 * Paraşüt /parasut/oauth/callback'e döner.
 */
export const POST = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const parasut = req.scope.resolve(PARASUT_MODULE) as ParasutModuleService
  try {
    const { url, expiresAt } = await parasut.startAuthorization(req.auth_context?.actor_id)
    res.json({ url, expires_at: expiresAt })
  } catch (err) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      err instanceof Error ? err.message : String(err)
    )
  }
}

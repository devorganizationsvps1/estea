import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { PARASUT_MODULE } from "../../../../modules/parasut"
import type ParasutModuleService from "../../../../modules/parasut/service"

/** GET /admin/parasut/connection — kimlik ayarları + bağlantı durumu (sır içermez). */
export const GET = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const parasut = req.scope.resolve(PARASUT_MODULE) as ParasutModuleService
  const config = parasut.getConnectionStatus()
  const authorization =
    config.mode === "live" ? await parasut.getAuthorizationStatus() : null
  res.json({
    config: { ...config, companyId: parasut.getOptions().companyId || null },
    authorization,
  })
}

/** DELETE /admin/parasut/connection — yerel bağlantıyı (refresh token) siler. */
export const DELETE = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const parasut = req.scope.resolve(PARASUT_MODULE) as ParasutModuleService
  await parasut.disconnect()
  res.json({ ok: true })
}

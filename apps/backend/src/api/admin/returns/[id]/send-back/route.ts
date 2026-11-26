import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"

import { getConfiguredCarrier } from "../../../../../modules/carrier/registry"
import {
  disposeSendBack,
  markSendBackReturned,
  SendBackError,
  shipSendBack,
} from "../../../../../lib/return-send-back"

type Body = {
  action?: unknown
  tracking_number?: unknown
  carrier_name?: unknown
  consent_note?: unknown
}

const text = (v: unknown) => (typeof v === "string" ? v : "")

/**
 * Admin: GET /admin/returns/:id/send-back
 * Panel "Müşteriye geri gönder" düğmesini buna göre kurar: kargo firması bağlıysa gönderi
 * kendiliğinden açılır, değilse takip numarası sorulur.
 */
export const GET = async (_req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const adapter = getConfiguredCarrier()
  res.json({ carrier: adapter ? { code: adapter.code, name: adapter.name } : null })
}

/**
 * Admin: POST /admin/returns/:id/send-back
 * Reddedilen (ya da kısmi kabulde kabul edilmeyen) ürün için:
 *   { action: "ship", tracking_number?, carrier_name? }  müşteriye geri gönder (kargo bizden)
 *   { action: "returned" }                                paket teslim alınmadı, bize döndü
 *   { action: "dispose", consent_note }                   müşteri onayıyla imha
 */
export const POST = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const body = (req.body || {}) as Body
  const returnId = req.params.id
  const actorId = req.auth_context?.actor_id || null
  try {
    if (body.action === "ship") {
      const tracking = text(body.tracking_number).trim()
      const sendBack = await shipSendBack(req.scope, {
        returnId,
        actorId,
        manual: tracking ? { trackingNumber: tracking, carrierName: text(body.carrier_name) } : null,
      })
      return res.json({ ok: true, send_back: sendBack })
    }
    if (body.action === "returned") {
      return res.json({ ok: true, send_back: await markSendBackReturned(req.scope, { returnId, actorId }) })
    }
    if (body.action === "dispose") {
      const sendBack = await disposeSendBack(req.scope, { returnId, consentNote: text(body.consent_note), actorId })
      return res.json({ ok: true, send_back: sendBack })
    }
  } catch (error) {
    if (error instanceof SendBackError) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, error.message)
    throw error
  }
  throw new MedusaError(MedusaError.Types.INVALID_DATA, "Geçersiz işlem.")
}

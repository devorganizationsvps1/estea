import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { rejectStoreReturn } from "../../../../../lib/return-rejection"

type RejectBody = {
  stage?: unknown
  reason_code?: unknown
  note?: unknown
  photos?: unknown
}

/**
 * Admin: POST /admin/returns/:id/reject
 * Body: { stage: "before_arrival" | "inspected", reason_code, note?, photos?: [{ url }] }
 *
 * Paket gelmeden ret → kargo iade kodu iptal, müşteriye "göndermeyin" maili.
 * İnceleme sonrası ret → sebep + fotoğraf zorunlu, ürün müşteriye geri gönderilmek üzere
 * kayda geçer. İkisinde de refund yok, stok yok; müşteriye escay.return_rejected maili.
 */
export const POST = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const returnId = req.params.id
  if (!returnId) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "Return id required")
  }

  const body = (req.validatedBody || req.body || {}) as RejectBody
  const result = await rejectStoreReturn(req.scope, {
    return_id: returnId,
    stage: body.stage,
    reason_code: body.reason_code,
    note: body.note,
    photos: body.photos,
    rejected_by: req.auth_context?.actor_id || null,
  })

  res.status(200).json({
    ok: true,
    ...result,
  })
}

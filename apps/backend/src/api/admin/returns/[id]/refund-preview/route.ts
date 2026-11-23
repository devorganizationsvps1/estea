import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { previewReturnRefund } from "../../../../../lib/return-refund-preview"

/**
 * POST /admin/returns/:id/refund-preview — teslim alma onayında gösterilen kesin iade tutarı.
 * Body: { items: [{ item_id, quantity }], refund_shipping? }  (quantity: sağlam + hasarlı)
 * Hiçbir şey yazmaz; hesap gerçek iadeyle aynıdır (lib/return-refund.ts).
 */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const body = (req.body || {}) as { items?: { item_id?: unknown; quantity?: unknown }[]; refund_shipping?: boolean }
  const items = (Array.isArray(body.items) ? body.items : [])
    .filter((i): i is { item_id: string; quantity: unknown } => typeof i?.item_id === "string")
    .map((i) => ({ item_id: i.item_id, quantity: Number(i.quantity) || 0 }))
  try {
    res.json(await previewReturnRefund(req.scope, { return_id: req.params.id, items, refund_shipping: body.refund_shipping === true }))
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : String(error) })
  }
}

import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { getSendBackLabel, SendBackError } from "../../../../../../lib/return-send-back"

/**
 * Admin: GET /admin/returns/:id/send-back/label
 * Geri gönderim kargo etiketi: DHL'de ZPL dosyası (yazıcıya doğrudan), diğerlerinde PDF.
 */
export const GET = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  try {
    const label = await getSendBackLabel(req.scope, req.params.id)
    res.setHeader("Cache-Control", "no-store")
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition")
    if (label.kind === "zpl") {
      res.setHeader("Content-Type", "application/octet-stream")
      res.setHeader("Content-Disposition", `attachment; filename="${label.fileName}"`)
      return res.send(Buffer.from(label.body, "utf8"))
    }
    res.setHeader("Content-Type", "application/pdf")
    res.setHeader("Content-Disposition", `inline; filename="geri-gonderim-etiket.pdf"`)
    return res.send(label.body)
  } catch (error) {
    if (error instanceof SendBackError) return res.status(400).json({ message: error.message })
    throw error
  }
}

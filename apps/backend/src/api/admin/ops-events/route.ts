import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { OPS_EVENT_MODULE } from "../../../modules/ops-event"
import { opsKindFilter } from "../../../lib/ops-events"
import type OpsEventModuleService from "../../../modules/ops-event/service"

/**
 * Admin: GET /admin/ops-events?level=(info|warning|error|important)&kind=&order_id=&limit=&offset=
 * Olay kaydı (en yeni önce). kind öneki desteklenir: kind=payment → payment.*
 * Teknik olaylar (lib/ops-events.ts SYSTEM_EVENT_KINDS) yalnız kind=system ile gelir.
 */
export const GET = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const q = req.query as Record<string, string | undefined>
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 50))
  const offset = Math.max(0, Number(q.offset) || 0)
  const filters: Record<string, unknown> = {}
  if (q.level && ["info", "warning", "error"].includes(q.level)) filters.level = q.level
  // "important": bakılması gerekenler (hata + uyarı), bilgi satırları hariç
  if (q.level === "important") filters.level = ["warning", "error"]
  if (q.order_id) filters.order_id = q.order_id
  filters.kind = opsKindFilter(q.kind)

  const service = req.scope.resolve<OpsEventModuleService>(OPS_EVENT_MODULE)
  const [events, count] = await service.listAndCountOpsEvents(filters, {
    order: { created_at: "DESC" },
    take: limit,
    skip: offset,
  })
  res.json({ events, count, limit, offset })
}

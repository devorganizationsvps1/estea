import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Badge, Button, Container, Heading, Text } from "@medusajs/ui"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { useParams } from "react-router-dom"
import { fetchOpsEvents, formatEventDate, OPS_KIND_ACTION, OPS_KIND_LABEL, OPS_LEVEL_BADGE, tidyEventText } from "../lib/ops-events"

/**
 * Sipariş detayı — bu siparişin olayları (sağ sütun). Medusa'nın Aktivite kartının
 * yerini tutar (setup-admin-layouts.ts onu gizler). Kargo düğmeleri: order-status-widget.
 * Teknik (sistem) olaylar burada görünmez: Olay kaydı → Sistem filtresi.
 */
const OrderOpsWidget = () => {
  const { id: orderId } = useParams()
  const [all, setAll] = useState(false)

  const events = useQuery({
    queryKey: ["order-ops-events", orderId],
    enabled: Boolean(orderId),
    queryFn: () => fetchOpsEvents({ order_id: orderId, limit: 20 }),
  })

  const list = events.data?.events || []
  if (!orderId || list.length === 0) return null
  // Son 5 olay; ayrıntı metni yalnız uyarı/hata olaylarında görünür.
  const shown = all ? list : list.slice(0, 5)

  return (
    <Container className="flex flex-col gap-2 px-6 py-4">
      <Heading level="h2">Olaylar</Heading>
      {shown.map((e) => {
        const badge = OPS_LEVEL_BADGE[e.level] || OPS_LEVEL_BADGE.info
        return (
          <div key={e.id} className="flex flex-col gap-0.5 border-b border-ui-border-base pb-2 last:border-b-0">
            <div className="flex items-center gap-2">
              <Badge size="2xsmall" color={badge.color}>{OPS_KIND_LABEL[e.kind] || e.kind}</Badge>
              <Text size="xsmall" className="text-ui-fg-subtle">{formatEventDate(e.created_at)}</Text>
            </div>
            <Text size="small">{tidyEventText(e.title)}</Text>
            {e.level !== "info" && OPS_KIND_ACTION[e.kind] ? (
              <Text size="small" className="text-ui-fg-subtle">{OPS_KIND_ACTION[e.kind]}</Text>
            ) : null}
            {e.detail && (all || (e.level !== "info" && !OPS_KIND_ACTION[e.kind])) ? (
              <Text size="xsmall" className="text-ui-fg-subtle whitespace-pre-wrap break-words">{tidyEventText(e.detail)}</Text>
            ) : null}
          </div>
        )
      })}
      {list.length > 5 || list.some((e) => e.detail && (e.level === "info" || OPS_KIND_ACTION[e.kind])) ? (
        <div>
          <Button size="small" variant="transparent" onClick={() => setAll((v) => !v)}>
            {all ? "Daha az göster" : list.length > 5 ? `Önceki ${list.length - 5} olayı da göster` : "Ayrıntıları göster"}
          </Button>
        </div>
      ) : null}
    </Container>
  )
}

export const config = defineWidgetConfig({
  // Düzen kimliği: scripts/setup-admin-layouts.ts sıralamayı bununla yapar.
  id: "escay-order-events",
  zone: "order.details.side.after",
})

export default OrderOpsWidget

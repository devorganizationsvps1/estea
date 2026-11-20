import type { MedusaContainer } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  NotificationStatus,
} from "@medusajs/framework/utils"
import { sendOrderConfirmationEmail } from "./order-confirmation-email"
import { sendShippingStatusEmail } from "./shipping-status-email"
import { sendReturnCodeToCustomer } from "./return-code"
import { dailyTitle, errorText, recordOpsEvent } from "./ops-events"

const LOOKBACK_MS = 24 * 60 * 60 * 1000
const MAX_ROWS = 1000
/** İş 15 dakikada bir çalışır: yaklaşık 2 saatlik kesintiyi karşılar. */
const MAX_ORDER_CONFIRMATION_ATTEMPTS = 8
const ORDER_CONFIRMATION_TEMPLATE = "order-confirmation"

export type NotificationRow = {
  id: string
  idempotency_key?: string | null
  status?: string | null
  template?: string | null
  resource_id?: string | null
}

export type FailedEmail = {
  template: string
  resourceId: string | null
  attempts: number
}

/** Aynı mailin denemeleri `#r<n>` ekiyle ayrılır; biri başarılıysa mail gitmiştir. */
export function findUnresolvedEmails(rows: NotificationRow[]): FailedEmail[] {
  const groups = new Map<string, NotificationRow[]>()
  for (const row of rows) {
    const key = row.idempotency_key?.replace(/#r\d+$/, "") || row.id
    groups.set(key, [...(groups.get(key) ?? []), row])
  }

  const unresolved: FailedEmail[] = []
  for (const group of groups.values()) {
    const statuses = group.map((r) => r.status)
    if (statuses.includes(NotificationStatus.SUCCESS)) continue
    if (!statuses.includes(NotificationStatus.FAILURE)) continue
    unresolved.push({
      template: group[0].template || "bilinmiyor",
      resourceId: group[0].resource_id || null,
      attempts: group.length,
    })
  }
  return unresolved
}

/**
 * Kayıtlı veriden yeniden üretilebilen mailler: sipariş onayı (sipariş), kargoya verildi /
 * teslim edildi (gönderi), iade kodu (iade metadata'sındaki kod). Mareen'de giden maillerin
 * çoğu kargo mailleriydi; limit dolduğunda kaybolmasınlar.
 */
const RETRYABLE_TEMPLATES = new Set([
  ORDER_CONFIRMATION_TEMPLATE,
  "order-shipped",
  "order-delivered",
  "return-code-customer",
])

function shouldRetry(email: FailedEmail): email is FailedEmail & { resourceId: string } {
  return (
    RETRYABLE_TEMPLATES.has(email.template) &&
    Boolean(email.resourceId) &&
    email.attempts < MAX_ORDER_CONFIRMATION_ATTEMPTS
  )
}

/** Tekrar gönderir; mail gitti mi döner. null: kayıt artık yok / gönderilmemeli. */
async function resend(
  container: MedusaContainer,
  email: FailedEmail & { resourceId: string }
): Promise<boolean | null> {
  if (email.template === ORDER_CONFIRMATION_TEMPLATE) {
    const result = await sendOrderConfirmationEmail(container, email.resourceId)
    if (result.skipped === "canceled") return null
    return result.sent
  }
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  if (email.template === "order-shipped" || email.template === "order-delivered") {
    const { data } = await query.graph({
      entity: "fulfillment",
      fields: ["id", "canceled_at", "order.id"],
      filters: { id: email.resourceId },
    })
    const row = data?.[0] as { canceled_at?: unknown; order?: { id?: string } | null } | undefined
    if (!row?.order?.id || row.canceled_at) return null
    await sendShippingStatusEmail(container, {
      orderId: row.order.id,
      fulfillmentId: email.resourceId,
      kind: email.template === "order-shipped" ? "shipped" : "delivered",
    })
    return true
  }
  if (email.template === "return-code-customer") {
    const { data } = await query.graph({
      entity: "return",
      fields: ["id", "order_id", "status", "metadata"],
      filters: { id: email.resourceId },
    })
    const ret = data?.[0] as { order_id?: string; status?: string; metadata?: Record<string, unknown> | null } | undefined
    const code = typeof ret?.metadata?.return_code === "string" ? ret.metadata.return_code : ""
    if (!ret || !code || ret.status === "canceled" || ret.status === "received") return null
    await sendReturnCodeToCustomer(container, {
      returnId: email.resourceId,
      orderId: ret.order_id,
      code,
      source: (ret.metadata?.return_code_source as never) || "carrier",
    })
    return true
  }
  return null
}

/**
 * Gönderilemeyen mailleri ele alır. Medusa mail içeriğini saklamadığından yalnız kayıttan
 * yeniden üretilebilenler (RETRYABLE_TEMPLATES) tekrar denenir; diğerleri için günde bir
 * uyarı düşer. Şifre sıfırlama gibi süreli linkler zaten tekrar gönderilmemeli.
 */
export async function processFailedEmails(
  container: MedusaContainer
): Promise<{ retried: number; recovered: number; unresolved: number }> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const notification = container.resolve(Modules.NOTIFICATION)

  const rows = (await notification.listNotifications(
    {
      channel: "email",
      created_at: { $gte: new Date(Date.now() - LOOKBACK_MS) },
    } as never,
    {
      select: ["id", "idempotency_key", "status", "template", "resource_id"],
      take: MAX_ROWS,
      order: { created_at: "DESC" },
    }
  )) as NotificationRow[]

  const remaining: FailedEmail[] = []
  let retried = 0
  let recovered = 0

  for (const email of findUnresolvedEmails(rows)) {
    if (!shouldRetry(email)) {
      remaining.push(email)
      continue
    }
    try {
      const sent = await resend(container, email)
      if (sent === null) continue
      retried++
      if (sent) recovered++
      else remaining.push(email)
    } catch (err) {
      retried++
      logger.error(`[failed-emails] ${email.template} ${email.resourceId}: ${errorText(err)}`)
      remaining.push(email)
    }
  }

  const byTemplate = new Map<string, FailedEmail[]>()
  for (const email of remaining) {
    byTemplate.set(email.template, [...(byTemplate.get(email.template) ?? []), email])
  }

  for (const [template, emails] of byTemplate) {
    const orders = emails.flatMap((e) => (e.resourceId ? [e.resourceId] : []))
    await recordOpsEvent(container, {
      kind: "mail.failed",
      level: "error",
      // Kaydı olmayan mailler (şifre sıfırlama) yalnız adetle ayrışır.
      title: dailyTitle(`${template} maili gönderilemedi`, [...orders, String(emails.length)]),
      detail: `${emails.length} mail.${orders.length ? ` Kayıtlar: ${orders.join(", ")}` : ""}`,
      oncePerTitle: true,
    })
  }

  return { retried, recovered, unresolved: remaining.length }
}

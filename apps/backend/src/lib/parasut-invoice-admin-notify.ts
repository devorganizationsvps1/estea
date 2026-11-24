/**
 * Fatura sorunu / kesilemeyen iade faturası için admin (CONTACT_INBOX) uyarısı.
 * Satış faturası idempotent: metadata.admin_notified_at varsa tekrar gönderilmez.
 */

import type { MedusaContainer } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils"
import { formatOrderNumber } from "@escay/shared/order-number"
import type { ParasutOrderInvoiceMeta } from "../modules/parasut"
import { COMPANY } from "../emails/company"
import { emailLayout, escapeHtml, EMAIL_STYLES } from "../emails/format"
import { createNotificationIdempotent } from "./notify"

function alertInbox(): string {
  return (
    process.env.PARASUT_ADMIN_ALERT_EMAIL?.trim() ||
    process.env.CONTACT_INBOX?.trim() ||
    COMPANY.emailOps
  )
}

async function readOrder(scope: MedusaContainer, orderId: string) {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["id", "email", "display_id", "metadata"],
    filters: { id: orderId },
  })
  const order = orders?.[0] as
    | {
        id: string
        email?: string | null
        display_id?: number | string | null
        metadata?: Record<string, unknown> | null
      }
    | undefined
  const displayId =
    formatOrderNumber(order?.display_id) || String(order?.display_id ?? orderId)
  return { order, displayId }
}

/** İade kabulünde hasarlı ayrılan kalemler (return-acceptance → metadata.escay_acceptance). */
async function readDamagedLines(
  scope: MedusaContainer,
  orderId: string,
  returnId: string
): Promise<{ title: string; quantity: number }[]> {
  try {
    const query = scope.resolve(ContainerRegistrationKeys.QUERY)
    const { data: returns } = await query.graph({
      entity: "return",
      fields: ["id", "metadata"],
      filters: { id: returnId },
    })
    const items = ((returns?.[0] as { metadata?: Record<string, unknown> | null } | undefined)?.metadata
      ?.escay_acceptance as { items?: { item_id: string; damaged?: number }[] } | undefined)?.items
    const damaged = (items || []).filter((i) => Number(i.damaged) > 0)
    if (!damaged.length) return []
    const { data: orders } = await query.graph({
      entity: "order",
      fields: ["id", "items.id", "items.title", "items.variant_title"],
      filters: { id: orderId },
    })
    const lines = ((orders?.[0] as { items?: { id: string; title?: string; variant_title?: string | null }[] } | undefined)?.items) || []
    return damaged.map((d) => {
      const line = lines.find((l) => l.id === d.item_id)
      const title = [line?.title, line?.variant_title].filter(Boolean).join(" ") || d.item_id
      return { title, quantity: Number(d.damaged) }
    })
  } catch {
    return []
  }
}

export async function notifyParasutInvoiceProblem(
  scope: MedusaContainer,
  orderId: string,
  invoiceMeta: ParasutOrderInvoiceMeta
): Promise<{ sent: boolean; skipped?: string }> {
  const logger = scope.resolve(ContainerRegistrationKeys.LOGGER)

  if (invoiceMeta.status !== "error" && invoiceMeta.status !== "unknown") {
    return { sent: false, skipped: "not_a_problem" }
  }
  if (invoiceMeta.admin_notified_at) {
    return { sent: false, skipped: "already_notified" }
  }

  const to = alertInbox()
  const { order, displayId } = await readOrder(scope, orderId)
  const uncertain = invoiceMeta.status === "unknown"
  const heading = uncertain ? "Fatura durumu belirsiz" : "Fatura kesilemedi"
  const instruction = uncertain
    ? "Paraşüt yanıtı alınamadı; satış faturası açılmış olabilir, otomatik tekrar denenmez. Paraşüt'te sipariş numarasını arayın. Kayıt yoksa: Admin → Sipariş → Fatura kutusu → Yeniden kes."
    : invoiceMeta.invoice_id
      ? "Satış faturası Paraşüt'te açıldı ama e-belge olarak resmileşmedi. Otomatik tekrar denenecek (yeni fatura açılmaz); sonuç değişmezse Admin → Sipariş → Fatura kutusundan yeniden deneyin."
      : "Paraşüt isteği reddetti, fatura açılmadı. Otomatik tekrar denenecek; sonuç değişmezse hatayı giderip Admin → Sipariş → Fatura kutusundan yeniden kesin."
  const errText = invoiceMeta.error || "bilinmeyen hata"
  const subject = `[Es Çay] ${heading} — #${displayId}`
  const html = emailLayout(`
    <h1 style="margin:0 0 12px;font-size:20px;color:${EMAIL_STYLES.brandColor};">${heading}</h1>
    <p style="margin:0 0 16px;color:${EMAIL_STYLES.mutedColor};">
      Sipariş <strong>#${escapeHtml(displayId)}</strong>: ${escapeHtml(instruction)}
    </p>
    <p style="margin:0 0 8px;"><strong>Order ID:</strong> ${escapeHtml(orderId)}</p>
    <p style="margin:0 0 8px;"><strong>Müşteri:</strong> ${escapeHtml(order?.email || "—")}</p>
    <p style="margin:0;"><strong>Hata:</strong> ${escapeHtml(errText)}</p>
  `)
  const text = `${heading} — #${displayId}
${instruction}
Order: ${orderId}
Müşteri: ${order?.email || "—"}
Hata: ${errText}
`

  const notificationService = scope.resolve(Modules.NOTIFICATION)
  try {
    await createNotificationIdempotent(notificationService, {
      to,
      channel: "email",
      template: "parasut-invoice-problem-admin",
      content: { subject, html, text },
      resource_id: orderId,
      resource_type: "order",
      idempotency_key: `parasut-invoice-admin:${orderId}:${invoiceMeta.at || "x"}`,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/idempotenc|duplicate|unique/i.test(message)) {
      return { sent: false, skipped: "idempotent" }
    }
    throw err
  }

  try {
    const existing = (order?.metadata?.parasut_invoice ||
      invoiceMeta) as ParasutOrderInvoiceMeta
    await scope.resolve(Modules.ORDER).updateOrders([
      {
        id: orderId,
        metadata: {
          ...(order?.metadata || {}),
          parasut_invoice: {
            ...existing,
            admin_notified_at: new Date().toISOString(),
          },
        },
      },
    ])
  } catch (markErr) {
    logger.warn(
      `[parasut-invoice-admin] Mark notified failed order=${orderId}: ${String(markErr)}`
    )
  }

  logger.info(`[parasut-invoice-admin] Alert sent to ${to} order=${orderId}`)
  return { sent: true }
}

/**
 * İade faturası elle kesilecek (error yok) ya da API'den kesilemedi (error var).
 * Para iadesi yapıldı, belge eksik. İade başına bir kez.
 */
export async function notifyRefundInvoiceProblem(
  scope: MedusaContainer,
  input: { order_id: string; return_id: string; amount: number; error?: string }
): Promise<void> {
  const { order, displayId } = await readOrder(scope, input.order_id)
  const damaged = await readDamagedLines(scope, input.order_id, input.return_id)
  const amount = input.amount.toFixed(2)
  const heading = input.error ? "İade faturası kesilemedi" : "İade faturası elle kesilecek"
  const subject = `[Es Çay] ${heading} — #${displayId}`
  const instruction = input.error
    ? "Para iadesi yapıldı ama Paraşüt iade faturası kesilemedi. İade faturasını Paraşüt'ten elle kesin."
    : "Para iadesi PayTR'ye iletildi. İade faturasını Paraşüt'ten, satış faturasına bağlı olarak kesin."
  // Paraşüt stok sahibi (K15): iade faturasıyla stoğa giren adet bir sonraki eşitlemede
  // satışa açılır. Hasarlı adetler stoğa girmemeli.
  const damagedText = damaged.length
    ? `Hasarlı kabul edilen ürünler (Paraşüt'te stoğa SOKMAYIN, fire/hasar olarak işleyin): ${damaged
        .map((d) => `${d.title} × ${d.quantity}`)
        .join(", ")}`
    : ""
  const html = emailLayout(`
    <h1 style="margin:0 0 12px;font-size:20px;color:${EMAIL_STYLES.brandColor};">${heading}</h1>
    <p style="margin:0 0 16px;color:${EMAIL_STYLES.mutedColor};">
      Sipariş <strong>#${escapeHtml(displayId)}</strong>: ${escapeHtml(instruction)}
    </p>
    <p style="margin:0 0 8px;"><strong>Tutar:</strong> ${escapeHtml(amount)} TL</p>
    <p style="margin:0 0 8px;"><strong>Return ID:</strong> ${escapeHtml(input.return_id)}</p>
    <p style="margin:0 0 8px;"><strong>Müşteri:</strong> ${escapeHtml(order?.email || "—")}</p>
    ${input.error ? `<p style="margin:0;"><strong>Hata:</strong> ${escapeHtml(input.error)}</p>` : ""}
    ${damagedText ? `<p style="margin:16px 0 0;color:${EMAIL_STYLES.brandColor};"><strong>${escapeHtml(damagedText)}</strong></p>` : ""}
  `)
  const text = `${heading} — #${displayId}
${instruction}
Tutar: ${amount} TL
Return: ${input.return_id}
Müşteri: ${order?.email || "—"}
${input.error ? `Hata: ${input.error}\n` : ""}${damagedText ? `\n${damagedText}\n` : ""}`

  await createNotificationIdempotent(scope.resolve(Modules.NOTIFICATION), {
    to: alertInbox(),
    channel: "email",
    template: "parasut-refund-invoice-admin",
    content: { subject, html, text },
    resource_id: input.order_id,
    resource_type: "order",
    idempotency_key: `parasut-refund-invoice:${input.return_id}:${input.error ? "error" : "manual"}`,
  })
}

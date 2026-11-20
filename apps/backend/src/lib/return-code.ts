import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { buildReturnCodeCustomerEmail } from "../emails/return-notifications"
import { recordOpsEvent } from "./ops-events"
import { loadReturnEmailContext } from "./return-email-context"
import { createNotificationIdempotent } from "./notify"

export type ReturnCodeSource = "manual" | "carrier"

/**
 * Kargo firmasının ürettiği iade kodunu, mail gitmeden ÖNCE iadeye yazar (gönderildi işareti yok).
 * Mail düşerse (SMTP kapalı) kod kaybolmaz: panel kodu "müşteriye gönderilmedi" diye gösterir,
 * admin aynı kodu tek tıkla yeniden gönderir; firmada ikinci iade kaydı açılmaz.
 *
 * Yeni kod henüz gönderilmedi: eski `return_code_sent_at` silinir. Etiket linki her zaman
 * yazılır; firma link vermezse (ör. DHL "zaten var") eski, iptal edilmiş etiket kalmasın diye
 * alan temizlenir. `meta`: aynı yazımda eklenecek alanlar (yenileme sayacı).
 */
export async function recordCarrierReturnCode(
  container: MedusaContainer,
  returnId: string,
  code: string,
  extra: { labelUrl?: string | null; meta?: Record<string, unknown> } = {}
): Promise<void> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: "return", fields: ["id", "metadata"], filters: { id: returnId } })
  const meta = ((data?.[0] as { metadata?: Record<string, unknown> | null } | undefined)?.metadata || {}) as Record<string, unknown>
  await container.resolve(Modules.ORDER).updateReturns([
    {
      selector: { id: returnId },
      data: {
        metadata: {
          ...meta,
          ...(extra.meta || {}),
          return_code: code,
          return_code_source: "carrier",
          return_code_created_at: new Date().toISOString(),
          return_code_sent_at: null,
          return_label_url: extra.labelUrl || null,
        },
      },
    },
  ])
}

/**
 * Firmada iptal edilen iade kodunu iadeden düşürür: panel artık "gönderildi" demez, elle kod
 * kutusu ve "Kargo firmasından kod al" düğmesi açılır. İptal edilen kod iz için saklanır.
 */
export async function clearCanceledReturnCode(container: MedusaContainer, returnId: string, canceledCode: string): Promise<void> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: "return", fields: ["id", "metadata"], filters: { id: returnId } })
  const meta = ((data?.[0] as { metadata?: Record<string, unknown> | null } | undefined)?.metadata || {}) as Record<string, unknown>
  await container.resolve(Modules.ORDER).updateReturns([
    {
      selector: { id: returnId },
      data: {
        metadata: {
          ...meta,
          return_code: null,
          return_code_sent_at: null,
          return_label_url: null,
          return_code_canceled: canceledCode,
          return_code_canceled_at: new Date().toISOString(),
        },
      },
    },
  ])
}

/** İadeye "müşteriye giden iade kodu" yazar (panel: "İade kodu gönderilmedi" kalkar). */
export async function markReturnCodeSent(
  container: MedusaContainer,
  returnId: string,
  code: string,
  source: ReturnCodeSource
): Promise<void> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: "return", fields: ["id", "metadata"], filters: { id: returnId } })
  const meta = ((data?.[0] as { metadata?: Record<string, unknown> | null } | undefined)?.metadata || {}) as Record<string, unknown>
  await container.resolve(Modules.ORDER).updateReturns([
    {
      selector: { id: returnId },
      data: {
        metadata: {
          ...meta,
          return_code: code,
          return_code_sent_at: new Date().toISOString(),
          return_code_source: source,
        },
      },
    },
  ])
}

/**
 * Müşteriye "iade kodu ile kargo şubesine verin" maili → kodu iadeye yazar → olay.
 * Aynı kod ikinci kez mail atmaz (idempotency_key).
 */
export async function sendReturnCodeToCustomer(
  container: MedusaContainer,
  input: {
    returnId: string
    orderId?: string | null
    code: string
    source: ReturnCodeSource
    actorId?: string | null
    /** Yenilemede kod aynı kalabilir; her yenileme ayrı mail olsun diye anahtara eklenir. */
    renewal?: number
    /** Kargo firmasının iade etiketi linki (yenilemede yeni link; eski etiket geçersiz). */
    labelUrl?: string | null
  }
): Promise<{ email: string }> {
  const ctx = await loadReturnEmailContext(container, input.returnId)
  if (!ctx?.email) throw new Error("Siparişte müşteri e-postası yok.")

  const mail = buildReturnCodeCustomerEmail({
    orderDisplayId: ctx.orderDisplayId,
    code: input.code,
    items: ctx.items,
    labelUrl: input.labelUrl ?? null,
  })
  await createNotificationIdempotent(container.resolve(Modules.NOTIFICATION), {
    to: ctx.email,
    channel: "email",
    template: "return-code-customer",
    content: { subject: mail.subject, html: mail.html, text: mail.text },
    resource_id: input.returnId,
    resource_type: "return",
    idempotency_key: `return-code:${input.returnId}:${input.code}${input.renewal ? `:renew${input.renewal}` : ""}`,
  })

  // Mail gittikten SONRA işaretle: SMTP hatasında panel "gönderildi" göstermesin.
  await markReturnCodeSent(container, input.returnId, input.code, input.source)

  await recordOpsEvent(container, {
    kind: "return.code_sent",
    level: "info",
    title: `İade kodu müşteriye gönderildi: ${input.code}`,
    orderId: input.orderId || ctx.orderId || null,
    data: { return_id: input.returnId, code: input.code, source: input.source, by: input.actorId || null },
  })
  return { email: ctx.email }
}

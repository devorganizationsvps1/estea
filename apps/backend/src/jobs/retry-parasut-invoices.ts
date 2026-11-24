import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  issueSalesInvoiceForOrder,
  markStalePendingInvoiceUnknown,
} from "../lib/parasut-invoice"
import type { ParasutOrderInvoiceMeta } from "../modules/parasut"
import { shouldRetryParasutInvoice } from "../modules/parasut/options"

/** Gönderim süresini (istek zaman aşımları + kilit) rahat aşan eşik. */
const STALE_PENDING_MS = 10 * 60 * 1000

/**
 * `error` faturaları ve resmileşmesi yarım kalanları (satış faturası açılmış `pending`)
 * yeniden dene. Satış faturası açılmadan takılan `pending` → `unknown`a çevrilip uyarılır;
 * belirsiz kayıt tekrar GÖNDERİLMEZ.
 *
 * Env:
 *   PARASUT_RETRY_MAX_ATTEMPTS (default 8)
 *   PARASUT_RETRY_LOOKBACK_HOURS (default 72)
 */
export default async function retryParasutInvoicesJob(
  container: MedusaContainer
) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const maxAttempts = Math.max(
    1,
    Number(process.env.PARASUT_RETRY_MAX_ATTEMPTS || 8) || 8
  )
  const lookbackHours = Math.max(
    1,
    Number(process.env.PARASUT_RETRY_LOOKBACK_HOURS || 72) || 72
  )
  const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000)

  logger.info(
    `[parasut-retry] start — maxAttempts=${maxAttempts} lookback=${lookbackHours}h`
  )

  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["id", "status", "updated_at", "metadata"],
    // Fatura teslimde kesilir; sipariş tarihi günler önce olabilir. Fatura her
    // denemede metadata'ya yazıldığı için pencere son güncellemeden sayılır.
    filters: {
      updated_at: { $gte: cutoff },
      status: { $nin: ["canceled"] },
    },
  })

  const candidates = (orders || []) as {
    id: string
    metadata?: Record<string, unknown> | null
  }[]

  let attempted = 0
  let created = 0
  let skipped = 0
  let failed = 0

  for (const order of candidates) {
    const inv = (order.metadata?.parasut_invoice ||
      null) as ParasutOrderInvoiceMeta | null
    if (!inv) {
      skipped++
      continue
    }

    if (inv.status === "pending" && !inv.invoice_id) {
      const age = Date.now() - new Date(inv.at || 0).getTime()
      if (age > STALE_PENDING_MS) {
        try {
          await markStalePendingInvoiceUnknown(container, order.id, inv)
          logger.error(
            `[parasut-retry] Takılı pending → unknown order=${order.id} (Paraşüt'ten kontrol)`
          )
        } catch (err) {
          logger.error(`[parasut-retry] order=${order.id} error: ${String(err)}`)
        }
      }
      skipped++
      continue
    }

    // Kilit altında süren gönderim: resmileştirme bitmeden araya girme.
    if (inv.status === "pending" && Date.now() - new Date(inv.at || 0).getTime() < STALE_PENDING_MS) {
      skipped++
      continue
    }

    if (!shouldRetryParasutInvoice(inv.status, inv.invoice_id)) {
      skipped++
      continue
    }

    const retries = Number(inv.retry_count || 0)
    if (retries >= maxAttempts) {
      logger.warn(
        `[parasut-retry] max attempts reached order=${order.id} retries=${retries}`
      )
      skipped++
      continue
    }

    attempted++
    try {
      // retry_count artır (issue öncesi) — başarısızda da sayılır
      await container.resolve(Modules.ORDER).updateOrders([
        {
          id: order.id,
          metadata: {
            ...(order.metadata || {}),
            parasut_invoice: {
              ...inv,
              retry_count: retries + 1,
            },
          },
        },
      ])

      const result = await issueSalesInvoiceForOrder(container, order.id)
      if (result.ok && result.meta.status === "issued") {
        created++
        logger.info(
          `[parasut-retry] Issued order=${order.id} no=${result.meta.invoice_number}`
        )
      } else if (result.skipped) {
        skipped++
      } else {
        failed++
        logger.error(
          `[parasut-retry] Still failing order=${order.id}: ${result.meta.error || result.meta.status}`
        )
      }
    } catch (err) {
      failed++
      logger.error(`[parasut-retry] order=${order.id} error: ${String(err)}`)
    }
  }

  logger.info(
    `[parasut-retry] done — candidates=${candidates.length} attempted=${attempted} created=${created} failed=${failed} skipped=${skipped}`
  )
}

export const config = {
  name: "retry-parasut-invoices",
  // Her 15 dakikada
  schedule: "*/15 * * * *",
}

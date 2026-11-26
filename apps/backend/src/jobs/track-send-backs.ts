import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { closeExpiredSendBacks, trackSendBacks } from "../lib/return-send-back"

/**
 * Reddedilen ürünlerin geri gönderimi (30 dk):
 *  - yoldaki paketlerin durumu kargo firmasından sorulur (teslim / teslim alınmadı, bize döndü),
 *  - bize dönen paketin 14 günlük bekleme süresi dolduysa kayıt kapanır, müşteriye bildirilir.
 * Süre kontrolü kargo firması bağlı olmasa da çalışır (elle "bize döndü" işaretlenen paketler).
 */
export default async function trackSendBacksJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const { checked, changed } = await trackSendBacks(container)
  const closed = await closeExpiredSendBacks(container)
  if (checked || closed) logger.info(`[send-back] checked=${checked} changed=${changed} closed=${closed}`)
}

export const config = {
  name: "track-send-backs",
  schedule: "10,40 * * * *",
}

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { revertOrderPromotionUsage } from "../lib/promotion-usage"

/**
 * order.canceled → kupon / kampanya kullanımını geri ver.
 * Panelden iptal, ödenmemiş PayTR siparişi temizliği ve callback iptali hepsi
 * cancelOrderWorkflow'dan geçer, bu olayı yayar.
 */
export default async function orderCanceledPromotionUsageHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  if (!data?.id) return
  try {
    const result = await revertOrderPromotionUsage(container, data.id)
    if (result.reverted) {
      logger.info(`[promotion-usage] order=${data.id} ${result.reverted} kullanım geri alındı`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`[promotion-usage] order=${data.id} kullanım geri alınamadı: ${message}`)
  }
}

export const config: SubscriberConfig = {
  event: "order.canceled",
}

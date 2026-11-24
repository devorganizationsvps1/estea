import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { issueRefundInvoiceForReturn } from "../lib/parasut-refund-invoice"
import type { ReturnRefundedEvent } from "./return-refunded-email"

/**
 * escay.return_refunded → Paraşüt iade faturası (varsayılan: elle kesilecek işareti + admin uyarısı;
 * PARASUT_REFUND_INVOICE_AUTO=true ise API ile kesilir).
 * Reddedilen iadede bu event emit edilmez; yine de lib rejected guard içerir.
 */
export default async function returnRefundedParasutHandler({
  event: { data },
  container,
}: SubscriberArgs<ReturnRefundedEvent>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  if (!data?.return_id || !data?.order_id) {
    logger.warn("[return-refunded-parasut] Missing return_id/order_id — skip")
    return
  }

  try {
    const result = await issueRefundInvoiceForReturn(container, {
      return_id: data.return_id,
      order_id: data.order_id,
      amount: data.amount,
    })
    logger.info(
      `[return-refunded-parasut] return=${data.return_id} status=${result.meta.status} skipped=${Boolean(result.skipped)}`
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(
      `[return-refunded-parasut] Error return=${data.return_id}: ${message}`
    )
  }
}

export const config: SubscriberConfig = {
  event: "escay.return_refunded",
}

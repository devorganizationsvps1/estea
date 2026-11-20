import type { MedusaContainer } from "@medusajs/framework/types"
import { trackPaytrRefunds } from "../lib/paytr-refund-tracking"

/** PayTR'ye iletilen iadelerin gerçekten tamamlandığını izler (lib/paytr-refund-tracking.ts). */
export default async function trackPaytrRefundsJob(container: MedusaContainer) {
  const logger = container.resolve("logger") as { info: (m: string) => void }
  const summary = await trackPaytrRefunds(container)
  if (summary.completed || summary.alerted) {
    logger.info(`[paytr-refund-tracking] ${JSON.stringify(summary)}`)
  }
}

export const config = {
  name: "track-paytr-refunds",
  schedule: "17 */3 * * *",
}

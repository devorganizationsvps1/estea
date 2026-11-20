import type { MedusaContainer } from "@medusajs/framework/types"
import { resolveLocking } from "../modules/paytr/order-guards"

/**
 * Siparişin parasına dokunan işler (iade, iptal iadesi) aynı sipariş için süreçler
 * arası sıralanır (Redis kilidi). İki sekmeden aynı anda "İade et" / "Tekrar dene"
 * ya da aynı siparişin iki iadesi eşzamanlı çalışırsa ikincisi birincinin yazdığı
 * kaydı görür: para ve kargo bir kez iade edilir. İç içe çağrılmamalı (kilit tekrar
 * girişli değil).
 */
export function orderMoneyLockKey(orderId: string): string {
  return `escay:order-money:${orderId}`
}

export async function withOrderMoneyLock<T>(
  container: MedusaContainer,
  orderId: string,
  job: () => Promise<T>
): Promise<T> {
  return resolveLocking(container).execute(orderMoneyLockKey(orderId), job, {
    timeout: 60,
    ttl: 180,
  })
}

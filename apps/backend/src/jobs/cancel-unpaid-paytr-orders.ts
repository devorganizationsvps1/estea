import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  PAYTR_PROVIDER_ID,
  cancelUnpaidOrderIfSafe,
  describeError,
  isOrderUnpaidSafeToCancel,
  paytrCallbackLockKey,
  resolveLocking,
} from "../modules/paytr/order-guards"
import { isCallbackSettled, isRetryingSince } from "../modules/paytr/callback-state"
import { recordOpsEvent } from "../lib/ops-events"

/**
 * PayTR iframe vazgeçme / timeout: callback gelmeyen unpaid siparişleri iptal et.
 * Stok, cancelOrderWorkflow → Medusa reservation release ile serbest kalır.
 *
 * Kart ödemesinde sipariş artık ödeme başarılı olunca oluşur (docs/ESCAY-KARARLAR.md K11;
 * lib/paytr-checkout.ts), canlıda bu işin iptal edeceği sipariş kalmaz. Yalnız kimliksiz /
 * mock stub oturumlarla (yerel test) açılan ödenmemiş siparişler için durur:
 *   - success callback → capture, iş dokunmaz
 *   - failed callback → yalnızca sayaç; son denemeden itibaren süre yeniden işler
 *   - callback sonuçlanmış (manual_review / callback_processed) → iş dokunmaz
 *   - süre dolunca → cancelOrderWorkflow (stok serbest), ops event
 *
 * Env:
 *   UNPAID_ORDER_TIMEOUT_MINUTES (default 30)
 *   UNPAID_ORDER_LOOKBACK_DAYS (default 14) — bundan eski siparişlere bakılmaz
 */
export default async function cancelUnpaidPaytrOrdersJob(
  container: MedusaContainer
) {
  const logger = container.resolve("logger") as {
    info: (m: string) => void
    warn: (m: string) => void
    error: (m: string) => void
  }

  const timeoutMinutes = Math.max(
    1,
    Number(process.env.UNPAID_ORDER_TIMEOUT_MINUTES || 30) || 30
  )
  const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000)

  logger.info(
    `[unpaid-paytr-cleanup] start — timeout=${timeoutMinutes}m cutoff=${cutoff.toISOString()}`
  )

  const query = container.resolve(ContainerRegistrationKeys.QUERY) as unknown as {
    graph: (args: Record<string, unknown>) => Promise<{ data: unknown }>
  }

  // Ödenmiş siparişler de "pending" kalır: pencere + sayfalama olmadan her turda tüm
  // sipariş geçmişi okunurdu. Pencereden eski ödenmemiş sipariş bu işin konusu değil.
  const lookbackDays = Math.max(1, Number(process.env.UNPAID_ORDER_LOOKBACK_DAYS || 14) || 14)
  const since = new Date(Date.now() - lookbackDays * 86_400_000)
  const take = 200
  const orders: unknown[] = []
  for (let page = 0; page < 50; page++) {
    const { data } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "status",
      "payment_status",
      "canceled_at",
      "created_at",
      "payment_collections.id",
      "payment_collections.status",
      "payment_collections.payment_sessions.id",
      "payment_collections.payment_sessions.provider_id",
      "payment_collections.payment_sessions.status",
      "payment_collections.payment_sessions.data",
    ],
    filters: {
      status: "pending",
      created_at: { $lte: cutoff, $gte: since },
    },
    pagination: { take, skip: page * take, order: { created_at: "ASC" } },
    })
    const rows = (data as unknown[]) || []
    orders.push(...rows)
    if (rows.length < take) break
  }

  const candidates = (orders || []) as {
    id: string
    status?: string | null
    payment_status?: string | null
    canceled_at?: Date | string | null
    created_at?: Date | string | null
    payment_collections?: {
      payment_sessions?: {
        id?: string
        provider_id?: string | null
        status?: string | null
        data?: Record<string, unknown> | null
      }[]
    }[]
  }[]

  let canceled = 0
  let skipped = 0

  for (const order of candidates) {
    if (!isOrderUnpaidSafeToCancel(order)) {
      skipped++
      continue
    }

    const sessions =
      order.payment_collections?.flatMap((pc) => pc.payment_sessions || []) ||
      []
    const paytrSessions = sessions.filter(
      (s) => s.provider_id === PAYTR_PROVIDER_ID
    )

    // Yalnızca PayTR siparişleri; ödeme session'ı authorized/captured ise dokunma
    if (!paytrSessions.length) {
      skipped++
      continue
    }

    const stillPending = paytrSessions.some((s) => {
      const st = String(s.status || "")
      return (
        st === "pending" ||
        st === "pending_authorization" ||
        st === "error" ||
        st === "requires_more"
      )
    })

    const anyPaidSession = paytrSessions.some((s) => {
      const st = String(s.status || "")
      return st === "authorized" || st === "captured"
    })

    if (anyPaidSession || !stillPending) {
      skipped++
      continue
    }

    // Callback sonuçlanmış (capture ya da elle inceleme: para PayTR'de olabilir) → dokunma.
    if (paytrSessions.some((s) => isCallbackSettled(s.data))) {
      skipped++
      continue
    }

    // Son başarısız deneme eşiğin içindeyse müşteri hâlâ aynı iframe'de deniyor
    // (3D Secure tekrar denemesi) — süre son denemeden itibaren yeniden işler.
    if (paytrSessions.some((s) => isRetryingSince(s.data, cutoff))) {
      skipped++
      continue
    }

    const oid = paytrSessions
      .map((s) =>
        typeof s.data?.merchant_oid === "string" ? s.data.merchant_oid : ""
      )
      .find((v) => v)

    try {
      const runCancel = () =>
        cancelUnpaidOrderIfSafe(container, order.id, "[unpaid-paytr-cleanup]")

      const result = oid
        ? await resolveLocking(container).execute(paytrCallbackLockKey(oid), runCancel, {
            timeout: 30,
            ttl: 120,
          })
        : await runCancel()
      if (result.canceled) {
        canceled++
        await recordOpsEvent(container, {
          kind: "order.canceled_unpaid",
          level: "warning",
          title: `Ödeme ${timeoutMinutes} dk içinde tamamlanmadı — sipariş iptal`,
          detail: "Müşteri PayTR ödeme ekranını tamamlamadı (vazgeçti / sayfadan ayrıldı). Para çekilmedi.",
          orderId: order.id,
          data: { merchant_oid: oid || null },
        })
      } else skipped++
    } catch (err) {
      logger.error(
        `[unpaid-paytr-cleanup] order=${order.id} error: ${describeError(err)}`
      )
    }
  }

  logger.info(
    `[unpaid-paytr-cleanup] done — candidates=${candidates.length} canceled=${canceled} skipped=${skipped}`
  )
}

export const config = {
  name: "cancel-unpaid-paytr-orders",
  // Her 10 dakikada bir
  schedule: "*/10 * * * *",
}

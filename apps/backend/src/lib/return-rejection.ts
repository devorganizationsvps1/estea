import { MedusaContainer } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from "@medusajs/framework/utils"
import {
  cancelReturnReceiveWorkflow,
  cancelReturnWorkflow,
} from "@medusajs/medusa/core-flows"

import { resolveLocking } from "../modules/paytr/order-guards"
import { recordOpsEvent } from "./ops-events"
import { cancelCarrierReturnCode, ReturnInTransitError, type ReturnCodeCancelResult } from "./return-code-cancel"
import { returnLockKey } from "./return-lock"
import {
  newSendBack,
  planRejection,
  readSendBack,
  SEND_BACK_META_KEY,
  type RejectionInput,
  type RejectionPhoto,
  type RejectionReasonCode,
  type RejectionStage,
} from "./return-rejection-plan"

/** metadata.escay_rejection — refund ASLA tetiklenmemeli */
export type EscayRejectionMeta = {
  rejected: true
  at: string
  /** Müşteriye gösterilen tam sebep (liste etiketi + açıklama) */
  reason?: string | null
  rejected_by?: string | null
  /** Paket gelmeden mi, incelendikten sonra mı (eski kayıtlarda yok) */
  stage?: RejectionStage
  reason_code?: RejectionReasonCode
  note?: string | null
  /** İnceleme fotoğrafları (itirazda kanıt) */
  photos?: RejectionPhoto[]
}

export function isReturnRejected(
  metadata: Record<string, unknown> | null | undefined
): boolean {
  if (!metadata || typeof metadata !== "object") return false
  const block = metadata.escay_rejection
  if (block && typeof block === "object") {
    return (block as { rejected?: unknown }).rejected === true
  }
  // legacy / shorthand
  return metadata.rejected === true
}

export type RejectReturnResult = {
  return_id: string
  order_id: string
  status: string | null
  canceled: boolean
  refund_blocked: boolean
  rejection: EscayRejectionMeta
  /** Paket gelmeden rette kargo firmasındaki iade kodunun akıbeti */
  return_code?: ReturnCodeCancelResult
}

export type RejectReturnInput = RejectionInput & {
  return_id: string
  rejected_by?: string | null
}

type ReturnRow = {
  id: string
  status?: string | null
  order_id: string
  metadata?: Record<string, unknown> | null
  canceled_at?: string | Date | null
  items?: { id?: string; item_id?: string | null; quantity?: number | null; received_quantity?: number | null }[]
}

async function loadReturn(scope: MedusaContainer, returnId: string): Promise<ReturnRow | undefined> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "return",
    fields: [
      "id",
      "status",
      "order_id",
      "metadata",
      "canceled_at",
      "items.id",
      "items.item_id",
      "items.quantity",
      "items.received_quantity",
    ],
    filters: { id: returnId },
  })
  return data?.[0] as ReturnRow | undefined
}

/**
 * Mağaza iade reddi. İki durum:
 *  - "before_arrival": paket gelmedi. Kargo firmasındaki iade kodu iptal edilir (paket yoldaysa
 *    ret durur), müşteriye "göndermeyin" maili gider.
 *  - "inspected": paket elimizde, incelendi. Sebep + fotoğraf zorunlu; ürün müşteriye geri
 *    gönderilmek üzere `escay_send_back` kaydı açılır (bkz. return-send-back.ts).
 * Metadata önce yazılır (refund guard), sonra cancel: stok geri yazılmaz, refund yok.
 * Kabul ve kod yenilemeyle aynı kilit.
 */
export async function rejectStoreReturn(
  scope: MedusaContainer,
  input: RejectReturnInput
): Promise<RejectReturnResult> {
  return resolveLocking(scope).execute(returnLockKey(input.return_id), () => run(scope, input), {
    timeout: 60,
    ttl: 240,
  })
}

async function run(scope: MedusaContainer, input: RejectReturnInput): Promise<RejectReturnResult> {
  const logger = scope.resolve(ContainerRegistrationKeys.LOGGER)
  const returnId = input.return_id

  let ret = await loadReturn(scope, returnId)
  if (!ret?.id || !ret.order_id) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, "Return not found")
  }

  const existingRefund = ret.metadata?.paytr_refund as
    | { status?: string }
    | undefined
  if (existingRefund?.status === "success") {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Para iadesi yapılmış iade reddedilemez."
    )
  }

  if (isReturnRejected(ret.metadata)) {
    return {
      return_id: ret.id,
      order_id: ret.order_id,
      status: ret.status ?? null,
      canceled: Boolean(ret.canceled_at) || ret.status === "canceled",
      refund_blocked: true,
      rejection: (ret.metadata?.escay_rejection || {
        rejected: true,
        at: new Date().toISOString(),
      }) as EscayRejectionMeta,
    }
  }
  if (ret.canceled_at || ret.status === "canceled") {
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "İptal edilmiş iade reddedilemez.")
  }

  const hasReceivedQty = (ret.items || []).some(
    (i) => Number(i.received_quantity || 0) > 0
  )
  const alreadyReceived =
    ret.status === "received" ||
    ret.status === "partially_received" ||
    hasReceivedQty

  let plan: ReturnType<typeof planRejection>
  try {
    plan = planRejection(input, { alreadyReceived })
  } catch (error) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, (error as Error).message)
  }

  // Paket gelmeden ret: önce kargo kodu. Paket yoldaysa hiçbir şey değişmeden dur.
  let returnCode: ReturnCodeCancelResult | undefined
  if (plan.stage === "before_arrival") {
    try {
      returnCode = await cancelCarrierReturnCode(scope, returnId)
    } catch (error) {
      if (error instanceof ReturnInTransitError) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          `Müşteri paketi kargoya vermiş, iade reddedilmedi. Paket ulaşınca inceleyip "Paket elimizde" seçeneğiyle reddedin. (${error.message})`
        )
      }
      throw error
    }
    // Kod iptali metadata'yı değiştirdi: taze oku.
    ret = (await loadReturn(scope, returnId)) as ReturnRow
  }

  const rejection: EscayRejectionMeta = {
    rejected: true,
    at: new Date().toISOString(),
    reason: plan.reason,
    rejected_by: input.rejected_by || null,
    stage: plan.stage,
    reason_code: plan.reason_code,
    note: plan.note,
    photos: plan.photos,
  }

  // İncelenen ürün müşterinin malı: geri gönderim kaydı ret ile aynı yazımda açılır.
  const sendBackItems = (ret.items || [])
    .filter((i) => i.item_id && Number(i.quantity || 0) > 0)
    .map((i) => ({ item_id: i.item_id as string, quantity: Number(i.quantity) }))
  // Kısmi kabulden kalan geri gönderim kaydı varsa ona dokunulmaz.
  const sendBack =
    plan.stage === "inspected" && sendBackItems.length && !readSendBack(ret.metadata)
      ? newSendBack("rejection", sendBackItems)
      : null

  // CRITICAL: write rejection flag BEFORE cancel / any receive race
  await scope.resolve(Modules.ORDER).updateReturns([
    {
      selector: { id: returnId },
      data: {
        metadata: {
          ...(ret.metadata || {}),
          rejected: true,
          escay_rejection: rejection,
          ...(sendBack ? { [SEND_BACK_META_KEY]: sendBack } : {}),
          // Block PayTR retry even if somehow received later
          paytr_refund: {
            status: "skipped",
            error: "Return rejected — refund blocked",
            at: rejection.at,
            note: "escay_rejection",
          },
        },
      },
    },
  ])
  logger.info(
    `[return-reject] Marked rejected (${plan.stage}) — return=${returnId} order=${ret.order_id}`
  )

  let canceled = false

  if (!alreadyReceived) {
    try {
      await cancelReturnReceiveWorkflow(scope).run({
        input: { return_id: returnId },
      })
    } catch {
      // no active receive change — OK
    }

    try {
      await cancelReturnWorkflow(scope).run({
        input: {
          return_id: returnId,
          canceled_by: input.rejected_by || undefined,
        },
      })
      canceled = true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn(
        `[return-reject] cancelReturn failed — return=${returnId}: ${message}`
      )
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `İade reddedildi (refund engellendi) ancak iptal edilemedi: ${message}`
      )
    }
  } else {
    logger.warn(
      `[return-reject] Return already has received qty — refund blocked only, ` +
        `status unchanged — return=${returnId}`
    )
  }

  const codeOpen = returnCode && (returnCode.state === "manual" || returnCode.state === "failed")
  await recordOpsEvent(scope, {
    kind: "return.rejected",
    level: codeOpen ? "warning" : "info",
    title: plan.stage === "before_arrival" ? "İade reddedildi (paket gelmeden)" : "İade reddedildi (ürün incelendi)",
    detail: [
      `Sebep: ${plan.reason}`,
      returnCode?.state === "canceled" ? `Kargo firmasındaki iade kodu (${returnCode.code}) iptal edildi.` : null,
      returnCode?.state === "manual" ? `İade kodu (${returnCode.code}) kargo panelinden elle iptal edilmeli.` : null,
      returnCode?.state === "failed"
        ? `İade kodu (${returnCode.code}) kargo firmasında iptal edilemedi, panelden elle iptal edin: ${returnCode.error}`
        : null,
      sendBack ? "Ürün müşteriye geri gönderilecek." : null,
    ]
      .filter(Boolean)
      .join(" "),
    orderId: ret.order_id,
    data: { return_id: returnId, stage: plan.stage, reason_code: plan.reason_code, by: input.rejected_by || null },
  })

  try {
    const eventBus = scope.resolve(Modules.EVENT_BUS) as {
      emit: (event: {
        name: string
        data: Record<string, unknown>
      }) => Promise<unknown>
    }
    await eventBus.emit({
      name: "escay.return_rejected",
      data: {
        return_id: returnId,
        order_id: ret.order_id,
        reason: rejection.reason,
        rejected_by: rejection.rejected_by,
        canceled,
      },
    })
  } catch (emitErr) {
    logger.error(
      `[return-reject] Failed to emit escay.return_rejected — return=${returnId}: ${String(emitErr)}`
    )
  }

  const after = await loadReturn(scope, returnId)

  return {
    return_id: returnId,
    order_id: ret.order_id,
    status: after?.status ?? ret.status ?? null,
    canceled: canceled || Boolean(after?.canceled_at) || after?.status === "canceled",
    refund_blocked: true,
    rejection,
    ...(returnCode ? { return_code: returnCode } : {}),
  }
}

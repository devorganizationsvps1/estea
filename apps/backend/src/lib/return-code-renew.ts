import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { getConfiguredCarrier } from "../modules/carrier/registry"
import type { CarrierAdapter } from "../modules/carrier/types"
import { resolveLocking } from "../modules/paytr/order-guards"
import { errorText, recordOpsEvent } from "./ops-events"
import { clearCanceledReturnCode, recordCarrierReturnCode, sendReturnCodeToCustomer } from "./return-code"
import { returnLockKey } from "./return-lock"
import { isReturnRejected } from "./return-rejection"

export class ReturnCodeRenewError extends Error {}

type ReturnRow = {
  id: string
  status?: string | null
  order_id?: string | null
  metadata?: Record<string, unknown> | null
  order?: { fulfillments?: { canceled_at?: unknown; data?: Record<string, unknown> | null }[] | null } | null
}

type RenewTarget = {
  adapter: CarrierAdapter & { createReturn: NonNullable<CarrierAdapter["createReturn"]> }
  ret: ReturnRow
  originalData: Record<string, unknown>
}

/**
 * Yenilenebilir mi? Kargo firması kodlu iade sunmalı, iade bekliyor olmalı ve siparişte bu
 * firmayla açılmış gönderi bulunmalı. Panel düğmeyi buna göre gösterir (GET), POST da aynı
 * kontrolden geçer.
 */
export async function loadRenewTarget(container: MedusaContainer, returnId: string): Promise<RenewTarget> {
  const adapter = getConfiguredCarrier()
  if (!adapter?.createReturn) {
    throw new ReturnCodeRenewError("Bu kargo firması için otomatik iade kodu yok; kodu kargo panelinden açıp elle girin.")
  }
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "return",
    fields: ["id", "status", "order_id", "metadata", "order.fulfillments.canceled_at", "order.fulfillments.data"],
    filters: { id: returnId },
  })
  const ret = (data as ReturnRow[])[0]
  if (!ret) throw new ReturnCodeRenewError("İade bulunamadı.")
  if (ret.status !== "requested" || isReturnRejected(ret.metadata)) {
    throw new ReturnCodeRenewError("Kod yalnız bekleyen (teslim alınmamış) iade için yenilenir.")
  }
  const original = (ret.order?.fulfillments || []).find((f) => !f.canceled_at && adapter.owns(f.data))
  if (!original) {
    throw new ReturnCodeRenewError("Siparişte bu kargo firmasıyla açılmış gönderi yok; kodu elle girin.")
  }
  return { adapter: adapter as RenewTarget["adapter"], ret, originalData: original.data || {} }
}

/**
 * Kargo firmasında iade kodunu yeniden açar ve müşteriye yeniden gönderir:
 *  - kod hiç alınamamışsa (iade talebinde firma hatası) ilk kez açar,
 *  - kod varsa önce firmadaki kaydı iptal eder, sonra aynı referansla yeniden açar
 *    (DHL aynı kodu yeni etiket linkiyle verir; sandbox 2026-11-20).
 * Paket şubeye verilmişse adaptör iptali reddeder (yoldaki iade kaydı silinmez).
 * Kabul ve iade talebi aboneliğiyle aynı kilit: metadata yazımları birbirini ezmez.
 */
export async function renewCarrierReturnCode(
  container: MedusaContainer,
  input: { returnId: string; actorId?: string | null }
): Promise<{ code: string; email: string; renewal: number; canceledPrevious: boolean }> {
  return resolveLocking(container).execute(returnLockKey(input.returnId), () => run(container, input), {
    timeout: 60,
    ttl: 240,
  })
}

async function run(
  container: MedusaContainer,
  input: { returnId: string; actorId?: string | null }
): Promise<{ code: string; email: string; renewal: number; canceledPrevious: boolean }> {
  const { adapter, ret, originalData } = await loadRenewTarget(container, input.returnId)
  const meta = ret.metadata || {}
  const previous = meta.return_code_source === "carrier" && typeof meta.return_code === "string" ? meta.return_code : null

  const fail = async (title: string, detail: string, message: string): Promise<never> => {
    await recordOpsEvent(container, {
      kind: "return.code_failed",
      level: "error",
      title,
      detail,
      orderId: ret.order_id || null,
      data: { return_id: ret.id, previous },
    })
    throw new ReturnCodeRenewError(message)
  }

  let canceledPrevious = false
  if (previous && adapter.cancelReturn) {
    try {
      await adapter.cancelReturn(originalData, previous)
    } catch (error) {
      return fail(
        "İade kodu yenilenemedi",
        `Eski kod (${previous}) firmada iptal edilemedi, kod değişmedi. Hata: ${errorText(error)}`,
        `Eski iade kaydı iptal edilemedi, kod değişmedi: ${errorText(error)}`
      )
    }
    canceledPrevious = true
    // İptal edilen kod artık geçersiz: yeniden açma düşerse panel onu "gönderildi" göstermesin.
    await clearCanceledReturnCode(container, input.returnId, previous)
  }

  let code = ""
  let labelUrl: string | null = null
  try {
    const res = await adapter.createReturn(originalData, input.returnId)
    code = res.returnCode || res.trackingNumber || ""
    labelUrl = res.labelUrl ?? null
  } catch (error) {
    return fail(
      "İade kodu yenilenemedi",
      `${canceledPrevious ? `Eski kod (${previous}) iptal edildi, yenisi açılamadı. ` : ""}Hata: ${errorText(error)}. Tekrar deneyin ya da kargo panelinden açıp elle girin.`,
      `Kargo firması iade kaydını açmadı${canceledPrevious ? " (eski kod iptal edildi)" : ""}: ${errorText(error)}`
    )
  }
  if (!code) {
    return fail(
      "İade kodu yenilenemedi",
      `Kargo firması iade kodu döndürmedi${canceledPrevious ? `; eski kod (${previous}) iptal edildi` : ""}.`,
      "Kargo firması iade kodu döndürmedi."
    )
  }

  const renewal = (Number(meta.return_code_renewals) || 0) + 1
  await recordCarrierReturnCode(container, input.returnId, code, {
    labelUrl,
    meta: { return_code_renewals: renewal, return_code_renewed_at: new Date().toISOString() },
  })

  try {
    const { email } = await sendReturnCodeToCustomer(container, {
      returnId: input.returnId,
      orderId: ret.order_id,
      code,
      source: "carrier",
      actorId: input.actorId || null,
      renewal,
      labelUrl,
    })
    return { code, email, renewal, canceledPrevious }
  } catch (error) {
    return fail(
      "İade kodu müşteriye gönderilemedi",
      `Yeni kod (${code}) açıldı ama mail gitmedi: ${errorText(error)}. Sipariş sayfasından aynı kodu yeniden gönderin.`,
      `Yeni kod (${code}) açıldı ama müşteriye gönderilemedi: ${errorText(error)}`
    )
  }
}

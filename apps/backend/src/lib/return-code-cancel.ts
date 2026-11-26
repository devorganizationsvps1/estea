import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { getConfiguredCarrier } from "../modules/carrier/registry"
import { errorText } from "./ops-events"
import { clearCanceledReturnCode } from "./return-code"

type ReturnRow = {
  id: string
  metadata?: Record<string, unknown> | null
  order?: { fulfillments?: { canceled_at?: unknown; data?: Record<string, unknown> | null }[] | null } | null
}

/** Müşteri paketi kargoya vermiş: iade kaydı iptal edilemez, paket yolda. */
export class ReturnInTransitError extends Error {}

export type ReturnCodeCancelResult =
  /** Müşteriye kod gitmemiş */
  | { state: "none"; code: null }
  /** Kod elle açılmış ya da firma iptal sunmuyor: kargo panelinden elle iptal edilmeli */
  | { state: "manual"; code: string }
  | { state: "canceled"; code: string }
  /** Firma iptali yapamadı (bağlantı vb.): kod hâlâ açık olabilir */
  | { state: "failed"; code: string; error: string }

/**
 * Paket gelmeden ret: müşteriye gitmiş iade kodunu kargo firmasında iptal eder ki paket
 * sonradan bizim hesabımıza ücretli gelmesin. Paket şubeye verilmişse `ReturnInTransitError`
 * (çağıran reddi durdurur; paket gelince incelenip reddedilir). Çağıran iade kilidini tutar.
 */
export async function cancelCarrierReturnCode(container: MedusaContainer, returnId: string): Promise<ReturnCodeCancelResult> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "return",
    fields: ["id", "metadata", "order.fulfillments.canceled_at", "order.fulfillments.data"],
    filters: { id: returnId },
  })
  const ret = (data as ReturnRow[])[0]
  const meta = ret?.metadata || {}
  const code = typeof meta.return_code === "string" && meta.return_code.trim() ? meta.return_code.trim() : null
  if (!code) return { state: "none", code: null }

  const adapter = getConfiguredCarrier()
  const original = adapter ? (ret?.order?.fulfillments || []).find((f) => !f.canceled_at && adapter.owns(f.data)) : null
  if (meta.return_code_source !== "carrier" || !adapter?.cancelReturn || !original) return { state: "manual", code }

  try {
    await adapter.cancelReturn(original.data || {}, code)
  } catch (error) {
    if (/IN_TRANSIT/.test(String((error as { code?: unknown })?.code ?? ""))) {
      throw new ReturnInTransitError(errorText(error))
    }
    return { state: "failed", code, error: errorText(error) }
  }
  await clearCanceledReturnCode(container, returnId, code)
  return { state: "canceled", code }
}

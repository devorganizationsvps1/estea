import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

import { buildSendBackCustomerEmail, type SendBackEmailKind } from "../emails/return-notifications"
import { parsePackageProfile, resolvePackage } from "../modules/carrier/package-profile"
import { mapItems, mapRecipientAddress, type MedusaAddressLike } from "../modules/carrier/recipient"
import { buildOrderReference, carrierTestMode, getCarrierFor, getConfiguredCarrier } from "../modules/carrier/registry"
import { carrierErrorText, mergeFulfillmentData, readFulfillmentData } from "../modules/carrier/types"
import { resolveLocking } from "../modules/paytr/order-guards"
import { zplLabelsAsPdf } from "./label-zpl"
import { createNotificationIdempotent } from "./notify"
import { errorText, recordOpsEvent } from "./ops-events"
import { loadReturnEmailContext } from "./return-email-context"
import { returnLockKey } from "./return-lock"
import {
  isSendBackHoldExpired,
  readSendBack,
  SEND_BACK_HOLD_DAYS,
  SEND_BACK_META_KEY,
  sendBackHoldUntil,
  sendBackInHand,
  sendBackReference,
  type SendBackMeta,
  type SendBackStatus,
} from "./return-rejection-plan"

/**
 * Reddedilen (ya da kısmi kabulde kabul edilmeyen) ürünün müşteriye geri gönderimi.
 *
 * Ürün müşterinin malıdır: para iade edilmediyse ürün geri gider. Kargo ücreti bizden.
 * Müşteri istemezse yazılı onayıyla imha edilir. Teslim alınmayıp bize dönen paket
 * SEND_BACK_HOLD_DAYS gün bekletilir, sonra kayıt kapanır (müşteriye son bildirim).
 *
 * Kayıt `return.metadata.escay_send_back`. Medusa fulfillment'ı DEĞİL: kalemler zaten bir kez
 * gönderildi, yeniden fulfillment açmak stok rezervasyonu ister. Gönderi adaptörden doğrudan
 * açılır; durum yoklaması ve etiket bu kayıt üzerinden yürür.
 */

/** Panelde gösterilen iş hatası (400). */
export class SendBackError extends Error {}

type Dict = Record<string, unknown>

type ReturnRow = { id: string; order_id?: string | null; status?: string | null; metadata?: Dict | null }

type OrderRow = {
  id: string
  display_id?: number | string | null
  email?: string | null
  currency_code?: string | null
  metadata?: Dict | null
  shipping_address?: MedusaAddressLike | null
  items?: {
    id: string
    title?: string | null
    product_title?: string | null
    variant_title?: string | null
    variant_sku?: string | null
    unit_price?: number | null
    metadata?: Dict | null
  }[] | null
}

const LOCK = { timeout: 60, ttl: 240 }

async function loadReturn(container: MedusaContainer, returnId: string): Promise<ReturnRow> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "return",
    fields: ["id", "order_id", "status", "metadata"],
    filters: { id: returnId },
  })
  const ret = (data as ReturnRow[])[0]
  if (!ret) throw new SendBackError("İade bulunamadı.")
  return ret
}

function requireSendBack(ret: ReturnRow): SendBackMeta {
  const sb = readSendBack(ret.metadata)
  if (!sb) throw new SendBackError("Bu iadede geri gönderilecek ürün yok.")
  return sb
}

/** Taze metadata üzerine yazar (başka süreçlerin alanları ezilmesin). */
async function writeSendBack(container: MedusaContainer, returnId: string, patch: Partial<SendBackMeta>): Promise<SendBackMeta> {
  const ret = await loadReturn(container, returnId)
  const next = { ...requireSendBack(ret), ...patch } as SendBackMeta
  await container.resolve(Modules.ORDER).updateReturns([
    { selector: { id: returnId }, data: { metadata: { ...(ret.metadata || {}), [SEND_BACK_META_KEY]: next } } },
  ])
  return next
}

async function notifyCustomer(
  container: MedusaContainer,
  returnId: string,
  kind: SendBackEmailKind,
  sb: SendBackMeta,
  keySuffix: string
): Promise<boolean> {
  try {
    const ctx = await loadReturnEmailContext(container, returnId)
    if (!ctx?.email) return false
    const shipment = readFulfillmentData(sb.shipment)
    const mail = buildSendBackCustomerEmail({
      kind,
      orderDisplayId: ctx.orderDisplayId,
      items: sb.source === "partial_acceptance" ? ctx.notAccepted : ctx.items,
      carrierName: shipment.carrier_name,
      trackingNumber: shipment.tracking_number,
      trackingUrl: shipment.tracking_url,
      holdUntil: sb.hold_until,
      holdDays: SEND_BACK_HOLD_DAYS,
    })
    await createNotificationIdempotent(container.resolve(Modules.NOTIFICATION), {
      to: ctx.email,
      channel: "email",
      template: `return-send-back-${kind}`,
      content: { subject: mail.subject, html: mail.html, text: mail.text },
      resource_id: returnId,
      resource_type: "return",
      idempotency_key: `return-send-back-${kind}:${returnId}:${keySuffix}`,
    })
    return true
  } catch (error) {
    container
      .resolve(ContainerRegistrationKeys.LOGGER)
      .warn(`[send-back] ${kind} maili gönderilemedi return=${returnId}: ${errorText(error)}`)
    return false
  }
}

/** "Kargoya verildi" maili: takip numarası olunca bir kez (gecikmeli barkodda yoklama gönderir). */
async function notifyShippedOnce(container: MedusaContainer, returnId: string, sb: SendBackMeta): Promise<SendBackMeta> {
  const shipment = readFulfillmentData(sb.shipment)
  if (!shipment.tracking_number || (sb.shipment as Dict | null)?.customer_notified_at) return sb
  const sent = await notifyCustomer(container, returnId, "shipped", sb, shipment.shipment_ref || shipment.tracking_number)
  if (!sent) return sb
  return writeSendBack(container, returnId, {
    shipment: { ...(sb.shipment || {}), customer_notified_at: new Date().toISOString() },
  })
}

async function loadOrder(container: MedusaContainer, orderId: string): Promise<OrderRow> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "email",
      "currency_code",
      "metadata",
      "shipping_address.*",
      "items.id",
      "items.title",
      "items.product_title",
      "items.variant_title",
      "items.variant_sku",
      "items.unit_price",
      "items.metadata",
    ],
    filters: { id: orderId },
  })
  const order = (data as OrderRow[])[0]
  if (!order) throw new SendBackError("Sipariş bulunamadı.")
  return order
}

export type ShipSendBackInput = {
  returnId: string
  actorId?: string | null
  /** Elle kargo: takip numarası (ve firma adı). Kargo firması bağlı değilse zorunlu. */
  manual?: { carrierName?: string | null; trackingNumber?: string | null } | null
}

/**
 * Ürünü müşteriye geri gönderir. Kargo firması bağlıysa gönderiyi orada açar (ücret bizden,
 * teslimat adresine); değilse admin'in yazdığı takip numarasını kaydeder. Bize dönmüş paket
 * için yeniden çağrılabilir (yeni referansla).
 */
export async function shipSendBack(container: MedusaContainer, input: ShipSendBackInput): Promise<SendBackMeta> {
  return resolveLocking(container).execute(returnLockKey(input.returnId), () => runShip(container, input), LOCK)
}

async function runShip(container: MedusaContainer, input: ShipSendBackInput): Promise<SendBackMeta> {
  const ret = await loadReturn(container, input.returnId)
  const sb = requireSendBack(ret)
  if (!sendBackInHand(sb.status)) {
    throw new SendBackError(sb.status === "disposed" ? "Ürün imha edilmiş." : "Ürün zaten müşteriye gönderilmiş.")
  }
  if (!ret.order_id) throw new SendBackError("İadenin siparişi yok.")

  const adapter = getConfiguredCarrier()
  const manualTracking = input.manual?.trackingNumber?.trim() || ""
  let shipment: Dict

  if (manualTracking || !adapter) {
    if (!manualTracking) {
      throw new SendBackError("Kargo firması bağlı değil. Paketi kargoya verip takip numarasını yazın.")
    }
    shipment = {
      carrier: "manual",
      carrier_name: input.manual?.carrierName?.trim() || "Kargo",
      tracking_number: manualTracking,
      updated_at: new Date().toISOString(),
    }
  } else {
    const order = await loadOrder(container, ret.order_id)
    if (!order.shipping_address) throw new SendBackError("Siparişte teslimat adresi yok.")
    const email = (order.email || "").trim() || String(order.metadata?.email || "")
    const recipient = mapRecipientAddress(order.shipping_address, email, {
      defaultDistrict: process.env.SHIPPING_DEFAULT_DISTRICT?.trim() || undefined,
    })
    if (recipient.missing.length) {
      throw new SendBackError(
        `Geri gönderim için eksik adres alanları: ${recipient.missing.join(", ")}. Sipariş adresini tamamlayıp tekrar deneyin.`
      )
    }
    const byId = new Map((order.items || []).map((i) => [i.id, i]))
    const lines = sb.items.map((it) => ({ line: byId.get(it.item_id), quantity: it.quantity }))
    const parcel = resolvePackage(
      lines.map((l) => ({ quantity: l.quantity, metadata: l.line?.metadata ?? null, variantTitle: l.line?.variant_title ?? null })),
      parsePackageProfile(process.env.SHIPPING_PACKAGE_DEFAULT)
    )
    const reference = sendBackReference(buildOrderReference(order.display_id), ret.id)
    try {
      const result = await adapter.createShipment({
        order: {
          id: order.id,
          displayId: order.display_id ?? null,
          reference,
          isExchange: false,
          canceledShipmentRefs: sb.previous_refs || [],
          currencyCode: String(order.currency_code || "try").toUpperCase(),
          total: null,
        },
        recipient: recipient.value,
        parcel: { weight: parcel.weight, length: parcel.length, width: parcel.width, height: parcel.height },
        items: mapItems(
          lines.map((l) => ({
            title: l.line?.product_title || l.line?.title,
            variant_title: l.line?.variant_title,
            variant_sku: l.line?.variant_sku,
            quantity: l.quantity,
            unit_price: l.line?.unit_price != null ? Number(l.line.unit_price) : null,
            metadata: l.line?.metadata ?? null,
          }))
        ),
        testMode: carrierTestMode(),
      })
      shipment = mergeFulfillmentData(
        { carrier: adapter.code, carrier_name: adapter.name, order_reference: reference, test_mode: carrierTestMode() },
        result.data
      )
    } catch (error) {
      await recordOpsEvent(container, {
        kind: "return.send_back_failed",
        level: "error",
        title: "Reddedilen ürünün geri gönderimi açılamadı",
        detail: carrierErrorText(error),
        orderId: ret.order_id,
        data: { return_id: ret.id, reference },
      })
      throw new SendBackError(`${adapter.name} gönderisi açılamadı: ${carrierErrorText(error)}`)
    }
  }

  const now = new Date().toISOString()
  let next = await writeSendBack(container, ret.id, {
    status: "shipped",
    shipment,
    shipped_at: now,
    shipped_by: input.actorId || null,
    delivered_at: null,
    returned_at: null,
    hold_until: null,
    closed_at: null,
  })
  const data = readFulfillmentData(shipment)
  await recordOpsEvent(container, {
    kind: "return.send_back",
    level: "info",
    title: "Reddedilen ürün müşteriye geri gönderildi",
    detail: data.tracking_number ? `${data.carrier_name || "Kargo"} · takip no ${data.tracking_number}` : "Etiket bekleniyor",
    orderId: ret.order_id,
    data: { return_id: ret.id, shipment_ref: data.shipment_ref || null, by: input.actorId || null },
  })
  next = await notifyShippedOnce(container, ret.id, next)
  return next
}

/** Müşteri teslim almadı, paket depoya döndü: bekleme süresi başlar, müşteriye bildirilir. */
export async function markSendBackReturned(
  container: MedusaContainer,
  input: { returnId: string; actorId?: string | null; source?: string }
): Promise<SendBackMeta> {
  return resolveLocking(container).execute(
    returnLockKey(input.returnId),
    async () => {
      const ret = await loadReturn(container, input.returnId)
      const sb = requireSendBack(ret)
      if (sb.status === "returned") return sb
      if (sb.status !== "shipped") throw new SendBackError("Yalnız müşteriye gönderilmiş paket \"bize döndü\" işaretlenir.")
      const returnedAt = new Date().toISOString()
      const ref = readFulfillmentData(sb.shipment).shipment_ref
      const next = await writeSendBack(container, ret.id, {
        status: "returned",
        returned_at: returnedAt,
        hold_until: sendBackHoldUntil(returnedAt),
        previous_refs: ref ? [...new Set([...(sb.previous_refs || []), ref])] : sb.previous_refs || [],
      })
      await recordOpsEvent(container, {
        kind: "return.send_back_returned",
        level: "warning",
        title: "Geri gönderilen paket teslim alınmadı, bize döndü",
        detail: `${SEND_BACK_HOLD_DAYS} gün bekletilecek (${input.source || "panel"}).`,
        orderId: ret.order_id || null,
        data: { return_id: ret.id, hold_until: next.hold_until, by: input.actorId || null },
      })
      await notifyCustomer(container, ret.id, "returned", next, returnedAt)
      return next
    },
    LOCK
  )
}

/** Müşterinin yazılı onayıyla imha. Onayın nerede olduğu (tarih, kanal) zorunlu not. */
export async function disposeSendBack(
  container: MedusaContainer,
  input: { returnId: string; consentNote: string; actorId?: string | null }
): Promise<SendBackMeta> {
  const consent = (input.consentNote || "").trim().slice(0, 500)
  if (consent.length < 5) {
    throw new SendBackError("Müşterinin yazılı onayını not edin (tarih ve kanal, ör. \"25.11 e-postayla onayladı\").")
  }
  return resolveLocking(container).execute(
    returnLockKey(input.returnId),
    async () => {
      const ret = await loadReturn(container, input.returnId)
      const sb = requireSendBack(ret)
      if (sb.status === "disposed") return sb
      if (!sendBackInHand(sb.status)) throw new SendBackError("Ürün elimizde değil (müşteriye gönderilmiş); imha kaydedilemez.")
      const at = new Date().toISOString()
      const next = await writeSendBack(container, ret.id, {
        status: "disposed",
        disposal: { at, by: input.actorId || null, consent_note: consent },
      })
      await recordOpsEvent(container, {
        kind: "return.send_back",
        level: "info",
        title: "Reddedilen ürün müşteri onayıyla imha edildi",
        detail: `Onay: ${consent}`,
        orderId: ret.order_id || null,
        data: { return_id: ret.id, by: input.actorId || null },
      })
      await notifyCustomer(container, ret.id, "disposed", next, at)
      return next
    },
    LOCK
  )
}

/** Son N günde açılmış iadelerden, geri gönderimi verilen durumda olanlar. */
async function listSendBacks(
  container: MedusaContainer,
  statuses: SendBackStatus[],
  lookbackDays = 180
): Promise<{ ret: ReturnRow; sb: SendBackMeta }[]> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString()
  const out: { ret: ReturnRow; sb: SendBackMeta }[] = []
  const take = 200
  for (let page = 0; page < 50; page++) {
    const { data } = await query.graph({
      entity: "return",
      fields: ["id", "order_id", "status", "metadata"],
      filters: { created_at: { $gte: since } },
      pagination: { take, skip: page * take, order: { created_at: "DESC" } },
    })
    const rows = (data as ReturnRow[]) || []
    for (const ret of rows) {
      const sb = readSendBack(ret.metadata)
      if (sb && statuses.includes(sb.status)) out.push({ ret, sb })
    }
    if (rows.length < take) break
  }
  return out
}

/**
 * Yoldaki geri gönderimlerin durumunu kargo firmasından sorar: gecikmeli etiket/takip no,
 * teslim edildi, teslim alınmadı (bize dönüyor → bekleme süresi).
 */
export async function trackSendBacks(container: MedusaContainer): Promise<{ checked: number; changed: number }> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  let checked = 0
  let changed = 0
  for (const { ret, sb } of await listSendBacks(container, ["shipped"])) {
    const adapter = getCarrierFor(sb.shipment)
    if (!adapter?.getStatus || !sb.shipment) continue
    checked++
    try {
      const status = await adapter.getStatus(sb.shipment)
      const prev = readFulfillmentData(sb.shipment)
      const statusChanged = prev.status_code !== status.code
      let current = sb
      if (statusChanged || status.patch) {
        current = await writeSendBack(container, ret.id, {
          shipment: mergeFulfillmentData(sb.shipment, {
            ...(status.patch || {}),
            ...(statusChanged ? { status_code: status.code, status: status.description, status_at: new Date().toISOString() } : {}),
          }),
        })
        changed++
      }
      current = await notifyShippedOnce(container, ret.id, current)
      if (status.action === "delivered") {
        await writeSendBack(container, ret.id, { status: "delivered", delivered_at: new Date().toISOString() })
      } else if (status.action === "returned") {
        await markSendBackReturned(container, { returnId: ret.id, source: `${adapter.code} yoklaması` })
      } else if (status.action === "failed" || status.alert) {
        await recordOpsEvent(container, {
          kind: "shipment.problem",
          level: status.alert?.level || "warning",
          title: `Geri gönderimde kargo sorunu: ${prev.order_reference || ret.id}`,
          detail: status.alert ? `${status.alert.title}${status.alert.detail ? ` — ${status.alert.detail}` : ""}` : status.description,
          orderId: ret.order_id || null,
          data: { return_id: ret.id, status: { code: status.code, description: status.description } },
          oncePerTitle: true,
        })
      }
    } catch (error) {
      logger.warn(`[send-back] ${adapter.code} ${ret.id} sorgulanamadı: ${errorText(error)}`)
    }
  }
  return { checked, changed }
}

/** Bekleme süresi dolan (bize dönmüş) geri gönderimleri kapatır; müşteriye son bildirim gider. */
export async function closeExpiredSendBacks(container: MedusaContainer, now: Date = new Date()): Promise<number> {
  let closed = 0
  for (const { ret } of await listSendBacks(container, ["returned"])) {
    const did = await resolveLocking(container).execute(
      returnLockKey(ret.id),
      async () => {
        const sb = readSendBack((await loadReturn(container, ret.id)).metadata)
        if (!sb || !isSendBackHoldExpired(sb, now)) return false
        const closedAt = now.toISOString()
        const next = await writeSendBack(container, ret.id, { status: "closed", closed_at: closedAt })
        await recordOpsEvent(container, {
          kind: "return.send_back",
          level: "warning",
          title: `Geri gönderimde ${SEND_BACK_HOLD_DAYS} günlük bekleme süresi doldu, kayıt kapandı`,
          detail: "Ürün depoda. Müşteri yazarsa iadeyi açıp yeniden gönderebilir ya da onayıyla imha edebilirsiniz.",
          orderId: ret.order_id || null,
          data: { return_id: ret.id },
        })
        await notifyCustomer(container, ret.id, "closed", next, closedAt)
        return true
      },
      LOCK
    )
    if (did) closed++
  }
  return closed
}

export type SendBackLabel =
  | { kind: "zpl"; body: string; fileName: string }
  | { kind: "pdf"; body: Buffer }

/** Geri gönderim kargo etiketi: ZPL (yazıcıya doğrudan) ya da PDF. */
export async function getSendBackLabel(container: MedusaContainer, returnId: string): Promise<SendBackLabel> {
  const sb = requireSendBack(await loadReturn(container, returnId))
  const shipment = (sb.shipment || {}) as Dict
  const data = readFulfillmentData(shipment)
  if (sb.status !== "shipped" || !data.shipment_ref) throw new SendBackError("Bu geri gönderimin kargo firmasında etiketi yok.")
  if (data.label_zpl && !data.label_url && !zplLabelsAsPdf()) {
    return { kind: "zpl", body: `${data.label_zpl.trim()}\r\n`, fileName: `geri-gonderim-${data.shipment_ref}.zpl` }
  }
  if (data.label_url) {
    const response = await fetch(data.label_url)
    if (!response.ok) throw new SendBackError(`Kargo etiketi indirilemedi: HTTP ${response.status}`)
    return { kind: "pdf", body: Buffer.from(await response.arrayBuffer()) }
  }
  const adapter = getCarrierFor(shipment)
  if (!adapter?.getLabel) throw new SendBackError("Bu kargo firması etiket vermiyor; etiketi firmanın panelinden basın.")
  try {
    const out = await adapter.getLabel(shipment, "pdf")
    return { kind: "pdf", body: Buffer.isBuffer(out) ? out : Buffer.from(out) }
  } catch (error) {
    throw new SendBackError(carrierErrorText(error))
  }
}

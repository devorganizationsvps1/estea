import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  createPricedProducts,
  seedStorefrontFixture,
  type StorefrontFixture,
} from "./helpers/storefront-fixture"
import { placeGuestStubOrder, placePaidCardOrder } from "./helpers/place-order"
import { ensureTestReturnReason } from "./helpers/return-reason"
import {
  deliverOrderFulfillment,
  fulfillOrderItems,
  shipOrderFulfillment,
} from "./helpers/fulfill-order"
import { rejectStoreReturn } from "../../src/lib/return-rejection"
import { acceptReturnItems } from "../../src/lib/return-acceptance"
import { closeExpiredSendBacks, disposeSendBack, markSendBackReturned, shipSendBack } from "../../src/lib/return-send-back"
import { processReturnRefund, paidPricePerUnit } from "../../src/lib/return-refund"
import { previewReturnRefund } from "../../src/lib/return-refund-preview"
import { createPromotionsWorkflow } from "@medusajs/medusa/core-flows"

jest.setTimeout(120 * 1000)

function httpStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "response" in err) {
    return (err as { response?: { status?: number } }).response?.status
  }
  return undefined
}

async function firstOrderItemId(
  container: MedusaContainer,
  orderId: string,
  fallback?: string
): Promise<string> {
  if (fallback) return fallback
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: ["id", "items.id"],
    filters: { id: orderId },
  })
  const id = (data?.[0] as { items?: { id?: string }[] } | undefined)?.items?.[0]
    ?.id
  if (!id) throw new Error(`No items on order ${orderId}`)
  return id
}

/**
 * Returns HTTP surface — guest security + happy path after fulfill.
 * Full lifecycle (refund/restock/reject) stays in:
 *   npm run test:returns
 *   npm run test:smoke:full
 */
medusaIntegrationTestRunner({
  env: {
    PAYTR_MOCK: "1",
    PAYTR_MERCHANT_ID: "",
    PAYTR_MERCHANT_KEY: "",
    PAYTR_MERCHANT_SALT: "",
    SHIPPING_CARRIER: "",
    COOKIE_SECURE: "false",
  },
  testSuite: ({ api, getContainer }) => {
    describe("Returns (guest security)", () => {
      let fx: StorefrontFixture
      let variantId: string
      let reasonId: string

      beforeAll(async () => {
        fx = await seedStorefrontFixture(getContainer())
        const products = await createPricedProducts(getContainer(), fx, 1)
        variantId = products[0].variants![0].id
        reasonId = await ensureTestReturnReason(getContainer())
      })

      it("lists return reasons for store", async () => {
        const res = await api.get(`/store/return-reasons`, fx.storeHeaders)
        expect(res.status).toEqual(200)
        expect(Array.isArray(res.data.return_reasons)).toBeTruthy()
        expect(res.data.return_reasons.length).toBeGreaterThanOrEqual(1)
      })

      it("guest return with bogus order → 404 (no leak)", async () => {
        try {
          const res = await api.post(
            `/store/returns/guest`,
            {
              order_id: "order_does_not_exist",
              email: "anyone@escay.test",
              items: [{ id: "orli_fake", quantity: 1 }],
              reason_id: reasonId,
            },
            { ...fx.storeHeaders, throwOnError: false }
          )
          expect(res.status).toEqual(404)
        } catch (e: unknown) {
          expect(httpStatus(e)).toEqual(404)
        }
      })

      it("wrong email ≡ missing order (generic 404)", async () => {
        const email = `guest-ret-${Date.now()}@escay.test`
        const order = await placeGuestStubOrder(api, fx, variantId, email)
        const itemId = await firstOrderItemId(
          getContainer(),
          order.id,
          order.items[0]?.id
        )

        const wrong = await api
          .post(
            `/store/returns/guest`,
            {
              order_id: order.id,
              email: "wrong@example.invalid",
              items: [{ id: itemId, quantity: 1 }],
              reason_id: reasonId,
            },
            { ...fx.storeHeaders, throwOnError: false }
          )
          .catch((e: { response?: { status: number } }) => e.response)

        const missing = await api
          .post(
            `/store/returns/guest`,
            {
              order_id: "order_does_not_exist_zzz",
              email,
              items: [{ id: itemId, quantity: 1 }],
              reason_id: reasonId,
            },
            { ...fx.storeHeaders, throwOnError: false }
          )
          .catch((e: { response?: { status: number } }) => e.response)

        const wrongStatus =
          (wrong as { status?: number })?.status ??
          (wrong as { response?: { status: number } })?.response?.status
        const missingStatus =
          (missing as { status?: number })?.status ??
          (missing as { response?: { status: number } })?.response?.status
        expect(wrongStatus).toEqual(404)
        expect(missingStatus).toEqual(404)
      })

      it("unfulfilled guest order → 4xx (nothing returnable)", async () => {
        const email = `guest-ret-unful-${Date.now()}@escay.test`
        const order = await placeGuestStubOrder(api, fx, variantId, email)
        const itemId = await firstOrderItemId(
          getContainer(),
          order.id,
          order.items[0]?.id
        )

        try {
          const res = await api.post(
            `/store/returns/guest`,
            {
              order_id: order.id,
              email,
              items: [{ id: itemId, quantity: 1 }],
              reason_id: reasonId,
            },
            { ...fx.storeHeaders, throwOnError: false }
          )
          expect(res.status).toBeGreaterThanOrEqual(400)
          expect(res.status).toBeLessThan(500)
          expect(res.status).not.toEqual(404)
        } catch (e: unknown) {
          const status = httpStatus(e)
          expect(status).toBeGreaterThanOrEqual(400)
          expect(status).toBeLessThan(500)
          expect(status).not.toEqual(404)
        }
      })

      it("fulfilled but not shipped → 4xx (kargoya verilmeden iade yok)", async () => {
        const email = `guest-ret-noship-${Date.now()}@escay.test`
        const order = await placeGuestStubOrder(api, fx, variantId, email)
        const itemId = await firstOrderItemId(
          getContainer(),
          order.id,
          order.items[0]?.id
        )

        await fulfillOrderItems(getContainer(), {
          orderId: order.id,
          itemId,
          locationId: fx.stockLocationId,
          shippingOptionId: fx.shippingOptionId,
        })

        const res = await api
          .post(
            `/store/returns/guest`,
            {
              order_id: order.id,
              email,
              items: [{ id: itemId, quantity: 1 }],
              reason_id: reasonId,
            },
            { ...fx.storeHeaders, throwOnError: false }
          )
          .catch((e: { response?: { status: number } }) => e.response)
        const status =
          (res as { status?: number })?.status ??
          (res as { response?: { status: number } })?.response?.status
        expect(status).toBeGreaterThanOrEqual(400)
        expect(status).toBeLessThan(500)
      })

      it("delivered guest order → POST /store/returns/guest 200", async () => {
        const email = `guest-ret-ok-${Date.now()}@escay.test`
        const order = await placeGuestStubOrder(api, fx, variantId, email)
        const itemId = await firstOrderItemId(
          getContainer(),
          order.id,
          order.items[0]?.id
        )

        const fulfillment = await fulfillOrderItems(getContainer(), {
          orderId: order.id,
          itemId,
          locationId: fx.stockLocationId,
          shippingOptionId: fx.shippingOptionId,
        })
        await shipOrderFulfillment(getContainer(), {
          orderId: order.id,
          fulfillmentId: (fulfillment as { id: string }).id,
          itemId,
        })
        await deliverOrderFulfillment(getContainer(), {
          orderId: order.id,
          fulfillmentId: (fulfillment as { id: string }).id,
        })

        const res = await api.post(
          `/store/returns/guest`,
          {
            order_id: order.id,
            email,
            items: [{ id: itemId, quantity: 1 }],
            reason_id: reasonId,
            note: "integration guest return",
          },
          fx.storeHeaders
        )
        expect(res.status).toEqual(200)
        expect(res.data.return?.id).toBeTruthy()
        expect(res.data.return?.order_id).toEqual(order.id)
      })

      async function shippedGuestOrder(tag: string, deliver = true) {
        const email = `guest-ret-${tag}-${Date.now()}@escay.test`
        const order = await placeGuestStubOrder(api, fx, variantId, email)
        const itemId = await firstOrderItemId(getContainer(), order.id, order.items[0]?.id)
        const fulfillment = await fulfillOrderItems(getContainer(), {
          orderId: order.id,
          itemId,
          locationId: fx.stockLocationId,
          shippingOptionId: fx.shippingOptionId,
        })
        await shipOrderFulfillment(getContainer(), {
          orderId: order.id,
          fulfillmentId: (fulfillment as { id: string }).id,
          itemId,
        })
        if (deliver) {
          await deliverOrderFulfillment(getContainer(), {
            orderId: order.id,
            fulfillmentId: (fulfillment as { id: string }).id,
          })
        }
        return { order, email, itemId }
      }

      function postGuestReturn(orderId: string, email: string, itemId: string) {
        return api
          .post(
            `/store/returns/guest`,
            { order_id: orderId, email, items: [{ id: itemId, quantity: 1 }], reason_id: reasonId },
            { ...fx.storeHeaders, throwOnError: false }
          )
          .catch((e: { response?: { status: number } }) => e.response)
      }

      const statusOf = (r: unknown) =>
        (r as { status?: number })?.status ?? (r as { response?: { status: number } })?.response?.status

      it("shipped but not delivered → 4xx (teslim edilmeden iade yok)", async () => {
        const { order, email, itemId } = await shippedGuestOrder("transit", false)
        const res = await postGuestReturn(order.id, email, itemId)
        expect(statusOf(res)).toBeGreaterThanOrEqual(400)
        expect(statusOf(res)).toBeLessThan(500)
      })

      it("rejected return → same item cannot be requested again", async () => {
        const { order, email, itemId } = await shippedGuestOrder("rej")
        const first = await postGuestReturn(order.id, email, itemId)
        expect(statusOf(first)).toEqual(200)
        const returnId = (first as { data: { return: { id: string } } }).data.return.id

        await rejectStoreReturn(getContainer(), { return_id: returnId, stage: "before_arrival", reason_code: "other", note: "test" })

        const again = await postGuestReturn(order.id, email, itemId)
        expect(statusOf(again)).toBeGreaterThanOrEqual(400)
        expect(statusOf(again)).toBeLessThan(500)
      })

      it("incelenip reddedilen ürün: fotoğraf zorunlu, geri gönderim → bize döndü → 14 gün → yeniden gönder", async () => {
        const { order, email, itemId } = await shippedGuestOrder("sendback")
        const first = await postGuestReturn(order.id, email, itemId)
        const returnId = (first as { data: { return: { id: string } } }).data.return.id
        const container = getContainer()
        const query = container.resolve(ContainerRegistrationKeys.QUERY)
        const load = async () => {
          const { data } = await query.graph({ entity: "return", fields: ["id", "status", "metadata"], filters: { id: returnId } })
          return data[0] as { status: string; metadata: Record<string, unknown> }
        }
        const photo = { url: "https://cdn.escay.test/inceleme-1.jpg" }

        await expect(rejectStoreReturn(container, { return_id: returnId, stage: "inspected", reason_code: "opened" })).rejects.toThrow(/fotoğraf/)
        expect((await load()).status).toEqual("requested")

        await rejectStoreReturn(container, { return_id: returnId, stage: "inspected", reason_code: "opened", note: "bant yırtık", photos: [photo] })
        let ret = await load()
        expect(ret.status).toEqual("canceled")
        expect(ret.metadata.escay_rejection).toMatchObject({ rejected: true, stage: "inspected", reason_code: "opened", photos: [photo] })
        expect(ret.metadata.paytr_refund).toMatchObject({ status: "skipped" })
        expect(ret.metadata.escay_send_back).toMatchObject({ status: "awaiting", source: "rejection", items: [{ item_id: itemId, quantity: 1 }] })

        // Testte kargo firması bağlı değil: takip numarası elle girilir.
        await expect(shipSendBack(container, { returnId })).rejects.toThrow(/takip numarasını/)
        const shipped = await shipSendBack(container, { returnId, manual: { trackingNumber: "TR123", carrierName: "PTT" } })
        expect(shipped).toMatchObject({ status: "shipped", shipment: { carrier: "manual", tracking_number: "TR123" } })
        await expect(disposeSendBack(container, { returnId, consentNote: "onay verdi 25.11" })).rejects.toThrow(/elimizde değil/)

        const back = await markSendBackReturned(container, { returnId })
        expect(back.status).toEqual("returned")
        expect(await closeExpiredSendBacks(container)).toEqual(0)
        expect(await closeExpiredSendBacks(container, new Date(Date.now() + 15 * 86_400_000))).toEqual(1)
        ret = await load()
        expect(ret.metadata.escay_send_back).toMatchObject({ status: "closed" })
        // Ret kaydı ve para iadesi kilidi yerinde.
        expect(ret.metadata.escay_rejection).toMatchObject({ rejected: true })
        expect(ret.metadata.paytr_refund).toMatchObject({ status: "skipped" })

        const again = await shipSendBack(container, { returnId, manual: { trackingNumber: "TR456" } })
        expect(again).toMatchObject({ status: "shipped", hold_until: null })
      })

      it("paket gelmeden red: geri gönderim açılmaz; onaylı imha yalnız incelenen üründe", async () => {
        const a = await shippedGuestOrder("before")
        const ra = ((await postGuestReturn(a.order.id, a.email, a.itemId)) as { data: { return: { id: string } } }).data.return.id
        const container = getContainer()
        const query = container.resolve(ContainerRegistrationKeys.QUERY)
        const res = await rejectStoreReturn(container, { return_id: ra, stage: "before_arrival", reason_code: "period_expired" })
        expect(res.return_code).toEqual({ state: "none", code: null })
        const { data } = await query.graph({ entity: "return", fields: ["id", "status", "metadata"], filters: { id: ra } })
        expect(data[0].status).toEqual("canceled")
        expect((data[0].metadata as Record<string, unknown>).escay_send_back).toBeUndefined()
        await expect(shipSendBack(container, { returnId: ra, manual: { trackingNumber: "X1" } })).rejects.toThrow(/geri gönderilecek ürün yok/)

        const b = await shippedGuestOrder("dispose")
        const rb = ((await postGuestReturn(b.order.id, b.email, b.itemId)) as { data: { return: { id: string } } }).data.return.id
        await rejectStoreReturn(container, { return_id: rb, stage: "inspected", reason_code: "damaged", photos: [{ url: "https://cdn.escay.test/x.jpg" }] })
        await expect(disposeSendBack(container, { returnId: rb, consentNote: "" })).rejects.toThrow(/yazılı onayını/)
        const disposed = await disposeSendBack(container, { returnId: rb, consentNote: "25.11.2026 e-postayla onayladı" })
        expect(disposed).toMatchObject({ status: "disposed", disposal: { consent_note: "25.11.2026 e-postayla onayladı" } })
      })

      it("double submit at once → only one return created", async () => {
        const { order, email, itemId } = await shippedGuestOrder("dbl")
        const [a, b] = await Promise.all([
          postGuestReturn(order.id, email, itemId),
          postGuestReturn(order.id, email, itemId),
        ])
        const statuses = [statusOf(a), statusOf(b)].sort()
        expect(statuses[0]).toEqual(200)
        expect(statuses[1]).toBeGreaterThanOrEqual(400)

        const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)
        const { data } = await query.graph({
          entity: "return",
          fields: ["id", "status"],
          filters: { order_id: order.id },
        })
        expect(data.filter((r: { status?: string }) => r.status !== "canceled").length).toEqual(1)
      })

      it("3 adetli ödenmiş siparişte 1 adet iade → yalnız o adedin ödenen fiyatı geri gider", async () => {
        const email = `ret-partial-${Date.now()}@escay.test`
        const order = await placePaidCardOrder(api, getContainer(), fx, variantId, email, { quantity: 3 })
        const itemId = await firstOrderItemId(getContainer(), order.id, order.items[0]?.id)
        const fulfillment = await fulfillOrderItems(getContainer(), {
          orderId: order.id,
          itemId,
          quantity: 3,
          locationId: fx.stockLocationId,
          shippingOptionId: fx.shippingOptionId,
        })
        const fid = (fulfillment as { id: string }).id
        await shipOrderFulfillment(getContainer(), { orderId: order.id, fulfillmentId: fid, itemId, quantity: 3 })
        await deliverOrderFulfillment(getContainer(), { orderId: order.id, fulfillmentId: fid })

        const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)
        const { data: [before] } = await query.graph({
          entity: "order",
          fields: ["id", "total", "shipping_total", "items.id", "items.unit_price", "items.quantity", "items.total", "items.detail.quantity"],
          filters: { id: order.id },
        })
        const line = (before as any).items[0]
        const perUnit = Math.round((Number(line.total) / 3) * 100) / 100
        expect(perUnit).toBeGreaterThan(0)

        const created = await postGuestReturn(order.id, email, itemId)
        expect(statusOf(created)).toEqual(200)
        const returnId = (created as { data: { return: { id: string } } }).data.return.id
        // Onay kutusunda gösterilen tutar (önizleme) gerçek iadeyle aynı olmalı; hiçbir şey yazmaz.
        const preview = await previewReturnRefund(getContainer(), {
          return_id: returnId,
          items: [{ item_id: itemId, quantity: 1 }],
          refund_shipping: false,
        })
        expect(preview).toMatchObject({ mode: "card", certain: true, items_amount: perUnit, shipping_included: false })
        const none = await previewReturnRefund(getContainer(), { return_id: returnId, items: [], refund_shipping: false })
        expect(none.amount).toBe(0)

        await acceptReturnItems(getContainer(), {
          return_id: returnId,
          items: [{ item_id: itemId, restock_quantity: 1, damaged_quantity: 0 }],
        })
        const result = await processReturnRefund(getContainer(), { return_id: returnId })
        expect(result.meta.status).toBe("success")
        expect(result.meta.items_amount).toBe(perUnit)
        expect(result.meta.amount).toBe(preview.amount)
        expect(result.meta.amount).toBeLessThan(Number((before as any).total) - Number((before as any).shipping_total))
      })

      it("kuponlu siparişte birim iade fiyatı Medusa'nın hesabıyla aynı (indirim düşülmüş)", async () => {
        await createPromotionsWorkflow(getContainer()).run({
          input: {
            promotionsData: [
              {
                code: "IADE15",
                type: "standard",
                status: "active",
                application_method: { type: "percentage", target_type: "items", allocation: "across", value: 15, currency_code: "try" },
              },
            ],
          },
        })
        const order = await placeGuestStubOrder(api, fx, variantId, `kupon-${Date.now()}@escay.test`, { quantity: 3, promoCode: "IADE15" })
        const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)
        const { data: [o] } = await query.graph({
          entity: "order",
          fields: [
            "id", "shipping_total", "items.id", "items.unit_price", "items.quantity", "items.total", "items.is_tax_inclusive",
            "items.adjustments.amount", "items.tax_lines.rate", "items.detail.quantity", "items.detail.return_received_quantity",
            "items.detail.return_dismissed_quantity", "items.refundable_total_per_unit",
          ],
          filters: { id: order.id },
        })
        const line = (o as any).items[0]
        expect((line.adjustments || []).length).toBeGreaterThan(0)
        const ours = paidPricePerUnit(line, new Map())
        expect(ours).toBeLessThan(Number(line.unit_price))
        expect(ours).toBeCloseTo(Number(line.refundable_total_per_unit), 2)
        expect(ours * 3).toBeCloseTo(Number(line.total), 2)
      })
    })
  },
})

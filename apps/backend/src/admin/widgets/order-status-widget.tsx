import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Button, Checkbox, Container, Heading, Input, Label, Text, toast } from "@medusajs/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useParams } from "react-router-dom"
import { useState } from "react"
import { InlineConfirm, type ConfirmSpec } from "../components/inline-confirm"
import { formatDateTime } from "../lib/dates"
import { formatTL } from "../lib/money"
import { resolveNextStep, type StatusAction } from "../lib/order-next-step"
import { nextOrderStatusAction, ORDER_STATUS_BADGE, resolveOrderTimeline, type OrderTimelineInput } from "../lib/order-timeline"
import { printOrderLabels, skippedLabelsMessage } from "../lib/print-labels"

type OrderPayload = {
  order?: Omit<OrderTimelineInput, "payment_collections"> & {
    id?: string
    payment_collections?: { status?: string | null; captured_amount?: number | null; refunded_amount?: number | null }[] | null
  }
}

type FulfillmentState = {
  paid: boolean
  canceled: boolean
  has_fulfillment: boolean
  carrier_configured: boolean
  carrier: { code: string; name: string } | null
  active: { id: string; shipped: boolean; delivered: boolean; data: Record<string, unknown> } | null
}

const MANUAL_LABEL: Record<StatusAction, string> = {
  prepare: "Hazırlandı işaretle",
  ship: "Kargoya verildi işaretle",
  deliver: "Teslim edildi işaretle",
}

const ACTION_ORDER: StatusAction[] = ["prepare", "ship", "deliver"]

function hasCarrierLabel(data: Record<string, unknown>): boolean {
  return (typeof data.label_url === "string" && data.label_url.length > 0) || (typeof data.label_zpl === "string" && data.label_zpl.length > 0)
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "")

async function postJson(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json?.message || `HTTP ${res.status}`)
  return json
}

/**
 * Sipariş detayı: durum, kargo ve etiket tek kartta. Kartta her an tek ana düğme vardır
 * (lib/order-next-step.ts): gönderi aç → etiketi yazdır → (kurye ve teslim firmadan gelir).
 * Firma bağlı değilse adımlar elle işaretlenir. Nadir işler "Diğer işlemler" altındadır:
 * elle işaretleme, fişsiz baskı, gönderiyi yeniden açma, dış gönderi bağlama, iptal.
 */
const OrderStatusWidget = () => {
  const { id: orderId } = useParams()
  const qc = useQueryClient()
  const [trackingNumber, setTrackingNumber] = useState("")
  const [trackingUrl, setTrackingUrl] = useState("")
  const [moreOpen, setMoreOpen] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState("")
  const [attachOpen, setAttachOpen] = useState(false)
  const [attachRef, setAttachRef] = useState("")
  const [attachTracking, setAttachTracking] = useState("")
  const [attachShipped, setAttachShipped] = useState(true)
  const [printing, setPrinting] = useState<"label" | "slip" | null>(null)
  // Ödeme sonrası firma etiketi dakikalar içinde gelir; gelene kadar yoklanır (en çok 10 dk).
  const [mountedAt] = useState(() => Date.now())

  const { data, isLoading } = useQuery({
    queryKey: ["order-status", orderId],
    enabled: Boolean(orderId),
    queryFn: async () => {
      const res = await fetch(
        `/admin/orders/${orderId}?fields=id,status,metadata,*payment_collections,*fulfillments,*fulfillments.labels,*fulfillments.data`,
        { credentials: "include" }
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<OrderPayload>
    },
    refetchInterval: (query) => {
      const list = (query.state.data as OrderPayload | undefined)?.order?.fulfillments || []
      const waiting = list.some((f) => {
        const d = (f.data || {}) as Record<string, unknown>
        return !f.canceled_at && typeof d.shipment_ref === "string" && !hasCarrierLabel(d)
      })
      return waiting && Date.now() - mountedAt < 10 * 60 * 1000 ? 10_000 : false
    },
  })

  const state = useQuery({
    queryKey: ["order-fulfillment-state", orderId],
    enabled: Boolean(orderId),
    queryFn: async () => {
      const res = await fetch(`/admin/orders/${orderId}/fulfillment`, { credentials: "include" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<FulfillmentState>
    },
  })

  const refresh = () => void qc.invalidateQueries()

  const advanceMut = useMutation({
    mutationFn: (action: StatusAction) =>
      postJson(`/admin/orders/${orderId}/escay-status`, {
        action,
        tracking_number: trackingNumber.trim() || null,
        tracking_url: trackingUrl.trim() || null,
      }),
    onSuccess: () => {
      toast.success("Sipariş durumu güncellendi")
      setTrackingNumber("")
      setTrackingUrl("")
      refresh()
    },
    onError: (err: Error) => toast.error(err.message || "Güncelleme başarısız"),
  })

  const openShipment = useMutation({
    mutationFn: () => postJson(`/admin/orders/${orderId}/fulfillment/retry`),
    onSuccess: () => {
      toast.success("Kargo gönderisi açıldı.")
      refresh()
    },
    onError: (e: Error) => {
      toast.error(e.message, { duration: 60000 })
      refresh()
    },
  })

  const reship = useMutation({
    mutationFn: () => postJson(`/admin/orders/${orderId}/fulfillment/reship`),
    onSuccess: () => {
      toast.success("Gönderi yeniden açıldı. Etiketi yeniden yazdırın.")
      refresh()
    },
    onError: (e: Error) => toast.error(e.message, { duration: 60000 }),
  })

  const attach = useMutation({
    mutationFn: () =>
      postJson(`/admin/orders/${orderId}/fulfillment/attach`, {
        shipment_ref: attachRef.trim() || undefined,
        tracking_number: attachTracking.trim() || undefined,
        mark_shipped: attachShipped,
      }),
    onSuccess: () => {
      toast.success("Dış gönderi siparişe bağlandı.")
      setAttachOpen(false)
      setAttachRef("")
      setAttachTracking("")
      refresh()
    },
    onError: (e: Error) => toast.error(e.message, { duration: 60000 }),
  })

  const cancelMut = useMutation({
    mutationFn: () =>
      postJson(`/admin/orders/${orderId}/escay-cancel`, { reason: cancelReason.trim() || null }) as Promise<{
        refund_amount?: number
        manual_refund?: boolean
      }>,
    onSuccess: (json) => {
      const amount = Number(json.refund_amount || 0)
      toast.success(
        amount <= 0
          ? "Sipariş iptal edildi"
          : json.manual_refund
            ? `Sipariş iptal edildi. ${formatTL(amount)} tutarını müşteriye elle iade edin.`
            : `Sipariş iptal edildi, ${formatTL(amount)} karta iade edildi.`
      )
      setCancelOpen(false)
      setCancelReason("")
      refresh()
    },
    onError: (err: Error) => {
      toast.error(err.message || "İptal edilemedi", { duration: 60000 })
      refresh()
    },
  })

  if (!orderId) return null
  if (isLoading) {
    return (
      <Container className="px-6 py-4">
        <Text size="small" className="text-ui-fg-subtle">Sipariş durumu yükleniyor…</Text>
      </Container>
    )
  }

  const order = data?.order
  const timeline = order ? resolveOrderTimeline(order) : null
  const nextAction = order ? nextOrderStatusAction(order) : null
  // Teslim edilmiş / iptal siparişte iş kalmadı; durum başlıktaki rozette yazar.
  if (!order || !timeline || timeline.canceled || !nextAction) return null

  const fulfillments = order.fulfillments || []
  const active = fulfillments.find((f) => !f.canceled_at)
  const fData = (active?.data || {}) as Record<string, unknown>
  const g = state.data
  const carrierName = text(fData.carrier_name) || g?.carrier?.name || "Kargo firması"
  const shipmentRef = text(fData.shipment_ref)
  const tracking = text(fData.tracking_number) || text(active?.labels?.[0]?.tracking_number)
  const carrierLinked = Boolean(shipmentRef && fData.carrier !== "manual")
  const hasLabel = hasCarrierLabel(fData)
  const printedAt = text(order.metadata?.label_printed_at)
  const note = text(order.metadata?.order_note)

  const needsShipment = Boolean(g && g.carrier_configured && g.paid && !g.canceled && !g.has_fulfillment)
  const canReship = Boolean(g && g.carrier_configured && g.active && !g.active.shipped && !g.active.delivered && !g.canceled)
  // Şubede elle açılmış gönderi: kayıt yok ya da kayıtta firma kimliği yok ve paket henüz kargoya verilmedi.
  const canAttach = Boolean(g && g.paid && !g.canceled && (!g.active || (!g.active.shipped && !g.active.data.shipment_ref)))
  // Kargoya verilmemiş sipariş iptal edilebilir.
  const canCancel = nextAction !== "deliver" && !fulfillments.some((f) => !f.canceled_at && (f.shipped_at || f.delivered_at))

  // İptalde karta dönecek kesin tutar: tahsil edilen − daha önce iade edilen.
  const refundable = (order.payment_collections || []).reduce(
    (sum, pc) => sum + (Number(pc.captured_amount) || 0) - (Number(pc.refunded_amount) || 0),
    0
  )

  const step = resolveNextStep({ nextAction, needsShipment, carrierLinked, hasLabel })
  if (!step) return null
  const busy = advanceMut.isPending || openShipment.isPending || reship.isPending || printing !== null

  const print = async (withSlip: boolean) => {
    setPrinting(withSlip ? "slip" : "label")
    try {
      const skipped = await printOrderLabels([orderId], withSlip)
      if (skipped.length) toast.warning(skippedLabelsMessage(skipped))
      // Etiket basılınca sipariş "Hazırlandı" olur.
      refresh()
    } catch (err) {
      toast.error((err as Error).message || "Etiket alınamadı")
    } finally {
      setPrinting(null)
    }
  }

  // Elle işaretleme: kargo / teslim müşteriye mail atar, teslim faturayı da keser. Onaysız çalışmaz.
  const STEP_NAME: Record<StatusAction, string> = { prepare: "Hazırlandı", ship: "Kargoya verildi", deliver: "Teslim edildi" }
  const mark = (action: StatusAction) => {
    if (action === "prepare") return advanceMut.mutate(action)
    const skipped = ACTION_ORDER.slice(ACTION_ORDER.indexOf(nextAction), ACTION_ORDER.indexOf(action)).map((a) => STEP_NAME[a])
    setConfirm({
      text:
        action === "ship"
          ? "Sipariş Kargoya verildi olur ve müşteriye kargo maili gider. Yalnız paket gerçekten kargoya verildiyse işaretleyin."
          : "Sipariş Teslim edildi olur, müşteriye teslim maili gider ve fatura kesilir. Yalnız paket gerçekten teslim edildiyse işaretleyin.",
      lines: [
        ...(skipped.length ? [`Atlanan adım: ${skipped.join(", ")}`] : []),
        ...(carrierLinked ? [`Bu sipariş ${carrierName} üzerinde; durum normalde kendiliğinden ilerler.`] : []),
      ],
      confirmLabel: MANUAL_LABEL[action],
      onConfirm: () => advanceMut.mutate(action),
    })
  }

  // Ana düğmenin yaptığı adım "Diğer işlemler"de tekrar edilmez.
  const primaryAction = step.kind === "advance" ? step.action : null
  const manualActions = ACTION_ORDER.slice(ACTION_ORDER.indexOf(nextAction)).filter((a) => a !== primaryAction)
  const trackingInMain = step.kind === "advance" && step.action === "ship"
  const trackingInMore = !carrierLinked && !trackingInMain && manualActions.some((a) => a !== "prepare")

  const trackingInputs = (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <div className="flex flex-col gap-1">
        <Label size="xsmall" htmlFor="escay-tracking-no">Takip numarası (isteğe bağlı)</Label>
        <Input id="escay-tracking-no" size="small" value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <Label size="xsmall" htmlFor="escay-tracking-url">Takip linki (isteğe bağlı)</Label>
        <Input id="escay-tracking-url" size="small" value={trackingUrl} onChange={(e) => setTrackingUrl(e.target.value)} />
      </div>
    </div>
  )

  const guidance: Record<typeof step.kind, string> = {
    open_shipment: `Ödeme alınmış ama ${carrierName} gönderisi açılmamış. Sebebi sağdaki Olaylar kutusunda yazar; giderip gönderiyi açın.`,
    wait_label: "Gönderi açıldı, kargo etiketi bekleniyor. Birkaç dakika içinde gelir; bu kart kendiliğinden yenilenir.",
    print_label: "Kargo etiketi hazır. Yazdırıp pakete yapıştırın; sipariş Hazırlandı olur.",
    wait_courier: `Etiket basıldı. ${carrierName} paketi alınca durum kendiliğinden Kargoya verildi olur.`,
    wait_delivery: `Paket kargoda. Teslim bilgisi ${carrierName} tarafından gelir.`,
    advance:
      nextAction === "prepare"
        ? g?.carrier_configured
          ? `Bu siparişin gönderisi ${g.carrier?.name || "kargo firması"} üzerinde açık değil. Elle gönderiyorsanız adımları buradan işaretleyin.`
          : "Kargo firması bağlı değil. Paketi hazırlayın, kargo etiketini firmanın panelinden alın."
        : nextAction === "ship"
          ? "Paketi kargoya verince işaretleyin; müşteriye kargo maili gider."
          : "Paket müşteriye ulaşınca işaretleyin.",
  }

  return (
    <Container className="flex flex-col gap-4 px-6 py-4">
      <Heading level="h2">Sipariş durumu</Heading>

      <div className="flex flex-col gap-1.5">
        <ol className="m-0 grid list-none grid-cols-5 gap-1 p-0">
          {timeline.steps.map((s) => (
            <li key={s.key} className="flex flex-col gap-1.5" aria-current={s.current ? "step" : undefined}>
              <span className={`block h-1 rounded-full ${s.done || s.current ? "bg-ui-fg-interactive" : "bg-ui-border-strong"}`} />
              {/* Dar ekranda beş etiket sığmaz: yalnız çubuklar, altında etkin adım yazar. */}
              <Text size="xsmall" className={`max-sm:sr-only ${s.current ? "text-ui-fg-base font-medium" : "text-ui-fg-subtle"}`}>
                {ORDER_STATUS_BADGE[s.key]}
              </Text>
            </li>
          ))}
        </ol>
        <Text size="small" weight="plus" className="sm:hidden" aria-hidden>
          {ORDER_STATUS_BADGE[timeline.currentKey]} ({timeline.currentIndex + 1}. adım, 5 adımdan)
        </Text>
      </div>

      {note ? (
        <Text size="small" className="whitespace-pre-wrap rounded-md bg-ui-bg-subtle px-3 py-2">
          <span className="font-medium">Sipariş notu: </span>
          {note}
        </Text>
      ) : null}

      <div className="flex flex-col gap-1">
        <Text size="small">{guidance[step.kind]}</Text>
        {shipmentRef || tracking ? (
          <Text size="small" className="text-ui-fg-subtle">
            {carrierName}
            {shipmentRef ? `, gönderi no ${shipmentRef}` : ""}
            {tracking ? `, takip no ${tracking}` : ""}
          </Text>
        ) : null}
        {printedAt ? (
          <Text size="small" className="text-ui-fg-subtle">Etiket {formatDateTime(printedAt)} tarihinde yazdırıldı.</Text>
        ) : null}
      </div>

      {trackingInMain ? trackingInputs : null}

      <div className="flex flex-wrap items-center gap-2">
        {step.kind === "open_shipment" ? (
          <Button
            size="small"
            variant="primary"
            isLoading={openShipment.isPending}
            disabled={busy}
            onClick={() =>
              setConfirm({
                text: `Yeni ${carrierName} gönderisi açılır ve etiket oluşturulur (kargo ücreti doğar). Firmada bu siparişe ait açık gönderi olmadığından emin olun.`,
                confirmLabel: "Gönderi aç",
                onConfirm: () => openShipment.mutate(),
              })
            }
          >
            Gönderi aç
          </Button>
        ) : null}
        {step.kind === "print_label" ? (
          <Button size="small" variant="primary" isLoading={printing === "slip"} disabled={busy} onClick={() => void print(true)}>
            Etiket ve fişi yazdır
          </Button>
        ) : null}
        {step.kind === "wait_courier" && hasLabel ? (
          <Button size="small" variant="secondary" isLoading={printing === "slip"} disabled={busy} onClick={() => void print(true)}>
            Etiketi yeniden yazdır
          </Button>
        ) : null}
        {step.kind === "advance" ? (
          <>
            <Button size="small" variant="primary" isLoading={advanceMut.isPending} disabled={busy} onClick={() => mark(step.action)}>
              {MANUAL_LABEL[step.action]}
            </Button>
            {step.action === "prepare" ? (
              <Button size="small" variant="secondary" isLoading={printing === "label"} disabled={busy} onClick={() => void print(false)}>
                Sipariş fişini yazdır
              </Button>
            ) : null}
          </>
        ) : null}
        <Button
          size="small"
          variant="transparent"
          className="ml-auto"
          aria-expanded={moreOpen}
          aria-controls="escay-order-more"
          onClick={() => setMoreOpen((v) => !v)}
        >
          {moreOpen ? "Diğer işlemleri gizle" : "Diğer işlemler"}
        </Button>
      </div>

      <InlineConfirm spec={confirm} onClose={() => setConfirm(null)} />

      {moreOpen ? (
        <div id="escay-order-more" className="flex flex-col gap-3 border-t border-ui-border-base pt-3">
          {trackingInMore ? trackingInputs : null}
          <div className="flex flex-wrap gap-2">
            {manualActions.map((a) => (
              <Button key={a} size="small" variant="secondary" disabled={busy} onClick={() => mark(a)}>
                {MANUAL_LABEL[a]}
              </Button>
            ))}
            {hasLabel ? (
              <Button size="small" variant="secondary" isLoading={printing === "label"} disabled={busy} onClick={() => void print(false)}>
                Yalnız etiketi yazdır (fişsiz)
              </Button>
            ) : primaryAction !== "prepare" ? (
              <Button size="small" variant="secondary" isLoading={printing === "label"} disabled={busy} onClick={() => void print(false)}>
                Sipariş fişini yazdır
              </Button>
            ) : null}
            {canReship ? (
              <Button
                size="small"
                variant="secondary"
                isLoading={reship.isPending}
                disabled={busy}
                onClick={() =>
                  setConfirm({
                    text: "Mevcut gönderi firmada iptal edilir (firma reddederse işlem durur) ve yeni gönderi açılır. Eski etiket geçersiz olur. Yalnız kuryenin almadığı paketler için yapın.",
                    confirmLabel: "Gönderiyi yeniden aç",
                    onConfirm: () => reship.mutate(),
                  })
                }
              >
                Gönderiyi yeniden aç
              </Button>
            ) : null}
            {canAttach ? (
              <Button size="small" variant="secondary" aria-expanded={attachOpen} onClick={() => setAttachOpen((v) => !v)}>
                Dış gönderi bağla
              </Button>
            ) : null}
            {canCancel ? (
              <Button size="small" variant="secondary" className="text-ui-fg-error" disabled={busy} onClick={() => setCancelOpen(true)}>
                Siparişi iptal et
              </Button>
            ) : null}
          </div>

          {canAttach && attachOpen ? (
            <div className="flex flex-col gap-2 rounded-md bg-ui-bg-subtle p-3">
              <Text size="small">
                Paket şubede ya da firma panelinde elle açıldıysa buradan bağlayın. Firmaya yeni gönderi açılmaz; takip ve teslim buradan izlenir.
              </Text>
              <div className="flex flex-col gap-1">
                <Label size="xsmall" htmlFor="escay-attach-ref">Firma panelindeki gönderi numarası</Label>
                <Input id="escay-attach-ref" size="small" value={attachRef} onChange={(e) => setAttachRef(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1">
                <Label size="xsmall" htmlFor="escay-attach-tracking">Takip numarası ya da barkod</Label>
                <Input id="escay-attach-tracking" size="small" value={attachTracking} onChange={(e) => setAttachTracking(e.target.value)} />
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="escay-attach-shipped" checked={attachShipped} onCheckedChange={(v) => setAttachShipped(v === true)} />
                <Label htmlFor="escay-attach-shipped" size="xsmall">Paket kargoya verildi (müşteriye kargo maili gider)</Label>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="small"
                  variant="primary"
                  isLoading={attach.isPending}
                  disabled={!attachRef.trim() && !attachTracking.trim()}
                  onClick={() => attach.mutate()}
                >
                  Bağla
                </Button>
                <Button size="small" variant="secondary" disabled={attach.isPending} onClick={() => setAttachOpen(false)}>
                  Vazgeç
                </Button>
              </div>
            </div>
          ) : null}

          {canCancel && cancelOpen ? (
            <InlineConfirm
              loading={cancelMut.isPending}
              onClose={() => setCancelOpen(false)}
              spec={{
                amountLabel: refundable > 0 ? "Müşterinin kartına iade edilecek" : undefined,
                amount: refundable > 0 ? formatTL(refundable) : undefined,
                text: `${carrierLinked ? "Kargo gönderisi firmada iptal edilir, sipariş" : "Sipariş"} iptal edilir${refundable > 0 ? " ve ödenen tutar karta iade edilir" : ""}. Müşteriye iptal maili gider. Geri alınamaz.`,
                confirmLabel: refundable > 0 ? `İptal et ve ${formatTL(refundable)} iade et` : "Siparişi iptal et",
                danger: true,
                onConfirm: () => cancelMut.mutate(),
              }}
            >
              <div className="flex flex-col gap-1">
                <Label size="xsmall" htmlFor="escay-cancel-reason">Sebep (isteğe bağlı, müşteriye mailde görünür)</Label>
                <Input id="escay-cancel-reason" size="small" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
              </div>
            </InlineConfirm>
          ) : null}
        </div>
      ) : null}
    </Container>
  )
}

export const config = defineWidgetConfig({
  // Düzen kimliği: scripts/setup-admin-layouts.ts sıralamayı bununla yapar.
  id: "escay-order-status",
  zone: "order.details.after",
})

export default OrderStatusWidget

import { Badge, Button, Input, Label, Text, toast } from "@medusajs/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import {
  SEND_BACK_HOLD_DAYS,
  SEND_BACK_STATUS_LABEL,
  sendBackInHand,
  type SendBackMeta,
  type SendBackStatus,
} from "../../lib/return-rejection-plan"
import { formatDateTime } from "../lib/dates"
import { printSendBackLabel } from "../lib/print-labels"
import { InlineConfirm, type ConfirmSpec } from "./inline-confirm"

const BADGE: Record<SendBackStatus, "green" | "orange" | "red" | "grey" | "blue"> = {
  awaiting: "orange",
  shipped: "blue",
  delivered: "green",
  returned: "red",
  closed: "grey",
  disposed: "grey",
}

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "")

/**
 * İadesi kabul edilmeyen ürünün akıbeti (tam ret ya da kısmi kabulde kabul edilmeyen adet):
 * müşteriye geri gönder (kargo bizden), müşteri onayıyla imha et, teslim alınmayıp dönen
 * paketi yeniden gönder. Sıradaki iş tek ana düğmedir.
 */
export function SendBackPanel({
  returnId,
  sendBack,
  lineTitle,
  onChanged,
}: {
  returnId: string
  sendBack: SendBackMeta
  lineTitle: Map<string, string>
  onChanged: () => void
}) {
  const qc = useQueryClient()
  const [tracking, setTracking] = useState("")
  const [carrierName, setCarrierName] = useState("")
  const [disposeOpen, setDisposeOpen] = useState(false)
  const [consent, setConsent] = useState("")
  const [printing, setPrinting] = useState(false)
  const [pending, setPending] = useState<{ slot: string; spec: ConfirmSpec } | null>(null)
  const confirmAt = (slot: string) => (
    <InlineConfirm spec={pending?.slot === slot ? pending.spec : null} onClose={() => setPending(null)} />
  )

  const carrier = useQuery({
    queryKey: ["escay-send-back-carrier"],
    queryFn: async () => {
      const res = await fetch(`/admin/returns/${returnId}/send-back`, { credentials: "include" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as { carrier: { code: string; name: string } | null }
    },
    staleTime: 5 * 60_000,
  })

  const mut = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await fetch(`/admin/returns/${returnId}/send-back`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.message || `HTTP ${res.status}`)
      return json as { send_back: SendBackMeta }
    },
    onSuccess: (json, body) => {
      const s = json.send_back
      toast.success(
        body.action === "dispose"
          ? "İmha kaydedildi, müşteriye bildirildi"
          : body.action === "returned"
            ? `Paket bize döndü olarak işaretlendi; ${SEND_BACK_HOLD_DAYS} gün bekletilecek`
            : str(s.shipment?.tracking_number)
              ? `Geri gönderim açıldı, takip no ${str(s.shipment?.tracking_number)}`
              : "Geri gönderim açıldı; etiket kargo firmasından bekleniyor"
      )
      setDisposeOpen(false)
      setTracking("")
      onChanged()
    },
    onError: (err: Error) => {
      toast.error(err.message)
      void qc.invalidateQueries({ queryKey: ["escay-ops-events"] })
    },
  })

  const sb = sendBack
  const shipment = (sb.shipment || {}) as Record<string, unknown>
  const trackingNo = str(shipment.tracking_number)
  const inHand = sendBackInHand(sb.status)
  const connected = carrier.data?.carrier ?? null
  const manual = carrier.isSuccess && !connected
  const again = sb.status === "returned" || sb.status === "closed"

  return (
    <div className="flex flex-col gap-2 border-t border-ui-border-base pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Text size="small" weight="plus">
          Kabul edilmeyen ürün
        </Text>
        <Badge size="2xsmall" color={BADGE[sb.status]}>
          {SEND_BACK_STATUS_LABEL[sb.status]}
        </Badge>
      </div>
      {sb.items.map((it) => (
        <Text key={it.item_id} size="small">
          {it.quantity} × {lineTitle.get(it.item_id) || "Ürün"}
        </Text>
      ))}

      {sb.status === "awaiting" ? (
        <Text size="small" className="text-ui-fg-subtle">
          Ürün müşterinin malı. Kargo ücreti bizden olmak üzere geri gönderin; müşteri istemediğini yazarsa onayıyla imha edin.
        </Text>
      ) : null}
      {sb.status === "returned" ? (
        <Text size="small" className="text-ui-fg-subtle">
          Paket {formatDateTime(sb.returned_at)} tarihinde bize döndü, müşteriye bildirildi. {formatDateTime(sb.hold_until)} tarihine kadar bekletilir; müşteri yazarsa yeniden gönderin ya da onayıyla imha edin.
        </Text>
      ) : null}
      {sb.status === "closed" ? (
        <Text size="small" className="text-ui-fg-subtle">
          {SEND_BACK_HOLD_DAYS} günlük bekleme süresi {formatDateTime(sb.closed_at)} tarihinde doldu, müşteriye bildirildi. Ürün depoda; müşteri yazarsa yeniden gönderebilirsiniz.
        </Text>
      ) : null}
      {sb.status === "shipped" ? (
        <Text size="small">
          {trackingNo ? (
            <>
              {str(shipment.carrier_name) || "Kargo"} takip no:{" "}
              {str(shipment.tracking_url) ? (
                <a href={str(shipment.tracking_url)} target="_blank" rel="noreferrer" className="font-mono font-medium text-ui-fg-interactive">
                  {trackingNo}
                </a>
              ) : (
                <span className="font-mono font-medium">{trackingNo}</span>
              )}
              , {formatDateTime(sb.shipped_at)}
              {str(shipment.status) ? `. Son durum: ${str(shipment.status)}` : ""}
            </>
          ) : (
            "Gönderi açıldı; etiket kargo firmasından bekleniyor. Gelince takip numarası müşteriye e-postayla gider."
          )}
        </Text>
      ) : null}
      {sb.status === "delivered" ? (
        <Text size="small" className="text-ui-fg-subtle">
          {trackingNo ? `Takip no ${trackingNo}. ` : ""}Teslim: {formatDateTime(sb.delivered_at)}
        </Text>
      ) : null}
      {sb.status === "disposed" && sb.disposal ? (
        <Text size="small" className="text-ui-fg-subtle">
          {formatDateTime(sb.disposal.at)}. Müşteri onayı: {sb.disposal.consent_note}
        </Text>
      ) : null}

      {inHand ? (
        <>
          {manual ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <Label size="xsmall" htmlFor={`sb-carrier-${returnId}`}>Kargo firması</Label>
                <Input id={`sb-carrier-${returnId}`} size="small" value={carrierName} onChange={(e) => setCarrierName(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1">
                <Label size="xsmall" htmlFor={`sb-tracking-${returnId}`}>Takip numarası</Label>
                <Input id={`sb-tracking-${returnId}`} size="small" value={tracking} onChange={(e) => setTracking(e.target.value)} />
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="small"
              variant="primary"
              isLoading={mut.isPending && mut.variables?.action === "ship"}
              disabled={mut.isPending || carrier.isLoading || (manual && !tracking.trim())}
              onClick={() =>
                setPending({
                  slot: "ship",
                  spec: {
                    text: manual
                      ? `Takip numarası ${tracking.trim()} kaydedilir ve müşteriye e-postayla gider.`
                      : `${connected?.name || "Kargo firması"} üzerinde siparişin teslimat adresine gönderi açılır; kargo ücreti bizden. Takip numarası müşteriye e-postayla gider.`,
                    lines: sb.items.map((it) => `${it.quantity} × ${lineTitle.get(it.item_id) || "Ürün"}`),
                    confirmLabel: again ? "Yeniden gönder" : "Geri gönder",
                    onConfirm: () =>
                      mut.mutate(
                        manual
                          ? { action: "ship", tracking_number: tracking.trim(), carrier_name: carrierName.trim() }
                          : { action: "ship" }
                      ),
                  },
                })
              }
            >
              {again ? "Yeniden gönder" : "Müşteriye geri gönder"}
            </Button>
            <Button
              size="small"
              variant="secondary"
              aria-expanded={disposeOpen}
              disabled={mut.isPending}
              onClick={() => {
                setDisposeOpen((v) => !v)
                setPending(null)
              }}
            >
              {disposeOpen ? "İmhadan vazgeç" : "Müşteri istemiyor, imha et"}
            </Button>
          </div>
          {confirmAt("ship")}
          {disposeOpen ? (
            <div className="flex flex-col gap-2">
              <Label size="xsmall" htmlFor={`sb-consent-${returnId}`}>
                Müşterinin yazılı onayı (tarih ve kanal)
              </Label>
              <Input
                id={`sb-consent-${returnId}`}
                size="small"
                placeholder="25.11.2026, e-postayla onayladı"
                value={consent}
                onChange={(e) => setConsent(e.target.value)}
              />
              <Text size="small" className="text-ui-fg-subtle">
                Yazılı onay olmadan imha etmeyin; onay e-postasını saklayın.
              </Text>
              <div>
                <Button
                  size="small"
                  variant="secondary"
                  className="text-ui-fg-error"
                  isLoading={mut.isPending && mut.variables?.action === "dispose"}
                  disabled={mut.isPending || consent.trim().length < 5}
                  onClick={() =>
                    setPending({
                      slot: "dispose",
                      spec: {
                        text: "Ürün imha edilmiş olarak kaydedilir ve müşteriye bildirilir. Geri alınamaz.",
                        lines: [`Onay: ${consent.trim()}`],
                        confirmLabel: "İmhayı kaydet",
                        danger: true,
                        onConfirm: () => mut.mutate({ action: "dispose", consent_note: consent.trim() }),
                      },
                    })
                  }
                >
                  İmhayı kaydet
                </Button>
              </div>
              {confirmAt("dispose")}
            </div>
          ) : null}
        </>
      ) : null}

      {sb.status === "shipped" ? (
        <>
          <div className="flex flex-wrap gap-2">
            {str(shipment.shipment_ref) && str(shipment.carrier) !== "manual" ? (
              <Button
                size="small"
                variant={trackingNo ? "primary" : "secondary"}
                isLoading={printing}
                disabled={!trackingNo}
                onClick={async () => {
                  setPrinting(true)
                  try {
                    await printSendBackLabel(returnId)
                  } catch (error) {
                    toast.error(`Etiket alınamadı: ${(error as Error).message}`)
                  } finally {
                    setPrinting(false)
                  }
                }}
              >
                Etiketi yazdır
              </Button>
            ) : null}
            <Button
              size="small"
              variant="secondary"
              isLoading={mut.isPending && mut.variables?.action === "returned"}
              disabled={mut.isPending}
              onClick={() =>
                setPending({
                  slot: "returned",
                  spec: {
                    text: `Müşteri paketi teslim almadı ve paket depoya döndü. ${SEND_BACK_HOLD_DAYS} günlük bekleme süresi başlar, müşteriye e-postayla bildirilir.`,
                    confirmLabel: "Bize döndü olarak işaretle",
                    onConfirm: () => mut.mutate({ action: "returned" }),
                  },
                })
              }
            >
              Paket bize geri döndü
            </Button>
          </div>
          {confirmAt("returned")}
        </>
      ) : null}
    </div>
  )
}

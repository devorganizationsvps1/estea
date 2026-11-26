import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { InlineConfirm, type ConfirmSpec } from "../components/inline-confirm"
import { formatDateTime } from "../lib/dates"
import { formatTL } from "../lib/money"
import { Badge, Button, Container, Heading, Text } from "@medusajs/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useParams } from "react-router-dom"
import { useState } from "react"

type InvoiceMeta = {
  status?: string
  mode?: string
  invoice_id?: string
  invoice_number?: string
  invoice_type?: string
  pdf_url?: string
  total?: number
  error?: string
  at?: string
  retry_count?: number
}

type RefundMeta = {
  status?: string
  return_id?: string
  amount?: number
  invoice_number?: string
  pdf_url?: string
  error?: string
}

type OrderPayload = {
  order?: {
    id?: string
    metadata?: {
      parasut_invoice?: InvoiceMeta
      parasut_refund_invoices?: Record<string, RefundMeta>
    } | null
  }
}

function statusBadge(
  status?: string
): { label: string; color: "green" | "orange" | "red" | "grey" } {
  switch (status) {
    case "issued":
      return { label: "Kesildi", color: "green" }
    case "pending":
      return { label: "Kesiliyor", color: "orange" }
    case "unknown":
      return { label: "Belirsiz, kontrol edin", color: "red" }
    case "error":
      return { label: "Hata", color: "red" }
    case "skipped":
      return { label: "Atlandı", color: "grey" }
    case "draft_dryrun":
      return { label: "Deneme taslağı, resmi değil", color: "orange" }
    case "manual_required":
      return { label: "Paraşüt'ten elle kesilecek", color: "orange" }
    default:
      return { label: status || "Yok", color: "grey" }
  }
}

/**
 * Sipariş detayı — Paraşüt fatura durumu (yasal görünürlük).
 * metadata.parasut_invoice + parasut_refund_invoices.
 */
const ParasutInvoiceWidget = () => {
  const { id: orderId } = useParams()
  const qc = useQueryClient()
  const [retryMsg, setRetryMsg] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ["escay-order-parasut", orderId],
    enabled: Boolean(orderId),
    queryFn: async () => {
      const res = await fetch(
        `/admin/orders/${orderId}?fields=id,metadata`,
        { credentials: "include" }
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<OrderPayload>
    },
  })

  const retryMut = useMutation({
    mutationFn: async (confirmNotInParasut: boolean) => {
      const res = await fetch(
        `/admin/orders/${orderId}/parasut-invoice/retry`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            confirm_not_in_parasut: confirmNotInParasut,
          }),
        }
      )
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(body?.message || `HTTP ${res.status}`)
      }
      return body as {
        ok: boolean
        skipped?: boolean
        meta?: InvoiceMeta
      }
    },
    onSuccess: (body) => {
      if (body.meta?.status === "issued") {
        setRetryMsg(body.skipped ? "Zaten kesilmiş." : "Fatura kesildi.")
      } else if (body.meta?.status === "draft_dryrun") {
        setRetryMsg("Deneme modu: Paraşüt'te taslak açıldı, resmileştirilmedi.")
      } else if (body.meta?.status === "error" || body.meta?.status === "unknown") {
        setRetryMsg(`Hata: ${body.meta.error || "bilinmiyor"}`)
      } else {
        setRetryMsg(`Durum: ${body.meta?.status || "?"}`)
      }
      void qc.invalidateQueries({ queryKey: ["escay-order-parasut", orderId] })
    },
    onError: (err) => {
      setRetryMsg(err instanceof Error ? err.message : String(err))
    },
  })

  if (!orderId) return null

  const inv = data?.order?.metadata?.parasut_invoice
  const refunds = Object.values(
    data?.order?.metadata?.parasut_refund_invoices || {}
  )

  if (isLoading) {
    return (
      <Container className="px-6 py-4">
        <Text size="small" className="text-ui-fg-subtle">
          Fatura durumu yükleniyor…
        </Text>
      </Container>
    )
  }

  const st = statusBadge(inv?.status)
  // Satış faturası açılmadan kalan istek: Paraşüt'te kayıt olabilir, onaysız tekrar gitmez.
  const uncertain =
    inv?.status === "unknown" || (inv?.status === "pending" && !inv.invoice_id)
  // Satış faturası açılmış, resmileşmesi kalmış: tekrar deneme yeni fatura açmaz.
  const formalizePending = Boolean(inv?.invoice_id) && (inv?.status === "error" || inv?.status === "pending")
  const canSend = !inv || inv.status === "error" || formalizePending

  return (
    <Container className="px-6 py-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Heading level="h2">Fatura</Heading>
        <div className="flex items-center gap-1">
          {inv?.mode === "mock" ? <Badge size="2xsmall" color="orange">Deneme modu</Badge> : null}
          {inv ? <Badge size="2xsmall" color={st.color}>{st.label}</Badge> : null}
        </div>
      </div>

      <div className="space-y-1">

        {!inv ? (
          <Text size="small" className="text-ui-fg-subtle">
            Henüz kesilmedi. Sipariş teslim edilince kendiliğinden kesilir.
          </Text>
        ) : (
          <>
            {inv.invoice_number ? (
              <Text size="small">
                {inv.invoice_type === "e_invoice" ? "e-Fatura" : "e-Arşiv"} no:{" "}
                <span className="font-mono">{inv.invoice_number}</span>
              </Text>
            ) : inv.invoice_id ? (
              <Text size="small" className="text-ui-fg-subtle">
                Paraşüt kaydı: <span className="font-mono">{inv.invoice_id}</span>
              </Text>
            ) : null}
            {typeof inv.total === "number" ? (
              <Text size="small" className="text-ui-fg-subtle">
                Tutar: {formatTL(inv.total)}
              </Text>
            ) : null}
            {inv.status === "issued" && (inv.mode === "live" || inv.pdf_url) ? (
              <Text size="small">
                <a
                  href={
                    inv.mode === "live"
                      ? `/admin/orders/${orderId}/parasut-invoice/pdf`
                      : inv.pdf_url
                  }
                  target="_blank"
                  rel="noreferrer"
                  className="text-ui-fg-interactive underline"
                >
                  Faturayı aç (PDF)
                </a>
              </Text>
            ) : null}
            {inv.error ? (
              <Text size="small" className="text-ui-fg-error">
                {inv.error}
              </Text>
            ) : null}
            {typeof inv.retry_count === "number" && inv.retry_count > 0 ? (
              <Text size="small" className="text-ui-fg-subtle">
                {inv.retry_count} kez yeniden denendi
              </Text>
            ) : null}
            {inv.at ? (
              <Text size="small" className="text-ui-fg-subtle">
                {formatDateTime(inv.at)}
              </Text>
            ) : null}
          </>
        )}

        {canSend || uncertain ? (
          <div className="pt-2">
            <Button
              size="small"
              // Fatura yokken elle kesmek istisnadır: düğme geri planda durur.
              variant={inv ? "secondary" : "transparent"}
              disabled={retryMut.isPending}
              onClick={() => {
                const send = () => {
                  setRetryMsg(null)
                  retryMut.mutate(uncertain)
                }
                setConfirm(
                  uncertain
                    ? {
                        text: "Önce Paraşüt'te bu sipariş numarasıyla satış faturası olmadığını kontrol edin. Kayıt varsa çift fatura oluşur.",
                        confirmLabel: "Paraşüt'te yok, yeniden kes",
                        onConfirm: send,
                      }
                    : !inv
                      ? {
                          text: "Fatura normalde sipariş teslim edilince kendiliğinden kesilir. Şimdi keserseniz bu sipariş için yasal e-belge oluşur; geri alınamaz.",
                          confirmLabel: "Faturayı şimdi kes",
                          onConfirm: send,
                        }
                      : {
                          text: formalizePending
                            ? "Paraşüt'te açılmış satış faturası e-belge olarak resmileştirilir; yeni fatura açılmaz."
                            : "Fatura Paraşüt'te yeniden kesilir. Başarılı olursa bu sipariş için yasal e-belge oluşur.",
                          confirmLabel: "Yeniden kes",
                          onConfirm: send,
                        }
                )
              }}
            >
              {retryMut.isPending
                ? "Kesiliyor…"
                : uncertain
                  ? "Paraşüt'te yok, yeniden kes"
                  : !inv
                    ? "Faturayı şimdi kes"
                    : "Yeniden kes"}
            </Button>
            <div className="mt-2">
              <InlineConfirm spec={confirm} onClose={() => setConfirm(null)} />
            </div>
            {retryMsg ? (
              <Text size="small" className="mt-1 block text-ui-fg-subtle">
                {retryMsg}
              </Text>
            ) : null}
          </div>
        ) : null}
      </div>

      {refunds.length > 0 ? (
        <div className="mt-3 space-y-2">
          <Text size="small" className="font-medium">
            İade faturaları
          </Text>
          {refunds.map((r) => {
            const rs = statusBadge(r.status)
            return (
              <div
                key={r.return_id || "refund"}
                className="rounded-md border border-ui-border-base p-2 space-y-1"
              >
                <Badge color={rs.color}>{rs.label}</Badge>
                {r.invoice_number ? (
                  <Text size="small">
                    Belge no: <span className="font-mono">{r.invoice_number}</span>
                  </Text>
                ) : null}
                {typeof r.amount === "number" ? (
                  <Text size="small" className="text-ui-fg-subtle">
                    Tutar: {formatTL(r.amount)}
                  </Text>
                ) : null}
                {r.error ? (
                  <Text size="small" className="text-ui-fg-error">
                    {r.error}
                  </Text>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </Container>
  )
}

export const config = defineWidgetConfig({
  // Düzen kimliği: scripts/setup-admin-layouts.ts sıralamayı bununla yapar.
  id: "escay-order-invoice",
  zone: "order.details.side.after",
})

export default ParasutInvoiceWidget

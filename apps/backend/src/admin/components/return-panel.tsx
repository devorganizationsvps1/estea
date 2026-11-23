import { Badge, Button, Checkbox, Container, Heading, Input, Label, Text, toast } from "@medusajs/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { formatDateTime } from "../lib/dates"
import { formatTL } from "../lib/money"
import { InlineConfirm, type ConfirmSpec } from "./inline-confirm"

export type ReturnRow = {
  id: string
  status?: string | null
  created_at?: string | null
  items?: { item_id?: string | null; quantity?: number | null }[] | null
  metadata?: {
    customer_note?: string | null
    return_code?: string | null
    return_code_sent_at?: string | null
    return_code_source?: "manual" | "carrier" | null
    rejected?: boolean
    escay_acceptance?: {
      reason?: string | null
      items?: { item_id: string; requested: number; restock: number; damaged: number; rejected: number }[]
    } | null
    escay_rejection?: { rejected?: boolean; reason?: string | null }
    escay_exchange?: { status?: string } | null
    escay_cancel?: { at?: string; reason?: string | null } | null
    paytr_refund?: {
      status?: string
      amount?: number
      error?: string
      manual_required?: boolean
    }
  } | null
}

export function isRejected(r: ReturnRow): boolean {
  if (r.metadata?.escay_rejection?.rejected === true) return true
  if (r.metadata?.rejected === true) return true
  return false
}

export function statusLabel(r: ReturnRow): { label: string; color: "green" | "orange" | "red" | "grey" } {
  if (isRejected(r)) return { label: "Reddedildi", color: "red" }
  const pr = r.metadata?.paytr_refund?.status
  if (pr === "success") return { label: "Para iade edildi", color: "green" }
  if (pr === "failed") {
    return r.metadata?.paytr_refund?.manual_required
      ? { label: "Elle iade gerekli (havale)", color: "red" }
      : { label: "Para iadesi başarısız", color: "red" }
  }
  if (r.status === "partially_received") return { label: "Kısmen kabul edildi", color: "orange" }
  if (r.status === "received") return { label: "Teslim alındı", color: "green" }
  if (r.status === "canceled") return { label: "İptal", color: "grey" }
  if (r.status === "requested") return { label: "Talep alındı", color: "orange" }
  return { label: r.status || "—", color: "grey" }
}

type AcceptRow = { restock: number; damaged: number }

/** Ürün bazlı teslim alma — kabul edilenler için para iadesi otomatik (kabul edilmeyen kalem iade almaz). */
async function acceptItems(
  returnId: string,
  rows: Record<string, AcceptRow>,
  reason: string,
  refundShipping: boolean
) {
  const res = await fetch(`/admin/returns/${returnId}/accept`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items: Object.entries(rows).map(([item_id, r]) => ({
        item_id,
        restock_quantity: r.restock,
        damaged_quantity: r.damaged,
      })),
      reason: reason.trim() || null,
      refund_shipping: refundShipping,
    }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json?.message || `HTTP ${res.status}`)
  return json as { partial?: boolean }
}

/**
 * İade yönetimi (iade sayfası, /iadeler/:id): durum, ürünler, müşteriye giden
 * kod, tek adımda teslim al (+ otomatik para iadesi) veya reddet.
 * returnId verilirse yalnız o iade gösterilir.
 */
/**
 * "Kargo firmasından kod al / Kodu yenile". Yalnız sunucu uygun derse görünür (firma kodlu iade
 * sunuyor ve siparişte o firmanın gönderisi var); elle kargoda düğme hiç çıkmaz.
 */
function useCarrierCodeAvailable(returnId: string) {
  return useQuery({
    queryKey: ["escay-return-code-renew", returnId],
    queryFn: async () => {
      const res = await fetch(`/admin/returns/${returnId}/return-code/renew`, { credentials: "include" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as { available: boolean; reason: string | null }
    },
    staleTime: 60_000,
  })
}

const codeWasSent = (ret: ReturnRow) => Boolean(ret.metadata?.return_code && ret.metadata?.return_code_sent_at)

function CarrierCodeButton({
  ret,
  pending,
  loading,
  onRenew,
}: {
  ret: ReturnRow
  pending: boolean
  loading: boolean
  onRenew: (confirmText: string, confirmLabel: string) => void
}) {
  const { data } = useCarrierCodeAvailable(ret.id)
  if (!data?.available) return null
  const has = ret.metadata?.return_code_source === "carrier" && ret.metadata?.return_code
  return (
    <div>
      <Button
        size="small"
        // Kod gitmemişse sıradaki iş budur (ana düğme); gittiyse yenileme ikincil iştir.
        variant={codeWasSent(ret) ? "secondary" : "primary"}
        disabled={pending}
        isLoading={loading}
        onClick={() =>
          onRenew(
            has
              ? `Kargo firmasındaki iade kaydı (${ret.metadata?.return_code}) iptal edilip yeniden açılır ve yeni kod müşteriye e-postayla gider. Müşteri paketi şubeye verdiyse firma iptali kabul etmez, kod değişmez.`
              : "Kargo firmasında kodlu iade açılır ve kod müşteriye e-postayla gider.",
            has ? "Kodu yenile" : "Kod al ve gönder"
          )
        }
      >
        {has ? "Kodu yenile" : "Kargo firmasından kod al"}
      </Button>
    </div>
  )
}

/**
 * "Paket geldi": kabul formunu açar. Sıradaki iş buysa ana düğmedir: kod müşteriye gittiyse
 * ya da kargo firmasından kod alınamıyorsa (elle kargo). Kod bekleyen iadede ikincildir.
 */
function PackageArrivedButton({ ret, open, onToggle }: { ret: ReturnRow; open: boolean; onToggle: () => void }) {
  const { data } = useCarrierCodeAvailable(ret.id)
  const isNext = codeWasSent(ret) || data?.available === false
  return (
    <div>
      <Button size="small" variant={isNext && !open ? "primary" : "secondary"} aria-expanded={open} onClick={onToggle}>
        {open ? "Kabul formunu kapat" : "Paket geldi"}
      </Button>
    </div>
  )
}

export const ReturnPanel = ({ orderId, returnId }: { orderId: string; returnId?: string }) => {
  const qc = useQueryClient()
  const [reasonById, setReasonById] = useState<Record<string, string>>({})
  const [codeById, setCodeById] = useState<Record<string, string>>({})
  // Reddet / talebi iptal: nadir işlemler, "Diğer işlemler" açılınca görünür
  const [moreById, setMoreById] = useState<Record<string, boolean>>({})
  // Kabul formu "Paket geldi" düğmesinin arkasında: paket gelmeden para iadesi başlatılmasın.
  const [acceptOpenById, setAcceptOpenById] = useState<Record<string, boolean>>({})
  // returnId → item_id → kabul satırı (varsayılan: talep edilen adedin tamamı stoğa)
  const [acceptById, setAcceptById] = useState<Record<string, Record<string, AcceptRow>>>({})
  const [partialReasonById, setPartialReasonById] = useState<Record<string, string>>({})
  // returnId → "Kargo ücretini de iade et" işaretli mi
  const [shipById, setShipById] = useState<Record<string, boolean>>({})
  // Açık onay kutusu: hangi iadenin hangi düğmesi (tek seferde bir tane)
  const [pending, setPending] = useState<{ id: string; slot: string; sig?: string; spec: ConfirmSpec } | null>(null)
  const ask = (id: string, slot: string, spec: ConfirmSpec, sig?: string) => setPending({ id, slot, sig, spec })
  const confirmAt = (id: string, slot: string, sig?: string) => (
    <InlineConfirm
      spec={pending && pending.id === id && pending.slot === slot && pending.sig === sig ? pending.spec : null}
      onClose={() => setPending(null)}
    />
  )

  const { data, isLoading } = useQuery({
    queryKey: ["escay-order-returns", orderId],
    enabled: Boolean(orderId),
    queryFn: async () => {
      const res = await fetch(
        `/admin/orders/${orderId}?fields=id,shipping_total,*items,*returns,*returns.metadata,*returns.items`,
        { credentials: "include" }
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<{
        order?: {
          shipping_total?: number | null
          returns?: ReturnRow[]
          items?: {
            id: string
            title?: string | null
            variant_title?: string | null
            quantity?: number | null
          }[]
        }
      }>
    },
  })

  const returns = (data?.order?.returns || []).filter((r) => !returnId || r.id === returnId)
  const shippingTotal = Number(data?.order?.shipping_total) || 0
  const lineTitle = new Map(
    (data?.order?.items || []).map((i) => [i.id, [i.title, i.variant_title].filter(Boolean).join(" · ")])
  )
  const acceptRows = (r: ReturnRow): Record<string, AcceptRow> => {
    const saved = acceptById[r.id] || {}
    const out: Record<string, AcceptRow> = {}
    for (const it of r.items || []) {
      if (!it.item_id) continue
      out[it.item_id] = saved[it.item_id] ?? { restock: Number(it.quantity || 0), damaged: 0 }
    }
    return out
  }
  const setAccept = (r: ReturnRow, itemId: string, patch: Partial<AcceptRow>) =>
    setAcceptById((prev) => {
      const rows = { ...acceptRows(r), ...(prev[r.id] || {}) }
      const max = Number((r.items || []).find((i) => i.item_id === itemId)?.quantity || 0)
      const next = { ...rows[itemId], ...patch }
      // restock + hasarlı talep edileni aşmasın
      next.restock = Math.max(0, Math.min(max, Math.floor(next.restock || 0)))
      next.damaged = Math.max(0, Math.min(max - next.restock, Math.floor(next.damaged || 0)))
      return { ...prev, [r.id]: { ...rows, [itemId]: next } }
    })

  const codeMut = useMutation({
    mutationFn: async (input: { returnId: string; code: string }) => {
      const res = await fetch(`/admin/returns/${input.returnId}/return-code`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: input.code }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.message || `HTTP ${res.status}`)
      return json as { email?: string }
    },
    onSuccess: (json) => {
      toast.success(`İade kodu ${json.email || "müşteriye"} gönderildi`)
      qc.invalidateQueries({ queryKey: ["escay-order-returns", orderId] })
    },
    onError: (err: Error) => toast.error(err.message),
  })


  const renewMut = useMutation({
    mutationFn: async (input: { returnId: string }) => {
      const res = await fetch(`/admin/returns/${input.returnId}/return-code/renew`, {
        method: "POST",
        credentials: "include",
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.message || `HTTP ${res.status}`)
      return json as { code?: string; email?: string }
    },
    onSuccess: (json) => {
      toast.success(`Yeni iade kaydı açıldı (${json.code}), ${json.email || "müşteriye"} gönderildi`)
      qc.invalidateQueries({ queryKey: ["escay-order-returns", orderId] })
    },
    onError: (err: Error) => {
      toast.error(`İade kodu alınamadı: ${err.message}`)
      // Eski kod iptal edilip yenisi açılamadıysa panel "gönderildi" göstermesin diye tazele.
      qc.invalidateQueries({ queryKey: ["escay-order-returns", orderId] })
    },
  })

  const previewMut = useMutation({
    mutationFn: async (input: { returnId: string; rows: Record<string, AcceptRow>; refundShipping: boolean }) => {
      const res = await fetch(`/admin/returns/${input.returnId}/refund-preview`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: Object.entries(input.rows).map(([item_id, r]) => ({ item_id, quantity: r.restock + r.damaged })),
          refund_shipping: input.refundShipping,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.message || `HTTP ${res.status}`)
      return json as { mode: "card" | "manual" | "exchange"; amount: number; shipping_amount: number; shipping_included: boolean }
    },
    onError: (err: Error) => toast.error(`İade tutarı hesaplanamadı: ${err.message}`),
  })

  const receiveMut = useMutation({
    mutationFn: (input: { ret: ReturnRow; rows: Record<string, AcceptRow>; reason: string; refundShipping: boolean }) =>
      acceptItems(input.ret.id, input.rows, input.reason, input.refundShipping),
    onSuccess: (json) => {
      toast.success(
        json?.partial
          ? "Kısmen kabul edildi — kabul edilenlerin parası iade ediliyor"
          : "Teslim alındı — para iadesi başlatıldı"
      )
      // Para iadesi + fatura arka planda; birkaç saniye sonra durum güncellensin.
      void qc.invalidateQueries()
      for (const ms of [3000, 8000, 15000]) window.setTimeout(() => void qc.invalidateQueries(), ms)
    },
    onError: (err: Error) => toast.error(`Teslim alınamadı: ${err.message}`),
  })

  const retryMut = useMutation({
    mutationFn: async (input: { returnId: string }) => {
      const res = await fetch(`/admin/returns/${input.returnId}/refund`, {
        method: "POST",
        credentials: "include",
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(json?.paytr_refund?.error || json?.message || `HTTP ${res.status}`)
      }
      return json
    },
    onSuccess: () => {
      toast.success("Para iadesi yapıldı")
      qc.invalidateQueries({ queryKey: ["escay-order-returns", orderId] })
    },
    onError: (err: Error) => {
      toast.error(`Para iadesi yine başarısız: ${err.message}`)
      qc.invalidateQueries({ queryKey: ["escay-order-returns", orderId] })
    },
  })

  const rejectMut = useMutation({
    mutationFn: async (input: { returnId: string; reason: string }) => {
      const res = await fetch(`/admin/returns/${input.returnId}/reject`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: input.reason || null }),
      })
      const json = await res.json()
      if (!res.ok) {
        throw new Error(json?.message || `HTTP ${res.status}`)
      }
      return json
    },
    onSuccess: () => {
      toast.success("İade reddedildi — para iadesi yapılmayacak")
      qc.invalidateQueries({ queryKey: ["escay-order-returns", orderId] })
    },
    onError: (err: Error) => {
      toast.error(err.message || "Reddetme başarısız")
    },
  })

  const cancelMut = useMutation({
    mutationFn: async (input: { returnId: string }) => {
      const res = await fetch(`/admin/returns/${input.returnId}/cancel-request`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.message || `HTTP ${res.status}`)
      return json
    },
    onSuccess: () => {
      toast.success("İade talebi iptal edildi")
      void qc.invalidateQueries()
    },
    onError: (err: Error) => toast.error(err.message || "İptal edilemedi"),
  })

  if (!orderId) return null
  if (isLoading) {
    return (
      <Container className="px-6 py-4">
        <Text size="small" className="text-ui-fg-subtle">
          İadeler yükleniyor…
        </Text>
      </Container>
    )
  }
  if (!returns.length) return null

  return (
    <Container className="px-6 py-4">
      <Heading level="h2" className="mb-3">
        İade
      </Heading>
      <div className="flex flex-col gap-3">
        {returns.map((r) => {
          const st = statusLabel(r)
          const rejected = isRejected(r)
          const canReject =
            !rejected &&
            r.metadata?.paytr_refund?.status !== "success" &&
            r.status !== "canceled"

          return (
            <div
              key={r.id}
              className={returnId ? "space-y-3" : "rounded-md border border-ui-border-base p-3 space-y-2"}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <Badge color={st.color}>{st.label}</Badge>
                {r.metadata?.escay_exchange && r.metadata.escay_exchange.status !== "canceled" ? (
                  <Badge color="blue">Değişim — para iadesi yok, teslim alınca yeni ürün gönderilir</Badge>
                ) : null}
                {r.created_at ? (
                  <Text size="small" className="text-ui-fg-subtle">
                    {formatDateTime(r.created_at)}
                  </Text>
                ) : null}
              </div>
              {r.status === "requested" && !rejected ? null : (r.items || []).map((it, i) => {
                const acc = r.metadata?.escay_acceptance?.items?.find((a) => a.item_id === it.item_id)
                return (
                  <Text key={i} size="small">
                    {it.quantity} × {(it.item_id && lineTitle.get(it.item_id)) || "Ürün"}
                    {acc
                      ? ` — ${[
                          acc.restock ? `${acc.restock} stoğa` : null,
                          acc.damaged ? `${acc.damaged} hasarlı` : null,
                          acc.rejected ? `${acc.rejected} kabul edilmedi` : null,
                        ]
                          .filter(Boolean)
                          .join(", ")}`
                      : ""}
                  </Text>
                )
              })}
              {r.metadata?.escay_acceptance?.reason ? (
                <Text size="small" className="text-ui-fg-subtle">
                  Kabul edilmeme sebebi: {r.metadata.escay_acceptance.reason}
                </Text>
              ) : null}
              {r.metadata?.customer_note ? (
                <Text size="small" className="text-ui-fg-subtle">
                  Müşteri notu: {r.metadata.customer_note}
                </Text>
              ) : null}
              {r.metadata?.return_code ? (
                <Text size="small">
                  Müşteriye giden iade kodu:{" "}
                  <span className="font-mono font-medium">{r.metadata.return_code}</span>
                  {r.metadata.return_code_sent_at
                    ? `, ${formatDateTime(r.metadata.return_code_sent_at)}`
                    : ""}
                  {r.metadata.return_code_source === "carrier" ? ", kargo firmasından" : ""}
                  {!r.metadata.return_code_sent_at ? (
                    <span className="text-ui-fg-error">. Müşteriye gönderilemedi (e-posta hatası); aşağıdan yeniden gönderin.</span>
                  ) : null}
                </Text>
              ) : r.status === "requested" && !rejected ? (
                <Text size="small" className="text-ui-fg-error">
                  Müşteriye iade kodu gitmedi. Kargo firmasından kod alın ya da kargo panelinde açtığınız kodu yazıp gönderin.
                </Text>
              ) : null}
              {r.status === "requested" && !rejected ? (
                <CarrierCodeButton
                  ret={r}
                  pending={renewMut.isPending}
                  loading={renewMut.isPending && renewMut.variables?.returnId === r.id}
                  onRenew={(text, confirmLabel) =>
                    ask(r.id, "renew", { text, confirmLabel, onConfirm: () => renewMut.mutate({ returnId: r.id }) })
                  }
                />
              ) : null}
              {confirmAt(r.id, "renew")}
              {r.status === "requested" && !rejected && !(r.metadata?.return_code && r.metadata?.return_code_sent_at) ? (
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex flex-col gap-1">
                    <Label size="xsmall" htmlFor={`code-${r.id}`}>Kargo panelinde açtığınız iade kodu</Label>
                    <Input
                      id={`code-${r.id}`}
                    size="small"
                    value={codeById[r.id] ?? r.metadata?.return_code ?? ""}
                    onChange={(e) => setCodeById((prev) => ({ ...prev, [r.id]: e.target.value }))}
                    />
                  </div>
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={!(codeById[r.id] ?? r.metadata?.return_code ?? "").trim() || codeMut.isPending}
                    isLoading={codeMut.isPending && codeMut.variables?.returnId === r.id}
                    onClick={() => {
                      const code = (codeById[r.id] ?? r.metadata?.return_code ?? "").trim()
                      ask(r.id, "code", {
                        text: `"${code}" kodu müşteriye e-postayla gider; müşteri paketi bu kodla kargo şubesine verir.`,
                        confirmLabel: "Kodu gönder",
                        onConfirm: () => codeMut.mutate({ returnId: r.id, code }),
                      })
                    }}
                  >
                    Kodu müşteriye gönder
                  </Button>
                </div>
              ) : null}
              {confirmAt(r.id, "code")}
              {r.status === "requested" && !rejected ? (
                <div className="flex flex-col gap-2 border-t border-ui-border-base pt-3">
                  <Text size="small" className="text-ui-fg-subtle">
                    {codeWasSent(r)
                      ? "Paket bekleniyor. Depoya ulaşınca teslim alın."
                      : "Müşteri paketi kodsuz gönderdiyse, paket ulaşınca buradan teslim alın."}
                  </Text>
                  <PackageArrivedButton
                    ret={r}
                    open={Boolean(acceptOpenById[r.id])}
                    onToggle={() => {
                      setAcceptOpenById((prev) => ({ ...prev, [r.id]: !prev[r.id] }))
                      setPending(null)
                    }}
                  />
                </div>
              ) : null}
              {r.status === "requested" && !rejected && acceptOpenById[r.id]
                ? (() => {
                    const rows = acceptRows(r)
                    const entries = (r.items || []).filter((it) => it.item_id)
                    const rejectedQty = entries.reduce((s, it) => {
                      const row = rows[it.item_id as string]
                      return s + Number(it.quantity || 0) - row.restock - row.damaged
                    }, 0)
                    const accepted = entries.reduce((s, it) => {
                      const row = rows[it.item_id as string]
                      return s + row.restock + row.damaged
                    }, 0)
                    const ship = Boolean(shipById[r.id]) && shippingTotal > 0
                    // Adetler değişirse açık onay geçersiz olur (tutar eski kalmasın).
                    const sig = JSON.stringify([rows, ship])
                    return (
                      <div className="flex flex-col gap-2">
                        <Text size="small">
                          Gelen adetleri yazın. Sağlam ürün stoğa döner, hasarlı ürün stoğa girmez; ikisinin de parası iade edilir. Yazmadığınız adet kabul edilmemiş sayılır.
                        </Text>
                        {entries.map((it) => {
                          const id = it.item_id as string
                          const row = rows[id]
                          const left = Number(it.quantity || 0) - row.restock - row.damaged
                          return (
                            <div key={id} className="flex flex-col gap-1 border-b border-ui-border-base pb-2 last:border-0">
                              <Text size="small" weight="plus">
                                {it.quantity} × {lineTitle.get(id) || "Ürün"}
                              </Text>
                              <div className="flex flex-wrap items-center gap-2">
                                <Label size="xsmall" htmlFor={`restock-${r.id}-${id}`}>Sağlam (stoğa döner)</Label>
                                <Input
                                  id={`restock-${r.id}-${id}`}
                                  size="small"
                                  type="number"
                                  min={0}
                                  max={Number(it.quantity || 0)}
                                  value={row.restock}
                                  onChange={(e) => setAccept(r, id, { restock: Number(e.target.value) })}
                                  className="w-[60px]"
                                />
                                <Label size="xsmall" htmlFor={`damaged-${r.id}-${id}`}>Hasarlı (stoğa girmez)</Label>
                                <Input
                                  id={`damaged-${r.id}-${id}`}
                                  size="small"
                                  type="number"
                                  min={0}
                                  max={Number(it.quantity || 0)}
                                  value={row.damaged}
                                  onChange={(e) => setAccept(r, id, { damaged: Number(e.target.value) })}
                                  className="w-[60px]"
                                />
                                {left > 0 ? (
                                  <Badge size="2xsmall" color="red">
                                    {left} kabul edilmedi
                                  </Badge>
                                ) : null}
                              </div>
                            </div>
                          )
                        })}
                        {rejectedQty > 0 ? (
                          <Input
                            size="small"
                            aria-label="Kabul edilmeme sebebi"
                            placeholder="Kabul edilmeme sebebi (müşteriye mailde görünür)"
                            value={partialReasonById[r.id] || ""}
                            onChange={(e) => setPartialReasonById((prev) => ({ ...prev, [r.id]: e.target.value }))}
                          />
                        ) : null}
                        {shippingTotal > 0 ? (
                          <div className="flex items-start gap-2">
                            <Checkbox
                              id={`ship-${r.id}`}
                              checked={Boolean(shipById[r.id])}
                              onCheckedChange={(v) => setShipById((prev) => ({ ...prev, [r.id]: v === true }))}
                            />
                            <Label htmlFor={`ship-${r.id}`} size="xsmall" className="text-ui-fg-subtle">
                              Kargo ücretini de iade et ({formatTL(shippingTotal)}). İşaretlemezseniz yalnız kusur bizdeyse eklenir.
                            </Label>
                          </div>
                        ) : null}
                        <div>
                          <Button
                            variant="primary"
                            size="small"
                            isLoading={
                              (previewMut.isPending && previewMut.variables?.returnId === r.id) ||
                              (receiveMut.isPending && receiveMut.variables?.ret.id === r.id)
                            }
                            disabled={receiveMut.isPending || previewMut.isPending || accepted === 0}
                            onClick={async () => {
                              // Kesin tutar sunucudan: gerçek iadeyle aynı hesap.
                              const preview = await previewMut.mutateAsync({ returnId: r.id, rows, refundShipping: ship }).catch(() => null)
                              if (!preview) return
                              const lines = entries.map((it) => {
                                const row = rows[it.item_id as string]
                                const left = Number(it.quantity || 0) - row.restock - row.damaged
                                return `${lineTitle.get(it.item_id as string) || "Ürün"}: ${[
                                  row.restock ? `${row.restock} adet stoğa döner` : null,
                                  row.damaged ? `${row.damaged} adet hasarlı (stoğa girmez)` : null,
                                  left ? `${left} adet kabul edilmedi (parası iade edilmez)` : null,
                                ]
                                  .filter(Boolean)
                                  .join(", ")}`
                              })
                              if (preview.shipping_included) lines.push(`Kargo ücreti dahil: ${formatTL(preview.shipping_amount)}`)
                              const run = () =>
                                receiveMut.mutate({ ret: r, rows, reason: partialReasonById[r.id] || "", refundShipping: ship })
                              ask(
                                r.id,
                                "receive",
                                preview.mode === "exchange"
                                  ? {
                                      text: "Değişim: para iadesi yapılmaz. Kabul edilen adet kadar yeni ürünün gönderisi kendiliğinden açılır.",
                                      lines,
                                      confirmLabel: "Teslim al",
                                      onConfirm: run,
                                    }
                                  : preview.mode === "manual"
                                    ? {
                                        amountLabel: "Elle iade edilecek tutar",
                                        amount: formatTL(preview.amount),
                                        text: "Bu siparişte otomatik kart iadesi yapılamıyor (ödeme PayTR kartıyla alınmamış ya da tutar doğrulanamadı). Teslim alınca tutarı kontrol edip müşteriye elle iade edin.",
                                        lines,
                                        confirmLabel: "Teslim al",
                                        onConfirm: run,
                                      }
                                    : {
                                        amountLabel: "Müşterinin kartına iade edilecek",
                                        amount: formatTL(preview.amount),
                                        text: "Onaylayınca tutar karta otomatik iade edilir. Geri alınamaz.",
                                        lines,
                                        confirmLabel: `Teslim al ve ${formatTL(preview.amount)} iade et`,
                                        onConfirm: run,
                                      },
                                sig
                              )
                            }}
                          >
                            {/* Parayı düğme değil onay kutusu söyler: tutar ve karta mı elle mi olduğu orada. */}
                            {rejectedQty > 0 ? "Yazılan adetleri teslim al" : "Teslim al"}
                          </Button>
                        </div>
                        {confirmAt(r.id, "receive", sig)}
                      </div>
                    )
                  })()
                : null}
              {r.status === "canceled" && r.metadata?.escay_cancel ? (
                <Text size="small" className="text-ui-fg-subtle">
                  Talep panelden iptal edildi
                  {r.metadata.escay_cancel.reason ? `: ${r.metadata.escay_cancel.reason}` : ""}
                </Text>
              ) : null}
              {rejected && r.metadata?.escay_rejection?.reason ? (
                <Text size="small" className="text-ui-fg-subtle">
                  Sebep: {r.metadata.escay_rejection.reason}
                </Text>
              ) : null}
              {r.metadata?.paytr_refund?.status === "failed" ? (
                r.metadata.paytr_refund.manual_required ? (
                  <Text size="small" className="text-ui-fg-error">
                    Ödeme PayTR ile alınmamış (havale).{" "}
                    {formatTL(r.metadata.paytr_refund.amount ?? 0)} tutarını
                    müşterinin IBAN&apos;ına havale edin, BizimHesap&apos;ta iade
                    faturasını elle kesin ve müşteriye bilgi verin.
                  </Text>
                ) : (
                  <>
                    <Text size="small" className="text-ui-fg-error">
                      {formatTL(r.metadata.paytr_refund.amount ?? 0)}{" "}
                      iade edilemedi: {r.metadata.paytr_refund.error || "bilinmiyor"}
                    </Text>
                    <Button
                      variant="secondary"
                      size="small"
                      isLoading={
                        retryMut.isPending &&
                        retryMut.variables?.returnId === r.id
                      }
                      onClick={() =>
                        ask(r.id, "retry", {
                          amountLabel: "Müşterinin kartına iade edilecek",
                          amount: formatTL(r.metadata?.paytr_refund?.amount ?? 0),
                          text: "Para iadesi yeniden denenir. Başarılı olursa tutar karta iade edilir; geri alınamaz.",
                          confirmLabel: "İadeyi tekrar dene",
                          onConfirm: () => retryMut.mutate({ returnId: r.id }),
                        })
                      }
                    >
                      Para iadesini tekrar dene
                    </Button>
                    {confirmAt(r.id, "retry")}
                  </>
                )
              ) : null}
              {canReject ? (
                <div className="border-t border-ui-border-base pt-3">
                  <Button
                    size="small"
                    variant="transparent"
                    onClick={() => setMoreById((prev) => ({ ...prev, [r.id]: !prev[r.id] }))}
                  >
                    {moreById[r.id] ? "Diğer işlemleri gizle" : "Diğer işlemler (reddet, talebi iptal et)"}
                  </Button>
                  {moreById[r.id] ? (
                    <div className="mt-3 flex flex-col gap-4">
                      <div className="flex flex-col gap-2">
                        <Text size="small" weight="plus">
                          İadeyi reddet
                        </Text>
                        <Text size="small" className="text-ui-fg-subtle">
                          Ürün iade şartlarına uymuyorsa. Para iadesi yapılmaz, müşteriye ret maili gider.
                        </Text>
                        <Input
                          aria-label="Red sebebi"
                          placeholder="Red sebebi (müşteriye mailde görünür)"
                          value={reasonById[r.id] || ""}
                          onChange={(e) =>
                            setReasonById((prev) => ({
                              ...prev,
                              [r.id]: e.target.value,
                            }))
                          }
                        />
                        <div>
                          <Button
                            variant="secondary"
                            size="small"
                            className="text-ui-fg-error"
                            isLoading={rejectMut.isPending && rejectMut.variables?.returnId === r.id}
                            disabled={rejectMut.isPending}
                            onClick={() =>
                              ask(r.id, "reject", {
                                text: "İade reddedilir: para iadesi yapılmaz ve müşteriye ret maili gider. Geri alınamaz.",
                                lines: reasonById[r.id]?.trim() ? [`Müşteriye giden sebep: ${reasonById[r.id].trim()}`] : undefined,
                                confirmLabel: "İadeyi reddet",
                                danger: true,
                                onConfirm: () => rejectMut.mutate({ returnId: r.id, reason: reasonById[r.id] || "" }),
                              })
                            }
                          >
                            İadeyi reddet
                          </Button>
                        </div>
                        {confirmAt(r.id, "reject")}
                      </div>
                      {r.status === "requested" && !rejected ? (
                        <div className="flex flex-col gap-2">
                          <Text size="small" weight="plus">
                            Talebi iptal et
                          </Text>
                          <Text size="small" className="text-ui-fg-subtle">
                            Müşteri vazgeçtiyse ya da talep yanlışlıkla açıldıysa. Para iadesi yapılmaz, müşteriye mail gitmez.
                          </Text>
                          <div>
                            <Button
                              size="small"
                              variant="secondary"
                              isLoading={cancelMut.isPending && cancelMut.variables?.returnId === r.id}
                              disabled={cancelMut.isPending}
                              onClick={() =>
                                ask(r.id, "cancel", {
                                  text: "İade talebi iptal edilir. Para iadesi yapılmaz, müşteriye mail gitmez; gönderilmiş iade kodu artık kullanılmamalı.",
                                  confirmLabel: "Talebi iptal et",
                                  danger: true,
                                  onConfirm: () => cancelMut.mutate({ returnId: r.id }),
                                })
                              }
                            >
                              Talebi iptal et
                            </Button>
                          </div>
                          {confirmAt(r.id, "cancel")}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </Container>
  )
}

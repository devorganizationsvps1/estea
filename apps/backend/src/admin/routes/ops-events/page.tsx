import { defineRouteConfig } from "@medusajs/admin-sdk"
import { BellAlert } from "@medusajs/icons"
import { Badge, Button, Container, Heading, Select, Table, Text } from "@medusajs/ui"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useRef } from "react"
import { Link } from "react-router-dom"
import { fetchOpsEvents, formatEventDate, groupEvents, OPS_KIND_LABEL, OPS_LEVEL_BADGE } from "../../lib/ops-events"
import { useNavBadges } from "../../components/nav-badges"
import { usePersistedState, useScrollRestore } from "../../lib/persisted-state"
const MAX_ORDER_LINKS = 6

const PAGE_SIZE = 200

const KIND_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "Tüm olaylar" },
  { value: "payment", label: "Ödeme" },
  { value: "order", label: "Sipariş iptali" },
  { value: "shipment", label: "Kargo" },
  { value: "return", label: "İade" },
  { value: "exchange", label: "Değişim" },
  { value: "invoice", label: "Fatura" },
  // Kurulum ve entegrasyon kayıtları (dosya deposu, kargo hesabı, stok eşitleme, mail):
  // personelin çözeceği iş değil, teknik sorumlu bakar. Varsayılan görünümde yoktur.
  { value: "system", label: "Sistem (teknik)" },
]

const LEVEL_FILTERS: { value: string; label: string }[] = [
  { value: "important", label: "Hata ve uyarı" },
  { value: "all", label: "Hepsi (bilgi dahil)" },
  { value: "error", label: "Hata" },
  { value: "warning", label: "Uyarı" },
  { value: "info", label: "Bilgi" },
]

/**
 * Olay kaydı — PayTR ödeme başarılı/başarısız, 30 dk iptali, kargo gönderisi
 * açıldı/açılamadı, kargoya verildi/teslim, kargo sorunları. Mail gönderilmez.
 */
const OpsEventsPage = () => {
  useNavBadges()
  const [kind, setKind] = usePersistedState("ops-events:kind", "all")
  const [level, setLevel] = usePersistedState("ops-events:level2", "important")
  const [page, setPage] = usePersistedState("ops-events:page", 0)

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["escay-ops-events", kind, level, page],
    queryFn: () =>
      fetchOpsEvents({
        kind: kind === "all" ? undefined : kind,
        level: level === "all" ? undefined : level,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
  })

  const events = data?.events || []
  // Teknik kayıtlar günlük görünümde yok; unutulmasın diye sayısı altta yazar.
  const system = useQuery({
    queryKey: ["escay-ops-events-system-count"],
    queryFn: () => fetchOpsEvents({ kind: "system", level: "important", limit: 1 }),
    enabled: kind !== "system",
  })
  const systemCount = kind === "system" ? 0 : system.data?.count || 0
  const rootRef = useRef<HTMLDivElement>(null)
  useScrollRestore("ops-events", rootRef, !isLoading)

  const count = data?.count || 0
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE))
  // Geri dönünce kayıtlı sayfa artık yoksa son sayfaya çek.
  useEffect(() => {
    if (data && page >= pages) setPage(pages - 1)
  }, [data, page, pages, setPage])

  return (
    <Container ref={rootRef} className="divide-y p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
        <div>
          <Heading level="h1">Olay kaydı</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            {kind === "system"
              ? "Kurulum ve entegrasyon kayıtları. Teknik sorumlu bakar; günlük işi etkilemez."
              : "Bakılması gereken hata ve uyarılar. Aynı olay tek satırda toplanır."}
          </Text>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={kind} onValueChange={(v) => { setKind(v); setPage(0) }}>
            <Select.Trigger className="w-44"><Select.Value /></Select.Trigger>
            <Select.Content>
              {KIND_FILTERS.map((f) => <Select.Item key={f.value} value={f.value}>{f.label}</Select.Item>)}
            </Select.Content>
          </Select>
          <Select value={level} onValueChange={(v) => { setLevel(v); setPage(0) }}>
            <Select.Trigger className="w-40"><Select.Value /></Select.Trigger>
            <Select.Content>
              {LEVEL_FILTERS.map((f) => <Select.Item key={f.value} value={f.value}>{f.label}</Select.Item>)}
            </Select.Content>
          </Select>
          <Button size="small" variant="secondary" isLoading={isFetching} onClick={() => refetch()}>
            Yenile
          </Button>
        </div>
      </div>

      {isLoading ? (
        <Text size="small" className="px-6 py-4 text-ui-fg-subtle">Yükleniyor…</Text>
      ) : events.length === 0 ? (
        <Text size="small" className="px-6 py-4 text-ui-fg-subtle">
          {level === "important" ? "Bakılacak hata ya da uyarı yok." : "Bu filtrelerle kayıtlı olay yok."}
        </Text>
      ) : (
        <div className="overflow-x-auto">
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Tarih</Table.HeaderCell>
              <Table.HeaderCell>Seviye</Table.HeaderCell>
              <Table.HeaderCell>Olay</Table.HeaderCell>
              <Table.HeaderCell>Sipariş</Table.HeaderCell>
              <Table.HeaderCell>Ayrıntı</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {groupEvents(events).map(({ first: e, title, count: n, orders }) => {
              const badge = OPS_LEVEL_BADGE[e.level] || OPS_LEVEL_BADGE.info
              return (
                <Table.Row key={e.id}>
                  <Table.Cell className="whitespace-nowrap">{formatEventDate(e.created_at)}</Table.Cell>
                  <Table.Cell><Badge size="2xsmall" color={badge.color}>{badge.label}</Badge></Table.Cell>
                  <Table.Cell className="whitespace-nowrap">
                    {OPS_KIND_LABEL[e.kind] || e.kind}
                    {n > 1 ? <Badge size="2xsmall" color="grey" className="ml-2">{n} kez</Badge> : null}
                  </Table.Cell>
                  <Table.Cell>
                    {orders.length ? (
                      <div className="flex flex-wrap gap-x-2">
                        {orders.slice(0, MAX_ORDER_LINKS).map((o) => (
                          <Link key={o.id} to={`/orders/${o.id}`} className="text-ui-fg-interactive">
                            {o.label}
                          </Link>
                        ))}
                        {orders.length > MAX_ORDER_LINKS ? (
                          <span className="text-ui-fg-subtle">+{orders.length - MAX_ORDER_LINKS} sipariş</span>
                        ) : null}
                      </div>
                    ) : "—"}
                  </Table.Cell>
                  <Table.Cell className="max-w-[520px]">
                    <div className="txt-compact-small-plus">{n > 1 ? title : e.title}</div>
                    {n > 1 && orders.length > 1 ? (
                      <div className="txt-compact-small text-ui-fg-subtle">
                        {orders.length} sipariş. Ayrıntı için siparişi açın; her siparişin kaydı Olaylar kutusunda.
                      </div>
                    ) : e.detail ? (
                      <div className="txt-compact-small text-ui-fg-subtle whitespace-pre-wrap">{e.detail}</div>
                    ) : null}
                  </Table.Cell>
                </Table.Row>
              )
            })}
          </Table.Body>
        </Table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 px-6 py-3">
        <Text size="small" className="text-ui-fg-subtle">
          {count} olay, sayfa {page + 1}/{pages}
        </Text>
        {systemCount > 0 ? (
          <Button size="small" variant="transparent" onClick={() => { setKind("system"); setPage(0) }}>
            Sistem kayıtlarında {systemCount} hata ve uyarı var
          </Button>
        ) : null}
        <div className="flex gap-2">
          <Button size="small" variant="transparent" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Önceki
          </Button>
          <Button size="small" variant="transparent" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
            Sonraki
          </Button>
        </div>
      </div>
    </Container>
  )
}

export const config = defineRouteConfig({
  label: "Olay kaydı",
  icon: BellAlert,
})

export default OpsEventsPage

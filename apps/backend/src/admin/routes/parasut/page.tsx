import { defineRouteConfig } from "@medusajs/admin-sdk"
import { DocumentText } from "@medusajs/icons"
import { Badge, Button, Container, Heading, Text } from "@medusajs/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useSearchParams } from "react-router-dom"
import { InlineConfirm, type ConfirmSpec } from "../../components/inline-confirm"
import { formatDateTime } from "../../lib/dates"

type ConnectionResponse = {
  config: {
    mode: "mock" | "live"
    env: "prod" | "staging"
    clientIdConfigured: boolean
    companyIdConfigured: boolean
    companyId: string | null
    redirectUri: string
    dryRun: boolean
  }
  authorization: {
    connected: boolean
    stale: boolean
    connectedAt: string | null
    lastRefreshedAt: string | null
    refreshExpiresAt: string | null
    lastError: string | null
    lastErrorAt: string | null
  } | null
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...init,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.message || `HTTP ${res.status}`)
  return body as T
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[12rem_1fr] sm:gap-4">
    <Text size="small" className="text-ui-fg-subtle">{label}</Text>
    <div className="min-w-0 break-words">{children}</div>
  </div>
)

const ParasutPage = () => {
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null)
  const result = params.get("baglanti")
  const resultMessage = params.get("mesaj")

  const { data, isLoading, error } = useQuery({
    queryKey: ["escay-parasut-connection"],
    queryFn: () => api<ConnectionResponse>("/admin/parasut/connection"),
  })

  const connect = useMutation({
    mutationFn: () => api<{ url: string }>("/admin/parasut/connect", { method: "POST" }),
    onSuccess: ({ url }) => {
      window.location.assign(url)
    },
  })

  const disconnect = useMutation({
    mutationFn: () => api("/admin/parasut/connection", { method: "DELETE" }),
    onSuccess: () => {
      setConfirm(null)
      void qc.invalidateQueries({ queryKey: ["escay-parasut-connection"] })
    },
  })

  const cfg = data?.config
  const auth = data?.authorization
  const live = cfg?.mode === "live"

  return (
    <Container className="flex flex-col gap-4 p-6">
      <div className="flex flex-col gap-1">
        <Heading level="h1">Paraşüt bağlantısı</Heading>
        <Text size="small" className="text-ui-fg-subtle">
          Fatura ve stok Paraşüt üzerinden. Bağlantıyı Paraşüt'te bu iş için açılmış
          entegrasyon kullanıcısıyla kurun; bir kez yapılır, sistem kendisi yeniler.
        </Text>
      </div>

      {result === "tamam" ? (
        <div className="rounded-md border border-ui-border-base bg-ui-bg-subtle p-3">
          <Text size="small">Bağlantı kuruldu.</Text>
        </div>
      ) : result === "hata" ? (
        <div className="rounded-md border border-ui-border-error p-3">
          <Text size="small" className="text-ui-fg-error">
            Bağlantı kurulamadı: {resultMessage || "bilinmeyen hata"}
          </Text>
        </div>
      ) : null}

      {isLoading ? <Text size="small">Yükleniyor…</Text> : null}
      {error ? (
        <Text size="small" className="text-ui-fg-error">
          {error instanceof Error ? error.message : String(error)}
        </Text>
      ) : null}

      {cfg ? (
        <div className="divide-y divide-ui-border-base">
          <Row label="Durum">
            {!live ? (
              <Badge size="2xsmall" color="orange">Deneme modu (kimlikler girilmemiş)</Badge>
            ) : auth?.connected ? (
              <Badge size="2xsmall" color="green">Bağlı</Badge>
            ) : auth?.stale ? (
              <Badge size="2xsmall" color="red">Yeniden bağlanın (istemci ya da ortam değişti)</Badge>
            ) : (
              <Badge size="2xsmall" color="red">Bağlı değil</Badge>
            )}
            {cfg.dryRun ? (
              <Badge size="2xsmall" color="orange" className="ml-2">Taslak modu: e-belge kesilmez</Badge>
            ) : null}
          </Row>
          <Row label="Ortam">
            <Text size="small">{cfg.env === "prod" ? "Canlı (id.parasut.com)" : "Staging (id-staging.parasut.com)"}</Text>
          </Row>
          <Row label="Firma no">
            <Text size="small" className="font-mono">{cfg.companyId || "—"}</Text>
          </Row>
          <Row label="Geri dönüş adresi">
            <Text size="small" className="font-mono">{cfg.redirectUri}</Text>
            <Text size="xsmall" className="text-ui-fg-subtle">
              Paraşüt başvurusunda kayıtlı adresle birebir aynı olmalı.
            </Text>
          </Row>
          {auth?.connectedAt ? (
            <Row label="Bağlandı">
              <Text size="small">{formatDateTime(auth.connectedAt)}</Text>
            </Row>
          ) : null}
          {auth?.lastRefreshedAt ? (
            <Row label="Son yenileme">
              <Text size="small">{formatDateTime(auth.lastRefreshedAt)}</Text>
            </Row>
          ) : null}
          {auth?.refreshExpiresAt ? (
            <Row label="Kullanılmazsa düşer">
              <Text size="small">{formatDateTime(auth.refreshExpiresAt)}</Text>
            </Row>
          ) : null}
          {auth?.lastError ? (
            <Row label="Son hata">
              <Text size="small" className="text-ui-fg-error">{auth.lastError}</Text>
              {auth.lastErrorAt ? (
                <Text size="xsmall" className="text-ui-fg-subtle">{formatDateTime(auth.lastErrorAt)}</Text>
              ) : null}
            </Row>
          ) : null}
        </div>
      ) : null}

      {live ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Button
              size="small"
              isLoading={connect.isPending}
              onClick={() => {
                setParams({}, { replace: true })
                connect.mutate()
              }}
            >
              {auth?.connected ? "Yeniden bağlan" : "Paraşüt'e bağlan"}
            </Button>
            {auth?.connected ? (
              <Button
                size="small"
                variant="secondary"
                onClick={() =>
                  setConfirm({
                    text: "Bağlantı silinir. Faturalar ve stok eşitlemesi yeniden bağlanana kadar çalışmaz.",
                    confirmLabel: "Bağlantıyı kes",
                    danger: true,
                    onConfirm: () => disconnect.mutate(),
                  })
                }
              >
                Bağlantıyı kes
              </Button>
            ) : null}
          </div>
          {connect.error ? (
            <Text size="small" className="text-ui-fg-error">
              {connect.error instanceof Error ? connect.error.message : String(connect.error)}
            </Text>
          ) : null}
          <InlineConfirm spec={confirm} loading={disconnect.isPending} onClose={() => setConfirm(null)} />
        </div>
      ) : null}
    </Container>
  )
}

export const config = defineRouteConfig({ label: "Paraşüt", icon: DocumentText })

export default ParasutPage

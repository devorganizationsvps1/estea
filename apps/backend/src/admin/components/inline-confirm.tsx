import { Button, Text } from "@medusajs/ui"
import { useEffect, useId, useRef, type ReactNode } from "react"

/**
 * Panelin tek onay kalıbı: tarayıcı kutusu yerine düğmenin altında açılan kutu.
 * Ne olacağı yazar, para varsa kesin tutar büyük görünür, "Vazgeç" her zaman vardır.
 * Esc kapatır; açılınca odak güvenli tarafa (Vazgeç) gider, kapanınca kutuyu açan düğmeye
 * döner. Ekran okuyucu kutuyu açılırken duyar (alertdialog, metne bağlı).
 */
export type ConfirmSpec = {
  /** Ne olacağı, tek-iki cümle. */
  text: ReactNode
  /** Para hareketi varsa kesin tutar ("1.800,00 ₺") ve neyin tutarı olduğu. */
  amount?: string
  amountLabel?: string
  /** Ek satırlar: hangi ürün, stok ne olacak. */
  lines?: string[]
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
}

export function InlineConfirm({
  spec,
  loading,
  onClose,
  children,
}: {
  spec: ConfirmSpec | null
  loading?: boolean
  onClose: () => void
  children?: ReactNode
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const textId = useId()
  const open = Boolean(spec)
  useEffect(() => {
    if (!open) return
    // Kutuyu açan düğme: kapanınca odak ona döner (sayfanın başına düşmesin).
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelRef.current?.focus()
    return () => {
      const opener = openerRef.current
      // Onaylanan işlem düğmeyi kaldırmış olabilir; yalnız hâlâ sayfadaysa.
      if (opener?.isConnected) opener.focus()
    }
  }, [open])
  if (!spec) return null

  return (
    <div
      role="alertdialog"
      aria-label="Onay"
      aria-describedby={textId}
      className="flex flex-col gap-3 rounded-md border border-ui-border-strong p-3"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !loading) onClose()
      }}
    >
      {spec.amount ? (
        <div className="flex flex-col">
          <Text size="small" className="text-ui-fg-subtle">{spec.amountLabel || "Tutar"}</Text>
          <Text size="xlarge" weight="plus" className="tabular-nums">{spec.amount}</Text>
        </div>
      ) : null}
      <Text size="small" id={textId}>{spec.text}</Text>
      {spec.lines?.length ? (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {spec.lines.map((line) => (
            <li key={line} className="txt-compact-small">{line}</li>
          ))}
        </ul>
      ) : null}
      {children}
      <div className="flex flex-wrap gap-2">
        <Button
          size="small"
          variant={spec.danger ? "danger" : "primary"}
          isLoading={loading}
          onClick={() => {
            spec.onConfirm()
            onClose()
          }}
        >
          {spec.confirmLabel}
        </Button>
        <Button ref={cancelRef} size="small" variant="secondary" disabled={loading} onClick={onClose}>
          Vazgeç
        </Button>
      </div>
    </div>
  )
}

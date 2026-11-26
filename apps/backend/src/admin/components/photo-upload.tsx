import { Button, IconButton, Text, toast } from "@medusajs/ui"
import { XMark } from "@medusajs/icons"
import { useRef, useState } from "react"

export type Photo = { url: string }

/** Sunucudaki sınırla aynı (lib/return-rejection-plan MAX_REJECTION_PHOTOS). */
const MAX_PHOTOS = 8

async function upload(files: File[]): Promise<Photo[]> {
  const form = new FormData()
  for (const f of files) form.append("files", f)
  const res = await fetch("/admin/uploads", { method: "POST", credentials: "include", body: form })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json?.message || `HTTP ${res.status}`)
  return ((json?.files || []) as { url?: string }[]).filter((f) => f.url).map((f) => ({ url: String(f.url) }))
}

/**
 * İnceleme fotoğrafları: reddedilen / kabul edilmeyen ürünün kanıtı. Telefonda kamera açılır.
 * Fotoğraflar müşteriye mailde gider.
 */
export function PhotoUpload({
  id,
  photos,
  onChange,
  disabled,
}: {
  id: string
  photos: Photo[]
  onChange: (next: Photo[]) => void
  disabled?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const room = MAX_PHOTOS - photos.length

  const pick = async (list: FileList | null) => {
    const files = Array.from(list || []).filter((f) => f.type.startsWith("image/")).slice(0, room)
    if (!files.length) return
    setBusy(true)
    try {
      onChange([...photos, ...(await upload(files))])
    } catch (error) {
      toast.error(`Fotoğraf yüklenemedi: ${(error as Error).message}`)
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ""
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {photos.length ? (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {photos.map((p, i) => (
            <li key={p.url} className="relative">
              <a href={p.url} target="_blank" rel="noreferrer">
                <img
                  src={p.url}
                  alt={`İnceleme fotoğrafı ${i + 1}`}
                  className="h-20 w-20 rounded-md border border-ui-border-base object-cover"
                />
              </a>
              <IconButton
                size="small"
                variant="primary"
                className="absolute -right-2 -top-2"
                aria-label={`Fotoğraf ${i + 1} kaldır`}
                disabled={disabled}
                onClick={() => onChange(photos.filter((x) => x.url !== p.url))}
              >
                <XMark />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : null}
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => void pick(e.target.files)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="small"
          variant="secondary"
          isLoading={busy}
          disabled={disabled || room <= 0}
          onClick={() => inputRef.current?.click()}
        >
          {photos.length ? "Fotoğraf ekle" : "Fotoğraf yükle"}
        </Button>
        <Text size="small" className="text-ui-fg-subtle">
          {photos.length ? `${photos.length} fotoğraf` : "En az bir fotoğraf gerekli"}
        </Text>
      </div>
    </div>
  )
}

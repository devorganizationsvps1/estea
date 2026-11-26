/**
 * İade reddi ve reddedilen ürünün müşteriye geri gönderimi — saf kurallar (Medusa / DB yok).
 * Panel (admin) ve sunucu aynı dosyayı okur.
 *
 * Kararlar (2026-11-25): geri gönderim kargosu bizden, müşteri onayıyla imha seçeneği var,
 * teslim alınmayıp bize dönen paket 14 gün bekletilir.
 */

/** Paket gelmeden ret (kod iptal, "göndermeyin") / paket incelendikten sonra ret (geri gönderim). */
export type RejectionStage = "before_arrival" | "inspected"

export type RejectionReasonCode =
  | "period_expired"
  | "not_returnable"
  | "opened"
  | "damaged"
  | "not_ours"
  | "other"

export const REJECTION_REASONS: { code: RejectionReasonCode; label: string; stages: RejectionStage[] }[] = [
  { code: "opened", label: "Ambalajı açılmış ya da ürün kullanılmış", stages: ["inspected"] },
  { code: "damaged", label: "Ürün hasarlı ya da eksik geldi", stages: ["inspected"] },
  { code: "not_ours", label: "Gelen ürün bu siparişe ait değil", stages: ["inspected"] },
  { code: "period_expired", label: "İade süresi dolmuş", stages: ["before_arrival", "inspected"] },
  { code: "not_returnable", label: "Ürün iade kapsamında değil", stages: ["before_arrival"] },
  { code: "other", label: "Diğer", stages: ["before_arrival", "inspected"] },
]

export const MAX_REJECTION_PHOTOS = 8

export type RejectionPhoto = { url: string }

export type RejectionInput = {
  stage?: unknown
  reason_code?: unknown
  /** Serbest açıklama; müşteriye mailde görünür. "Diğer"de zorunlu. */
  note?: unknown
  photos?: unknown
}

export type PlannedRejection = {
  stage: RejectionStage
  reason_code: RejectionReasonCode
  note: string | null
  /** Müşteriye gösterilen tam sebep: liste etiketi (+ açıklama). */
  reason: string
  photos: RejectionPhoto[]
}

export function rejectionReasonLabel(code: unknown): string | null {
  return REJECTION_REASONS.find((r) => r.code === code)?.label ?? null
}

/** Yalnız http(s) adresleri; tekrarlar ve fazlası atılır. */
export function normalizePhotos(raw: unknown): RejectionPhoto[] {
  if (!Array.isArray(raw)) return []
  const urls: string[] = []
  for (const p of raw) {
    const url = typeof p === "string" ? p : typeof (p as { url?: unknown })?.url === "string" ? (p as { url: string }).url : ""
    const clean = url.trim()
    if (!/^https?:\/\/\S+$/i.test(clean) || clean.length > 1000) continue
    if (!urls.includes(clean)) urls.push(clean)
  }
  return urls.slice(0, MAX_REJECTION_PHOTOS).map((url) => ({ url }))
}

/**
 * Ret girdisini doğrular. Hata mesajları panelde gösterilir.
 * `alreadyReceived`: paket teslim alınmışsa aşama her zaman "inspected".
 */
export function planRejection(input: RejectionInput, opts: { alreadyReceived?: boolean } = {}): PlannedRejection {
  const stage: RejectionStage | null = opts.alreadyReceived
    ? "inspected"
    : input.stage === "before_arrival" || input.stage === "inspected"
      ? input.stage
      : null
  if (!stage) throw new Error("Paket elinize ulaştı mı? Önce bunu seçin.")

  const reason = REJECTION_REASONS.find((r) => r.code === input.reason_code)
  if (!reason || !reason.stages.includes(stage)) throw new Error("Ret sebebini listeden seçin.")

  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 500) : null
  if (reason.code === "other" && !note) throw new Error("\"Diğer\" sebebinde açıklama yazın; müşteri bu açıklamayı görür.")

  const photos = normalizePhotos(input.photos)
  if (stage === "inspected" && !photos.length) {
    throw new Error("İncelenen ürünün en az bir fotoğrafını ekleyin; itirazda kanıt olarak kullanılır.")
  }

  return {
    stage,
    reason_code: reason.code,
    note,
    reason: reason.code === "other" ? (note as string) : note ? `${reason.label}. ${note}` : reason.label,
    photos,
  }
}

/* ------------------------------------------------------------------ */
/* Geri gönderim                                                       */
/* ------------------------------------------------------------------ */

/** Teslim alınmayıp bize dönen paketin bekleme süresi (gün). */
export const SEND_BACK_HOLD_DAYS = 14

export const SEND_BACK_META_KEY = "escay_send_back"

export type SendBackStatus =
  /** Ürün bizde; geri gönderilecek ya da (müşteri onayıyla) imha edilecek */
  | "awaiting"
  /** Geri gönderim kargosu açıldı */
  | "shipped"
  | "delivered"
  /** Müşteri teslim almadı, paket bize döndü; `hold_until` tarihine kadar bekler */
  | "returned"
  /** Bekleme süresi doldu, kayıt kapandı */
  | "closed"
  | "disposed"

export type SendBackItem = { item_id: string; quantity: number }

export type SendBackMeta = {
  status: SendBackStatus
  /** Tam ret mi, kısmi kabulde kabul edilmeyen adetler mi */
  source: "rejection" | "partial_acceptance"
  items: SendBackItem[]
  created_at: string
  /** Normalize kargo verisi (fulfillment.data ile aynı anahtarlar) */
  shipment?: Record<string, unknown> | null
  /** Önceki (bize dönen) gönderilerin firma referansları — yeniden gönderimde tekrar kullanılmaz */
  previous_refs?: string[]
  shipped_at?: string | null
  shipped_by?: string | null
  delivered_at?: string | null
  returned_at?: string | null
  hold_until?: string | null
  closed_at?: string | null
  disposal?: { at: string; by: string | null; consent_note: string } | null
}

export function readSendBack(metadata: Record<string, unknown> | null | undefined): SendBackMeta | null {
  const raw = metadata?.[SEND_BACK_META_KEY]
  if (!raw || typeof raw !== "object") return null
  const sb = raw as SendBackMeta
  return typeof sb.status === "string" ? sb : null
}

/** Ret / kısmi kabul anında metadata'ya eklenecek ilk kayıt (çağıran kendi yazımına katar). */
export function newSendBack(source: SendBackMeta["source"], items: SendBackItem[], now: Date = new Date()): SendBackMeta {
  return { status: "awaiting", source, items, created_at: now.toISOString() }
}

/** Ürün fiziksel olarak bizde mi (gönderilebilir / imha edilebilir)? */
export function sendBackInHand(status: SendBackStatus): boolean {
  return status === "awaiting" || status === "returned" || status === "closed"
}

/** Personelin yapacağı iş var mı: ürün bizde, gönderilmeyi / müşterinin kararını bekliyor. */
export function sendBackNeedsAction(metadata: Record<string, unknown> | null | undefined): boolean {
  const status = readSendBack(metadata)?.status
  return status === "awaiting" || status === "returned"
}

export function sendBackHoldUntil(returnedAt: string | Date, days = SEND_BACK_HOLD_DAYS): string {
  return new Date(new Date(returnedAt).getTime() + days * 86_400_000).toISOString()
}

export function isSendBackHoldExpired(sb: SendBackMeta, now: Date = new Date()): boolean {
  if (sb.status !== "returned" || !sb.hold_until) return false
  const until = Date.parse(sb.hold_until)
  return Number.isFinite(until) && until <= now.getTime()
}

/**
 * Kargo firmasına giden geri gönderim referansı: sipariş + "-G" + iade kimliği kuyruğu.
 * İade başına sabit (aynı siparişin iki iadesi çakışmaz); firma büyük harf/alfasayısala indirger.
 */
export function sendBackReference(orderReference: string, returnId: string): string {
  const tail = returnId.replace(/^return_/i, "").replace(/[^a-z0-9]/gi, "").slice(-5).toUpperCase() || "X"
  return `${orderReference}-G${tail}`
}

/** Kısmi kabulde kabul edilmeyen adetler → geri gönderim kalemleri. */
export function sendBackItemsFromAcceptance(items: { item_id: string; rejected: number }[]): SendBackItem[] {
  return items.filter((i) => Number(i.rejected) > 0).map((i) => ({ item_id: i.item_id, quantity: Number(i.rejected) }))
}

export const SEND_BACK_STATUS_LABEL: Record<SendBackStatus, string> = {
  awaiting: "Ürün bizde, müşteriye geri gönderilecek",
  shipped: "Müşteriye geri gönderildi",
  delivered: "Müşteriye teslim edildi",
  returned: "Müşteri teslim almadı, paket bize döndü",
  closed: "Bekleme süresi doldu, kayıt kapandı",
  disposed: "Müşteri onayıyla imha edildi",
}

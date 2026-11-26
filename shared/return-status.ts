/**
 * Müşteriye gösterilen iade / değişim durumu — hesap sayfası ve sipariş
 * detayı aynı etiketi kullanır. Kaynak: Medusa return.status + backend'in
 * return.metadata'ya yazdığı bloklar (escay_rejection, escay_exchange,
 * escay_acceptance, escay_send_back, paytr_refund, return_code).
 */

export type ReturnStatusTone = "pending" | "progress" | "done" | "rejected" | "canceled"

export type ReturnStatusInput = {
  status?: string | null
  metadata?: Record<string, unknown> | null
}

export type ResolvedReturnStatus = {
  kind: "return" | "exchange"
  label: string
  tone: ReturnStatusTone
  /** Müşterinin bir sonraki adımı ya da durumun açıklaması */
  note: string | null
  /** Kartına iade edilen tutar (yalnız para iadesi tamamlandıysa) */
  refundAmount: number | null
  /** Admin'in müşteriye ilettiği kargo iade kodu */
  returnCode: string | null
}

type Block = Record<string, unknown>

function block(meta: Record<string, unknown> | null | undefined, key: string): Block | null {
  const value = meta?.[key]
  return value && typeof value === "object" ? (value as Block) : null
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function amount(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function isReturnRejected(meta: Record<string, unknown> | null | undefined): boolean {
  const rejection = block(meta, "escay_rejection")
  if (rejection) return rejection.rejected === true
  return meta?.rejected === true
}

/** Kabul sırasında reddedilen (para iadesi yapılmayan) adet var mı. */
function hasUnacceptedItems(meta: Record<string, unknown> | null | undefined): boolean {
  const items = block(meta, "escay_acceptance")?.items
  if (!Array.isArray(items)) return false
  return items.some((it) => Number((it as Block)?.rejected) > 0)
}

function dateTr(value: unknown): string | null {
  const t = typeof value === "string" ? Date.parse(value) : NaN
  if (!Number.isFinite(t)) return null
  return new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", timeZone: "Europe/Istanbul" }).format(new Date(t))
}

/**
 * İadesi kabul edilmeyen ürünün akıbeti (metadata.escay_send_back): ürün müşterinin malı,
 * ücretsiz geri gönderilir; onayıyla imha edilebilir; teslim alınmazsa bir süre bekletilir.
 */
export function sendBackNote(meta: Record<string, unknown> | null | undefined): string | null {
  const sb = block(meta, "escay_send_back")
  if (!sb) return null
  const shipment = (sb.shipment && typeof sb.shipment === "object" ? sb.shipment : {}) as Block
  const tracking = text(shipment.tracking_number)
  const carrier = text(shipment.carrier_name)
  switch (sb.status) {
    case "awaiting":
      return "Ürünü ücretsiz olarak adresine geri göndereceğiz. İstemiyorsan bize yaz, onayınla imha edelim."
    case "shipped":
      return tracking
        ? `Ürün adresine geri gönderildi. ${carrier ? `${carrier} takip no` : "Takip no"}: ${tracking}.`
        : "Ürün adresine geri gönderilmek üzere hazırlandı."
    case "delivered":
      return "Ürün sana geri teslim edildi."
    case "returned": {
      const until = dateTr(sb.hold_until)
      return `Geri gönderdiğimiz paket teslim alınmadı ve bize döndü. ${until ? `${until} tarihine kadar` : "Bir süre"} saklıyoruz; bize yazarsan yeniden gönderelim.`
    }
    case "closed":
      return "Teslim alınmayan paket için bekleme süresi doldu. Ürünün için bize yazabilirsin."
    case "disposed":
      return "Ürün onayınla imha edildi."
    default:
      return null
  }
}

function joinNotes(...parts: (string | null)[]): string | null {
  const out = parts.filter(Boolean).join(" ")
  return out || null
}

export function resolveReturnStatus(ret: ReturnStatusInput | null | undefined): ResolvedReturnStatus | null {
  if (!ret || (!ret.status && !ret.metadata)) return null
  const meta = ret.metadata || null
  const status = (ret.status || "").toLowerCase()
  const received = status === "received" || status === "partially_received"
  const returnCode = text(meta?.return_code)
  const awaitingParcel =
    returnCode != null
      ? `İade kodun: ${returnCode}. Paketi kargo şubesine götürüp bu kodu söyle.`
      : "İade kodun e-postayla gelecek. Kod gelmeden paketi kargoya verme."

  if (isReturnRejected(meta)) {
    const rejection = block(meta, "escay_rejection")
    const reason = text(rejection?.reason)
    const next =
      rejection?.stage === "before_arrival"
        ? "Lütfen paketi kargoya verme; iade kodun artık geçerli değil."
        : sendBackNote(meta)
    return {
      kind: "return",
      label: "İade kabul edilmedi",
      tone: "rejected",
      note:
        joinNotes(
          // Ardından cümle geliyorsa nokta ile ayrılır.
          reason ? `Açıklama: ${reason}${!next || /[.!?]$/.test(reason) ? "" : "."}` : null,
          next
        ) || "Sorunun varsa müşteri hizmetlerimize yazabilirsin.",
      refundAmount: null,
      // Reddedilen iadenin kodu geçersiz: müşteriye gösterilmez.
      returnCode: null,
    }
  }

  const exchange = block(meta, "escay_exchange")
  const exchangeStatus = text(exchange?.status)
  if (exchange && exchangeStatus && exchangeStatus !== "canceled") {
    const base = { kind: "exchange" as const, refundAmount: null, returnCode }
    if (status === "canceled") {
      return { ...base, label: "Değişim iptal edildi", tone: "canceled", note: null }
    }
    if (exchangeStatus === "shipment_created") {
      return {
        ...base,
        label: "Yeni ürün gönderiliyor",
        tone: "done",
        note: "Değişim ürününün gönderisi hazırlandı. Kargo takibini sipariş sayfasında görebilirsin.",
      }
    }
    if (received) {
      return {
        ...base,
        label: "Değişim: ürün bize ulaştı",
        tone: "progress",
        note: "Yeni ürünün hazırlanıyor, kargoya verince haber vereceğiz.",
      }
    }
    return { ...base, label: "Değişim talebi alındı", tone: "pending", note: awaitingParcel }
  }

  if (status === "canceled") {
    return {
      kind: "return",
      label: "İade iptal edildi",
      tone: "canceled",
      note: null,
      refundAmount: null,
      returnCode,
    }
  }

  const refund = block(meta, "paytr_refund")
  if (refund?.status === "success") {
    return {
      kind: "return",
      label: "Para iade edildi",
      tone: "done",
      note: hasUnacceptedItems(meta)
        ? joinNotes(
            "Bazı ürünler kabul edilmedi; kabul edilenlerin tutarı kartına iade edildi. Hesabına yansıması bankana göre birkaç gün sürebilir.",
            sendBackNote(meta)
          )
        : "Tutar kartına iade edildi. Hesabına yansıması bankana göre birkaç gün sürebilir.",
      refundAmount: amount(refund.amount),
      returnCode,
    }
  }

  if (received) {
    return {
      kind: "return",
      label: "Ürün bize ulaştı",
      tone: "progress",
      note: hasUnacceptedItems(meta)
        ? joinNotes("Bazı ürünler kabul edilmedi. Kabul edilenlerin para iadesi hazırlanıyor.", sendBackNote(meta))
        : "Para iaden hazırlanıyor, kartına geçince e-posta göndereceğiz.",
      refundAmount: null,
      returnCode,
    }
  }

  return {
    kind: "return",
    label: "İade talebi alındı",
    tone: "pending",
    note: awaitingParcel,
    refundAmount: null,
    returnCode,
  }
}

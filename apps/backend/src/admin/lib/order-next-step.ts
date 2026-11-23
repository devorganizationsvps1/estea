/**
 * Sipariş detayı: o an yapılacak tek iş. Kargo firması bağlıyken durum kendiliğinden
 * ilerler, personelin işi gönderiyi açmak ve etiketi basmaktır; firma yokken adımlar
 * elle işaretlenir. Diğer her şey "Diğer işlemler" açılımındadır.
 */
export type StatusAction = "prepare" | "ship" | "deliver"

export type NextStep =
  /** Ödendi ama firmada gönderi yok: gönderiyi aç. */
  | { kind: "open_shipment" }
  /** Gönderi açıldı, firma etiketi henüz gelmedi: bekle. */
  | { kind: "wait_label" }
  /** Firma etiketi hazır: yazdır (sipariş "Hazırlandı" olur). */
  | { kind: "print_label" }
  /** Etiket basıldı: kurye alınca durum kendiliğinden ilerler. */
  | { kind: "wait_courier" }
  /** Kargoda: teslim bilgisi firmadan gelir. */
  | { kind: "wait_delivery" }
  /** Firma bağlı değil: adımı elle işaretle. */
  | { kind: "advance"; action: StatusAction }

export type NextStepInput = {
  nextAction: StatusAction | null
  /** Firma adaptörü var, ödeme alınmış, gönderi kaydı yok. */
  needsShipment: boolean
  /** Etkin gönderi kargo firmasında açık (elle bağlanan dış gönderi değil). */
  carrierLinked: boolean
  /** Firma etiketi (PDF ya da ZPL) geldi. */
  hasLabel: boolean
}

export function resolveNextStep(input: NextStepInput): NextStep | null {
  const { nextAction, needsShipment, carrierLinked, hasLabel } = input
  if (!nextAction) return null
  if (needsShipment) return { kind: "open_shipment" }
  if (!carrierLinked) return { kind: "advance", action: nextAction }
  if (nextAction === "deliver") return { kind: "wait_delivery" }
  if (nextAction === "ship") return { kind: "wait_courier" }
  return hasLabel ? { kind: "print_label" } : { kind: "wait_label" }
}

/**
 * "Gönderi aç" uçları iş yapmadan da 200 döner ({ ok: true, skipped }): gönderi zaten
 * vardır, açılacak kalem kalmamıştır vb. Panel bunu "açıldı" diye göstermesin;
 * dönen sebep kullanıcının anlayacağı cümleye çevrilir. Yeni gönderi açıldıysa null.
 */
const SKIPPED_TEXT: Record<string, string> = {
  "carrier shipment already exists": "Bu siparişin kargo gönderisi zaten açık; yenisi açılmadı.",
  "fulfillment already exists": "Bu siparişin gönderi kaydı zaten var; yenisi açılmadı.",
  "nothing left to fulfill": "Gönderilecek ürün kalmamış; gönderi açılmadı.",
  "order canceled": "Sipariş iptal edilmiş; gönderi açılmadı.",
  "already shipped": "Yeni ürünün gönderisi zaten açılmış; yenisi açılmadı.",
  "no active exchange": "Bu iadede açık bir değişim yok; gönderi açılmadı.",
}

export function skippedShipmentMessage(result: unknown): string | null {
  const skipped = (result as { skipped?: unknown } | null)?.skipped
  if (typeof skipped !== "string" || !skipped) return null
  return SKIPPED_TEXT[skipped] || `Gönderi açılmadı: ${skipped}`
}

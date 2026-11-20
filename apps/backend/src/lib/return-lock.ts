/**
 * Bir iadenin metadata'sına yazan bütün süreçlerin ortak kilidi: teslim alma (kabul),
 * iade kodu yenileme ve iade talebi aboneliğinde kargo kodunun açılması. Ayrı anahtar
 * kullanılırsa eşzamanlı oku-değiştir-yaz birbirinin alanlarını ezer.
 */
export function returnLockKey(returnId: string): string {
  return `escay:return-accept:${returnId}`
}

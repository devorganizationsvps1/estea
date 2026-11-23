/**
 * Panelin tek tarih biçimi: "22.11.2026 14:05", her zaman İstanbul saatiyle
 * (tarayıcının dili ve saat dilimi sonucu değiştirmez).
 */
const DATE_TIME = new Intl.DateTimeFormat("tr-TR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Istanbul",
})

export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (value == null || value === "") return ""
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? "" : DATE_TIME.format(d)
}

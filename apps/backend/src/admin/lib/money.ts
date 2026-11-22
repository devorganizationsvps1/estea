/** Paneldeki bütün tutarlar tek biçimde: ₺1.849,90 */
const TL = new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" })

export function formatTL(value: number | string | null | undefined): string {
  if (value == null || value === "") return "—"
  const n = Number(value)
  return Number.isFinite(n) ? TL.format(n) : "—"
}

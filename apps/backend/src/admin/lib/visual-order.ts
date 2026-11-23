/**
 * Görünen sıraya göre (yukarıdan aşağı) bir sonraki / önceki öğe. Menü sırası CSS `order`
 * ile verildiğinde DOM sırası görünen sırayla uyuşmaz; klavye gezintisi bununla düzeltilir.
 * Uçta `null` döner (çağıran tarayıcının kendi sırasına bırakır).
 */
export function nextInVisualOrder<T>(items: { el: T; top: number }[], current: T, step: 1 | -1): T | null {
  // Aynı hizadakiler DOM sırasını korur (sort kararlıdır).
  const sorted = [...items].sort((a, b) => a.top - b.top)
  const i = sorted.findIndex((x) => x.el === current)
  if (i < 0) return null
  return sorted[i + step]?.el ?? null
}

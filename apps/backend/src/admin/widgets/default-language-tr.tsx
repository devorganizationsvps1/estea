import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { useEffect } from "react"
import { useTranslation } from "react-i18next"

/**
 * Admin paneli varsayılan olarak Türkçe açılır.
 *
 * Medusa dili tarayıcı başına cookie/localStorage `lng` ile tutar ve seçim
 * yoksa İngilizceye düşer (fallbackLng "en"; ilk açılışta "en" kaydedilir).
 * Bu widget her tarayıcıda yalnızca BİR KEZ Türkçeye geçirir; sonradan
 * Profil → Dil'den yapılan seçim korunur. Görünür bir şey çizmez.
 */
const APPLIED_KEY = "escay_admin_default_lng_applied"

/**
 * Sayı ve tutar biçimi tarayıcının diline bağlı kalmasın: Medusa biçimleyicileri yerel
 * ayar vermeden kurar (İngilizce tarayıcıda "1,949.90"). Yerel ayar verilmeyen her
 * biçimleme Türkçe yapılır ("1.949,90"); açıkça yerel ayar veren kod etkilenmez.
 * Widget modülleri panel açılışında statik yüklenir (bkz. escay-white-theme).
 */
const LOCALE = "tr-TR"
const unset = (l: unknown) => l === undefined || (Array.isArray(l) && l.length === 0)

if (typeof window !== "undefined" && !(Intl.NumberFormat as { escay?: boolean }).escay) {
  const Native = Intl.NumberFormat
  const Patched = function (locales?: string | string[], options?: Intl.NumberFormatOptions) {
    return new Native(unset(locales) ? LOCALE : locales, options)
  } as unknown as typeof Intl.NumberFormat & { escay?: boolean }
  Object.defineProperty(Patched, "prototype", { value: Native.prototype })
  Patched.supportedLocalesOf = Native.supportedLocalesOf.bind(Native)
  Patched.escay = true
  Intl.NumberFormat = Patched

  const nativeToLocale = Number.prototype.toLocaleString
  Number.prototype.toLocaleString = function (this: number, locales?: string | string[], options?: Intl.NumberFormatOptions) {
    return nativeToLocale.call(this, unset(locales) ? LOCALE : locales, options)
  } as typeof Number.prototype.toLocaleString
}

const DefaultLanguageTr = () => {
  const { i18n } = useTranslation()

  useEffect(() => {
    try {
      if (localStorage.getItem(APPLIED_KEY)) return
      localStorage.setItem(APPLIED_KEY, "tr")
    } catch {
      return
    }
    if (i18n.language !== "tr") {
      void i18n.changeLanguage("tr")
    }
  }, [i18n])

  return null
}

export const config = defineWidgetConfig({
  // Giriş ekranı + giriş sonrası ilk açılan listeler (oturumu açık kalanlar için)
  zone: [
    "login.before",
    "order.list.before",
    "product.list.before",
    "customer.list.before",
  ],
})

export default DefaultLanguageTr

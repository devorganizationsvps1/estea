import { Resolver } from "node:dns/promises"

/**
 * E-posta alan adı gerçekten var mı ve mail kabul edebilir mi? (yalnız sunucu)
 *
 * Misafir checkout'ta e-posta doğrulanmıyor; "gmail.con" gibi var olmayan bir
 * alan adına onay / fatura / kargo maili hiç ulaşmaz (#10, 2026-10-07).
 *
 * Yalnızca DNS'in kesin "yok" cevabında reddeder (NXDOMAIN veya ne MX ne A/AAAA
 * kaydı). Zaman aşımı / sunucu hatası gibi belirsiz durumlarda kabul eder:
 * doğru bir adres DNS sorunu yüzünden asla engellenmez.
 */

/**
 * DNS'te gerçekten var olan ama neredeyse kesin yazım hatası olan alan adları
 * (ör. gmial.com kayıtlı bir alan adı, DNS kontrolü yakalamaz). Yalnız birebir eşleşme;
 * öneri adresin doğru hâlini gösterir.
 */
const TYPO_DOMAINS: Record<string, string> = {
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gmal.com": "gmail.com",
  "gamil.com": "gmail.com",
  "gnail.com": "gmail.com",
  "gmail.co": "gmail.com",
  "gmail.con": "gmail.com",
  "gmail.cm": "gmail.com",
  "gmail.com.tr": "gmail.com",
  "hotmial.com": "hotmail.com",
  "hotmal.com": "hotmail.com",
  "hotmai.com": "hotmail.com",
  "hotmail.con": "hotmail.com",
  "hotmail.co": "hotmail.com",
  "hotmail.com.tr": "hotmail.com",
  "outlok.com": "outlook.com",
  "outlook.con": "outlook.com",
  "yaho.com": "yahoo.com",
  "yahoo.con": "yahoo.com",
  "icloud.con": "icloud.com",
  "iclod.com": "icloud.com",
}

/** Bilinen yazım hatasında doğru adres önerisi, yoksa null. */
export function emailTypoSuggestion(email: string): string | null {
  const at = email.trim().lastIndexOf("@")
  if (at < 1) return null
  const local = email.trim().slice(0, at)
  const fixed = TYPO_DOMAINS[email.trim().slice(at + 1).toLowerCase()]
  return fixed ? `${local}@${fixed}` : null
}

const TTL_MS = 60 * 60 * 1000
const cache = new Map<string, { ok: boolean; at: number }>()

const DEFINITIVE_MISSING = new Set(["ENOTFOUND", "ENODATA"])

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : ""
}

/** Kayıt yoksa false, varsa true; belirsizse null. */
async function hasRecords(lookup: () => Promise<unknown[]>): Promise<boolean | null> {
  try {
    const records = await lookup()
    return records.length > 0
  } catch (error) {
    return DEFINITIVE_MISSING.has(errorCode(error)) ? false : null
  }
}

export async function emailDomainAcceptsMail(email: string): Promise<boolean> {
  const domain = email.trim().toLowerCase().split("@").pop() || ""
  if (!domain || !domain.includes(".")) return false
  // ".test" test için ayrılmış TLD (RFC 2606): staging e2e adresleri @escay.test.
  if (domain.endsWith(".test")) return true

  const cached = cache.get(domain)
  if (cached && Date.now() - cached.at < TTL_MS) return cached.ok

  const resolver = new Resolver({ timeout: 3000, tries: 2 })

  let verdict: boolean | null
  try {
    const mx = await resolver.resolveMx(domain)
    // RFC 7505 "null MX" (tek kayıt, exchange ".") → alan adı mail kabul etmiyor.
    if (mx.length === 1 && (mx[0].exchange === "" || mx[0].exchange === ".")) {
      verdict = false
    } else {
      verdict = mx.length > 0 ? true : null
    }
  } catch (error) {
    const code = errorCode(error)
    if (code === "ENOTFOUND") {
      verdict = false
    } else if (code === "ENODATA") {
      // MX yoksa mail A/AAAA kaydına gider (RFC 5321).
      const [a, aaaa] = await Promise.all([
        hasRecords(() => resolver.resolve4(domain)),
        hasRecords(() => resolver.resolve6(domain)),
      ])
      verdict = a || aaaa ? true : a === false && aaaa === false ? false : null
    } else {
      verdict = null
    }
  }

  // Belirsiz sonuç önbelleğe alınmaz ve kabul edilir.
  if (verdict === null) return true
  cache.set(domain, { ok: verdict, at: Date.now() })
  return verdict
}

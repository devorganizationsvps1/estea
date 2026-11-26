import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { PARASUT_MODULE } from "../../../../modules/parasut"
import type ParasutModuleService from "../../../../modules/parasut/service"

/** Sonuç admin'deki Paraşüt sayfasında gösterilir. */
const ADMIN_PAGE = "/app/parasut"

function back(res: MedusaResponse, params: Record<string, string>) {
  res.redirect(302, `${ADMIN_PAGE}?${new URLSearchParams(params).toString()}`)
}

/**
 * GET /parasut/oauth/callback?code=…&state=…  (Paraşüt başvurusundaki REDIRECT_URI)
 *
 * Oturum gerekmez: istek tek kullanımlık, 10 dk geçerli `state` ile doğrulanır (CSRF) ve
 * code yalnız backend'deki PKCE verifier + client_secret ile token'a çevrilebilir.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  res.setHeader("Cache-Control", "no-store")
  res.setHeader("Referrer-Policy", "no-referrer")
  const q = req.query as Record<string, string | undefined>
  if (q.error) {
    // Kullanıcı onay vermedi ya da Paraşüt hata döndü
    back(res, { baglanti: "hata", mesaj: String(q.error_description || q.error).slice(0, 300) })
    return
  }
  const code = String(q.code || "")
  const state = String(q.state || "")
  if (!code || !state) {
    back(res, { baglanti: "hata", mesaj: "Eksik yanıt (code/state yok)." })
    return
  }
  const parasut = req.scope.resolve(PARASUT_MODULE) as ParasutModuleService
  try {
    await parasut.completeAuthorization({ code, state, iss: q.iss ? String(q.iss) : null })
    back(res, { baglanti: "tamam" })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    req.scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .error(`[parasut] Bağlantı kurulamadı: ${message}`)
    back(res, { baglanti: "hata", mesaj: message.slice(0, 300) })
  }
}

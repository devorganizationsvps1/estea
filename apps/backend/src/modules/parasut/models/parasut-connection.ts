import { model } from "@medusajs/framework/utils"

/**
 * Paraşüt OAuth bağlantısı — tek satır (id = "default").
 *
 * Refresh token'ı sunucu ve worker paylaşır; yenileme satır kilidi altında yapılır
 * (Paraşüt her yenilemede yeni refresh token verebilir, eskisi geçersizleşir).
 * Bekleyen yetkilendirme (state + PKCE verifier) da burada, 10 dakika geçerli.
 */
const ParasutConnection = model.define("parasut_connection", {
  id: model.id().primaryKey(),
  /** Bağlantının ait olduğu istemci ve ortam; env değişirse bağlantı geçersiz sayılır. */
  client_id: model.text().nullable(),
  env: model.text().nullable(),
  refresh_token: model.text().nullable(),
  refresh_expires_at: model.dateTime().nullable(),
  access_token: model.text().nullable(),
  access_expires_at: model.dateTime().nullable(),
  scope: model.text().nullable(),
  connected_at: model.dateTime().nullable(),
  /** Bağlantıyı başlatan admin kullanıcı id */
  connected_by: model.text().nullable(),
  last_refreshed_at: model.dateTime().nullable(),
  /** Son yenileme hatası (invalid_grant → yeniden bağlanmak gerekir) */
  last_error: model.text().nullable(),
  last_error_at: model.dateTime().nullable(),
  pending_state: model.text().nullable(),
  pending_verifier: model.text().nullable(),
  pending_expires_at: model.dateTime().nullable(),
  pending_actor: model.text().nullable(),
})

export default ParasutConnection

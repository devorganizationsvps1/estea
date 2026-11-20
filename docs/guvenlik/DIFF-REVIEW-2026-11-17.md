# Fark güvenlik incelemesi: 2026-11-17

**Aralık:** `a8bafb7..4bcd188`. İncelenen commit'ler `9d27c48`, `e7ab854` ve `4bcd188`. `5546b86` (medya) kapsam dışı.
**Yöntem:** differential-review (FOCUSED), bağımsız saldırgan modellemesi ve kodla doğrulama
**Dosya:** 44 dosya, yaklaşık +918 / −78 satır, hepsi incelendi

## Özet

| Önem | Sayı |
|---|---|
| CRITICAL | 0 |
| HIGH | 0 |
| MEDIUM | 2 |
| LOW | 4 |
| INFO | 4 |

**Genel risk:** Düşük-orta. Commit'ler hedefledikleri açıkları kapatıyor ve bu kapanışlar için bir atlatma yolu bulunamadı.

**Öneri:** Koşullu onay. Deploy'dan önce M2 kontrol edilmeli. M1 için Traefik ayarına bakılmalı.

**Silinen kodun geçmişi:** Kaldırılan kodlar şunlar: `CART_RESERVED`, XFF tabanlı `clientKey`, `ssl: false` ve stub testi. Hepsi yeniden yapılanma ya da özellik commit'lerinden geliyor (`5c9f9e5`, `e0cd3a9`). Hiçbiri önceki bir güvenlik düzeltmesini geri almıyor.

**Etki alanı:**
- `_rate-limit.ts` 10 sınırlayıcıda kullanılıyor.
- Yeni guard ve hook 10 yerde kullanılıyor.
- `lib/medusa.ts` 42 dosyaya import ediliyor. SDK sarmalayıcısı yalnız istek sınırlı yollarda devreye giriyor.

## Bulgular

### [MEDIUM] M1: Storefront istemcinin gönderdiği IP başlığına güveniyor, Traefik ayarına bağlı
- **Yer:** `apps/frontend/src/lib/client-ip.ts:24-31`. Storefront önce `x-real-ip` başlığını, sonra `x-forwarded-for` başlığının en soldaki girdisini alıyor. Bu değer sırla birlikte backend'e gidiyor ve backend ona güveniyor (`apps/backend/src/api/store/_rate-limit.ts`).
- **Saldırı:**
  1. Traefik'te `forwardedHeaders.insecure` ya da `trustedIPs` tanımlı olsun. Önüne güvenilen bir CDN konmuş olabilir ya da storefront Traefik'i atlayarak erişilebilir olabilir.
  2. Saldırgan her istekte farklı bir `X-Real-Ip` değeri gönderir.
  3. Storefront bu sahte IP'yi geçerli sırla backend'e iletir.
  4. Sonuç: giriş, şifre sıfırlama ve sipariş sorgulamada sınırsız deneme.
- **Varsayılan ayarda:** Traefik varsayılan ayarda bu başlıkları silip kendi değerini yazar. O durumda saldırı geçmez.
- **Güven:** Doğrulanması gerekiyor. Dokploy'un Traefik statik ayarı depoda yok.
- **Düzeltme:** `x-forwarded-for` başlığının en sağdaki girdisini, yani Traefik'in eklediği girdiyi kullanmak. `x-real-ip` kullanılmamalı. Traefik'in `insecure` ayarıyla çalışmaması gerektiğini dokümana yazmak.

### [MEDIUM] M2: Sonraki deploy'da backend açılmayabilir (bilerek yapılan değişiklik)
- **Yer:** `apps/backend/medusa-config.ts` (`assertStrongSecrets`) ve `apps/backend/src/modules/paytr/env-guard.ts`
- **Senaryo:** `NODE_ENV=production` iken aşağıdakilerden biri geçerliyse `medusa db:migrate` ve `medusa start` hata verir. Entrypoint `set -e` ile çalıştığı için konteyner sürekli yeniden başlar.
  - `PAYTR_TEST_MODE=1` ve `PAYTR_OID_PREFIX` boş
  - JWT veya COOKIE sırrı 32 karakterden kısa
  - İki sır aynı
  - Sırlardan biri yer tutucu değerde
- **Güven:** Büyük olasılıkla gerçekleşir. Canlı ortamdaki değerler görülemedi.
- **Düzeltme:** Deploy'dan önce Dokploy'da canlı ve staging değişkenlerini kontrol etmek.

### [LOW] L1: `payment_method` hâlâ istemciden yazılabiliyor — **Kapatıldı (2026-11-19)**
- **Çözüm:** `stripReservedCartMetadata` yalnız `"card"`ı, havale açık ve banka bilgisi tamken de `"bank_transfer"`ı bırakır; başka her değer silinir.
- **Yer:** `_strip-reserved-metadata.ts:19-25`. Okunduğu yerler: `lib/bank-transfer.ts:60` (`isBankTransferOrder`), `lib/bizimhesap-invoice.ts:342`, `lib/order-contracts.ts:197` ve `lib/order-confirmation-email.ts:107`.
- **Senaryo:** Sepete `metadata.payment_method = "bank_transfer"` yazılıp PayTR ile ödeme yapılıyor. Sonuçta kartla ödenmiş sipariş havale gibi kayda geçiyor:
  - E-faturanın notunda "EFT/HAVALE" yazıyor.
  - Sözleşmede havale görünüyor.
  - Onay e-postasının içeriği havaleye göre değişiyor.
  - PayTR ödemeleri muhasebede eşleştirilirken uyuşmazlık çıkıyor.
- **Güven:** Kesin.
- **Düzeltme:** Havale kapalıyken bu anahtarı izinli listeden çıkarmak. Uzun vadede değeri sunucuda ödeme oturumunun `provider_id` alanından türetmek.

### [LOW] L2: IP iletimi başarısız olursa iz bırakmıyor
- **Yer:** `apps/frontend/src/lib/client-ip.ts` (`currentClientIpHeaders` tüm hataları yutuyor)
- **Senaryo:** Instrumentation'da kaydedilen fonksiyon istek bağlamını göremezse başlık gönderilmiyor. Bu durumda tüm müşteriler yeniden tek sayaca düşüyor ve logda hiçbir şey görünmüyor. Birim testi gerçek js-sdk'yı kullanıyor, ama Next 15.5'in server action bağlamında denenmedi.
- **Güven:** Doğrulanması gerekiyor.
- **Düzeltme:** Sır tanımlıyken IP alınamazsa bir kez uyarı yazmak. Staging'de iki farklı IP'den gelen girişlerin ayrı sayaçlara düştüğünü test etmek.

### [LOW] L3: Betik ve operasyon gerilemeleri
- **Havale testi:** `scripts/test-bank-transfer.ts:285` `pp_havale_havale` kullanıyor ama `allowScriptPaymentProviders()` çağırmıyor. Checkout hook'u artık bunu reddettiği için `test:bank-transfer` çalışmıyor. Havale kapalı olduğu için etkisi az. Kesin.
- **Staging smoke:** `suites/auth.ts`, `STOREFRONT_PROXY_SECRET` yoksa bütün istekleri tek IP'den gönderiyor ve sonraki adımlar 429 alabiliyor. Kesin.
- **Canlıda test kartı:** ~~yalnız log yazıyor, müşteri ekranı takılı kalıyor~~ **Kapatıldı (2026-11-19):** kayıt `expired` + `test_mode:` işaretiyle kapanır, `payment.failed` (error) olayı yazılır, durum ucu `not_paid` döner, sonuç sayfası "Ödeme alınamadı" der ve sepeti geri bağlar. Durum sorgusu yanıtındaki `test_mode=1` de sipariş açmaz.

### [LOW] L4: Satır metadata'sı hâlâ yasaklı liste ile korunuyor
- **Yer:** `_strip-reserved-metadata.ts:26`. `escay_exchange_return_id` ve `escay_exchange_for_item_id` silinmiyor (`lib/exchange.ts:445` bunları okuyor).
- **Etki:** Bunu kullanmak için henüz oluşmamış bir iadenin `ret_` ULID'ini tahmin etmek gerekiyor, bu pratikte mümkün değil.
- **Düzeltme:** Satır metadata'sında da `escay_*` anahtarlarını silmek.

### [INFO]
- **I1. `user_ip`:** Ödeme oturumundaki `user_ip` alanı istemciden geliyor ve PayTR'ın dolandırıcılık puanlamasına gidiyor. Bu commit'lerden önce de böyleydi. Sunucuda `clientIp(req)` ile doldurulabilir.
- **I2. Admin girişi:** `/auth/user/emailpass` (admin girişi) ve şifre sıfırlamada istek sınırı yok. Bu da önceden böyleydi.
- **I3. Değişim fiyat tavanı:** Ödenen fiyata değil, bugünkü liste fiyatına bakıyor. Bölgeye bağlı fiyatlar (`rules_count>0`) sayılmıyor; katalog yalnız bölge fiyatına geçerse değişim seçenekleri kaybolur. Bu güvenli tarafta kalan bir hata, açık değil. Yerel veritabanında `variants.prices.*` sorgusunun çalıştığı doğrulandı.
- **I4. Küçük davranış değişiklikleri:**
  - Sıfır tutarlı sepet tamamlanamıyor. PayTR 0 ₺'yi zaten reddettiği için kaybolan bir akış yok.
  - İki sekme açıksa ikinci ödeme cookie'yi değiştirir; ilk sekme yenilenince "oturum bulunamadı" mesajını gösterir.
  - `DATABASE_SSL=require` sertifikayı doğrular. Özel bir CA kullanılıyorsa `DATABASE_SSL_CA` gerekir.

## Atlatılamayanlar
- **Ödeme oturumu süzgeci:** Sıra, büyük-küçük harf ve sondaki eğik çizgi denendi. Hem `body` hem `validatedBody` süzülüyor. Medusa'nın `{...input.data, ...provider.data}` birleştirmesinden önce temizleniyor.
- **Başka yol:** Ödeme oturumu açan başka bir mağaza rotası yok.
- **Checkout hook'u:** Sepet tamamlayan her yol, PayTR callback'i ve adopt akışı dahil, bu hook'tan geçiyor. Betik istisnası HTTP isteğiyle ya da ortam değişkeniyle açılamıyor.
- **`_stub` ve `paytr_status`:** İstemciden gelen değerler etkisiz.
- **Sepet metadata'sı izinli listesi:** İki rota da kapsanıyor ve sunucu sepet metadata'sına yazmadığı için kayıp yok.
- **Backend `clientIp`:** Sır sabit sürede karşılaştırılıyor ve tarayıcı paketine girmiyor.
- **Kargo webhook'u:** Sır tanımsızsa kapalı. Dizi halinde gelen başlıklar güvenle işleniyor.
- **Test modu kontrolü:** Callback imzası önce doğrulandığı için `test_mode` alanı imzasız olsa da sorun değil.
- **iframe token cookie'si:** HTTP staging'de de çalışıyor. Yabancı token'la iframe açılmıyor.
- **Değişim tavanı:** Zincirleme değişimle pahalı boya çıkılamıyor.
- **Şifre değiştirme sınırı:** `actor_id` ile tutuluyor.
- **Landing başlıkları:** HSTS'de `includeSubDomains` yok, staging alt alan adları etkilenmiyor.
- **Docker build ve CI:** `medusa-config` kontrolü build ve CI'da erken çıkıyor.

## Test kapsamı
- **Backend:** 482 birim testi geçti. Yeni testler: ödeme oturumu süzgeci, metadata izinli listesi, `clientIp`, hesap başına sınır, webhook sırrı (iki senaryo), canlıda test kartı, env-guard ve değişim tavanı (5 test).
- **Storefront:** 352 birim testi geçti. `client-ip` testleri var. SDK sarmalayıcısı geçici bir testte gerçek js-sdk ile doğrulandı.
- **Kapsanmayanlar:**
  - Checkout hook'unun sağlayıcı kontrolünün birim testi yok.
  - Ödeme sayfasındaki cookie kontrolü yalnız e2e ile kapsanıyor ve e2e testleri çalıştırılmadı.
  - Next server action bağlamında IP iletimi denenmedi.

## Sınırlar
Dokploy ve Traefik ayarı ile canlı ortam değişkenleri görülemedi. Bu yüzden M1 ve M2 koşullu kaldı. E2E testleri ve staging'de uçtan uca deneme yapılmadı.

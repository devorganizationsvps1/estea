# Mareen hata listesi: Es Çay durumu

Kaynak: `~/eticaret-hatalar/kontrol-listesi.md` (Mareen'de yaşanan hatalar). Es Çay kodu 2026-11-19'da
madde madde tarandı, kodla kapatılabilenler 2026-11-20'de kapatıldı. Geliver yalnız Mareen'deydi;
Es Çay doğrudan DHL (K1), Geliver maddeleri DHL karşılığıyla değerlendirildi.

✅ kodda karşılanıyor · 🔧 canlıda / dış teyitle doğrulanacak · ⏳ açık (karar ya da iş bekliyor) · ➖ uygulanamaz

## Kapatılanlar (2026-11-20)

| Madde | Ne yapıldı | Nerede |
|---|---|---|
| Kısmi iadede tüm sipariş iade ediliyordu | Tutar yalnız iade edilen kalemlerden; sipariş geneli `pending_difference` kullanılmıyor. Ödenen birim fiyat değişmeyen kayıtlardan (birim fiyat − adet başı kupon, KDV hariçse + KDV) hesaplanır, Medusa'nın birim iade tutarıyla çapraz kontrol edilir; tutmazsa ya da okunamazsa otomatik iade yok, elle inceleme. Medusa'nın satır toplamları iade alınınca kalan adede düşer (satır tamamen iade edilince 0), bu yüzden asıl kaynak değildir. Sorguda `items.detail.*` çalışmaz, alanlar tek tek istenir | `lib/return-refund.ts`, testler `return-refund-amount.unit.spec.ts`, `integration-tests/http/returns.spec.ts` (3 adetten 1 iade, kuponlu) |
| İndirimli siparişte liste fiyatı iade ediliyordu | Aynı düzeltme | aynı |
| Değişimle gelen 0 ₺ ürünün iadesi | Değiştirildiği kalemin ödenen fiyatı (zincir izlenir) | `paidPricePerUnit` |
| Çift iade / eşzamanlı iki iade / kargonun iki kez iadesi | İade ve iptal iadesi sipariş başına Redis kilidi altında; iade kabulü de süreçler arası kilitli | `lib/order-money-lock.ts`, `order-cancel.ts`, `return-acceptance.ts` |
| Birden fazla iade yolu (Medusa'nın kendi uçları API'den açık) | Medusa'nın iade, iptal, değişim, claim ve order-edit yazma uçları sunucuda 403 | `api/admin/_native-block`, `access-control.spec.ts` |
| "İade kabul" ≠ "para gitti" | Müşteri maili "ödeme kuruluşuna iletildi" diyor; 3 saatte bir PayTR durum sorgusundan iadenin tamamlandığı okunur, 3 günde tamamlanmayan ya da PayTR'de görünmeyen iade için uyarı | `lib/paytr-refund-tracking.ts`, `jobs/track-paytr-refunds.ts` |
| Canlıda test kartı (L3) / `payment_method` (L1) | bkz. `docs/guvenlik/DIFF-REVIEW-2026-11-17.md` | |
| Desi adetle şişiyordu (2 adet 6, 3+ adet 9 desi) | Koli profili adetle büyümez; istifleme yalnız kalemde paket başı ölçü varsa ya da profilde `"stack": true` ise. Mevcut env değeri değişmeden düzelir | `modules/carrier/package-profile.ts` |
| Gönderi açma yarışı (admin "yeniden dene" + iş) | Sipariş başına kilit | `lib/auto-fulfill-order.ts` |
| Mock / dry-run fatura kalıcı "kesildi" sayılıyordu | Gerçek bağlantı açılınca bu siparişlere gerçek fatura gider | `lib/bizimhesap-invoice.ts` |
| Parası tamamen iade edilmiş (iptalsiz) sipariş faturalanıyordu | Faturalanmaz (`skipped`, `refunded`) | aynı |
| Fatura notundaki "ödeme tarihi" kesim günüydü | İlk tahsilatın günü (İstanbul) | `firstCaptureDate` |
| Hasarlı iade BizimHesap'tan satışa geri dönebilir | İade faturası mailinde hasarlı kalemler "stoğa sokmayın" diye yazılır | `bizimhesap-invoice-admin-notify.ts` |
| Kargo / teslim / iade kodu mailleri yeniden denenmiyordu | Sipariş onayı gibi kayıttan yeniden üretilip denenir | `lib/failed-emails.ts`, `failed-emails.spec.ts` |
| `gmial.com` gibi gerçek ama yanlış alan adları | Checkout'ta "bunu mu demek istediniz" | storefront `lib/email-domain.ts` |
| `STOREFRONT_URL` boşken mail linkleri localhost'a gidiyordu | Canlıda boş / yerel adresle backend açılmaz | `medusa-config.ts` |
| Satır metadata'sında `escay_*` istemciden yazılabiliyordu (L4) | Silinir | `_strip-reserved-metadata.ts` |
| Next kritik açığı (GHSA-2464-fhr4-w9xw) | next 15.5.29, postcss override; storefront audit 0 | `apps/frontend/package.json` |
| Backend kritik açık (`proxy-addr`), `multer`, `axios`, nodemailer | `npm audit fix` + nodemailer 10; kritik 0, yüksek 32 → 21 | `apps/backend/package-lock.json` |
| Analitiğe kişisel veri (Clarity, Pixel, Omnisend) | Kimlik taşıyan sayfalarda yüklenmez / durdurulur, GA adresleri maskeli | storefront `lib/tracking-privacy.ts`, `Analytics.tsx` |
| Türkçe hata sayfası yok | Mağaza ve landing'de `error`, `global-error`, `not-found` | |
| Landing build'i Google Fonts'a bağlı | Fontsource (self-host) | `packages/ui/fonts.ts` |
| Eski WordPress yazı adresleri | 7 yazı için `/<slug>` → `/blog/<slug>` 301; `elementor-3218` linki düzeltildi | `apps/landing/next.config.ts` |
| Medusa 2.18 açıkları (21 yüksek) | Medusa 2.22.4 (6 Kasım, 2.23.0 çok yeni), zod 4.6.6, backend imajı Node 22; audit: 0 kritik, 0 yüksek, 11 orta. Bağlantı tablosu değişikliği için tek seferlik `MEDUSA_LINKS=all` (DOKPLOY-ENV.md) | `apps/backend/package.json`, `Dockerfile.backend`, `docker/entrypoint.sh` |
| Kargo KDV oranı env'den | Siparişin kargo vergi satırından; yoksa env | `shippingVatRateOf` |
| Şahıs şirketi kurumsal fatura seçemiyordu | Kurumsal faturada 11 haneli TCKN de kabul (kontrol basamaklı), BizimHesap'a vergi no olarak gider | `shared/checkout-address.ts`, `bizimhesap/customer.ts` |
| İade kodu yenilenemiyordu; talepte firma hatası olursa kod hiç alınamıyordu | Admin "Kodu yenile" / "Kargo firmasından kod al": firmadaki iade kaydı iptal edilip aynı referansla yeniden açılır, kod müşteriye yeniden gider. DHL sandbox'ta doğrulandı (2026-11-20) | `lib/return-code-renew.ts`, `POST /admin/returns/:id/return-code/renew`, DHL `cancelReturn` |
| Storefront / landing HEALTHCHECK, landing revision ucu | Dockerfile HEALTHCHECK; landing `/api/build-info` | `Dockerfile.storefront`, `Dockerfile.landing` |

## Açık kalanlar

| Madde | Durum | Ne gerekiyor |
|---|---|---|
| PayTR ile günlük tam karşılaştırma | ⏳ | Uzlaştırma yalnız `paytr_checkout` kaydı olan ödemeleri görür. PayTR'nin işlem dökümü ucu canlıda denenmeli |
| İade kuruş yuvarlaması | ✅ (kabul) | 3 ayrı kısmi iadede en çok 0,01 TL eksik iade; fazla iade yok |
| Taksitte vade farkı | 🔧 | Vade farkı iade edilmez (karar); PayTR'nin iadeyi hangi tutar üzerinden kabul ettiği canlıda görülmeli |
| Sipariş numarasında boşluk / fatura numarası | 🔧 | BizimHesap teyidi (K14) |
| E-fatura mükellefi tespiti, faturada gönderim tarihi, boş TCKN | 🔧 | BizimHesap teyidi (K14): e-fatura / e-arşiv ayrımını BizimHesap mı yapıyor, gönderim tarihi alanı var mı |
| Gmail SMTP limiti, SPF/DKIM/DMARC | 🔧 | İşlemsel mail servisi + alan adı kayıtları (K12) |
| CookieYes ID boş | 🔧 | Banner çıkmadan hiçbir takip çalışmaz (K7) |
| S3 boş (yüklemeler container diskinde) | 🔧 | Bucket + `S3_*`; yedekler için ayrı kapalı bucket |
| Ürün görsel URL'leri import anındaki host'a bağlı olabilir | 🔧 | Canlı DB'de `product.thumbnail` / `image.url` kontrolü |
| GA4 "tarayıcı geçmişi değişimlerinde sayfa görüntüleme" | 🔧 | GA4 panelinde kapatılmalı (maskelenmemiş adres + çift sayım) |
| Uptime / hata takibi / yedek heartbeat | 🔧 | K10 |
| Storefront :3025 host portu açık mı, Dokploy paneli | 🔧 | Sunucuda kontrol (`Dockerfile.landing` varsayılanı IP:3025) |
| `GIT_COMMIT` her deploy'da | ⏳ | Dokploy build argümanı |
| Diğer eski WP sayfaları (Fabrikamız, Basında Biz, İletişim) ve kayıp 5 yazı | ⏳ | Eski adresler bilinmiyor |
| Tam tur testi (gerçek kart, 2 ürün × 2 adet, iade) | 🔧 | Canlıya geçişte |

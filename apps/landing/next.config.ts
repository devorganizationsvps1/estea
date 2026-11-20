import path from 'node:path'
import type { NextConfig } from 'next'
import { posts } from './src/data/posts'

// Telefondan yerel ağ IP'siyle (ör. http://192.168.1.20:3020) açınca Next 16 dev
// sunucusu JS/HMR isteklerini engeller; sayfa hydrate olmaz, menü açılmaz.
const lanDevOrigins = ['192.168.*.*', '10.*.*.*', '172.*.*.*', '*.local']

// Temel güvenlik başlıkları (storefront ile aynı taban). CSP bilerek yalnız
// frame-ancestors: başka sitenin landing'i çerçeveye alıp tıklatmasını (clickjacking)
// engeller; script izin listesi ayrıca test edilmeden konmaz.
// HSTS yalnız HTTPS'te etkilidir (Traefik TLS); HTTP/IP erişiminde tarayıcı yok sayar.
const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
]

const nextConfig: NextConfig = {
  allowedDevOrigins: lanDevOrigins,
  poweredByHeader: false,
  images: {
    // AVIF destekleyen tarayıcıya AVIF (WebP'den ~%20-30 küçük), diğerine WebP.
    formats: ['image/avif', 'image/webp'],
    // Next 16'da izin listesi zorunlu; 85 yalnız tam ekran hero fotoğrafı için.
    qualities: [75, 85],
    // Varsayılan 4 saat; dosyalar nadiren değişir, değişirse adı değişsin.
    minimumCacheTTL: 60 * 60 * 24 * 7,
  },
  transpilePackages: ['@estea/ui'],
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // Adı sabit public dosyaları (logo, desen): Next varsayılanı max-age=0, her
      // sayfa açılışında sunucuya sorulur. Bir saat taze, bir gün arka planda yenilenir.
      {
        source: '/:path*\\.:ext(jpg|jpeg|png|webp|avif|svg|mp4|webm|woff2)',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=3600, stale-while-revalidate=86400' }],
      },
      // Görsel hattı çıktısı (shared/media): adında içerik hash'i var, asla değişmez.
      {
        source: '/_m/:file*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ]
  },
  // Eski WordPress sitesinde yazılar kökteydi (esteacay.com/<slug>/); şimdi /blog/<slug>.
  // Sondaki eğik çizgiyi Next önce kendisi atar (308), ardından bu 301 çalışır.
  async redirects() {
    return posts.map((p) => ({ source: `/${p.slug}`, destination: `/blog/${p.slug}`, statusCode: 301 as const }))
  },
  // Dockerfile.landing: .next/standalone tek başına çalışır (node apps/landing/server.js).
  output: 'standalone',
  // Monorepo kökü: standalone çıktısı workspace paketlerini (@estea/ui) de izlesin.
  outputFileTracingRoot: path.join(__dirname, '../../'),
}

export default nextConfig

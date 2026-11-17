import path from 'node:path'
import type { NextConfig } from 'next'

// Telefondan yerel ağ IP'siyle (ör. http://192.168.1.20:3020) açınca Next 16 dev
// sunucusu JS/HMR isteklerini engeller; sayfa hydrate olmaz, menü açılmaz.
const lanDevOrigins = ['192.168.*.*', '10.*.*.*', '172.*.*.*', '*.local']

const nextConfig: NextConfig = {
  allowedDevOrigins: lanDevOrigins,
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
  // Dockerfile.landing: .next/standalone tek başına çalışır (node apps/landing/server.js).
  output: 'standalone',
  // Monorepo kökü: standalone çıktısı workspace paketlerini (@estea/ui) de izlesin.
  outputFileTracingRoot: path.join(__dirname, '../../'),
}

export default nextConfig

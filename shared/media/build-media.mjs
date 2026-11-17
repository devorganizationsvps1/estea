#!/usr/bin/env node
/**
 * Es Çay görsel hattı: build anı.
 *
 *   node shared/media/build-media.mjs <uygulama klasörü>
 *
 * public/ altındaki her fotoğrafı (jpg/png/webp/avif) genişlik basamaklarında
 * AVIF + WebP'ye çevirir → public/_m/<hash>-<w>.<avif|webp>; videoları
 * (mp4/webm) hash'li adla kopyalar → public/_m/<hash>.mp4. Manifest:
 * src/generated/media.json (repoya girer; deterministik, yalnız içerik
 * değişince değişir). public/_m repoya girmez.
 *
 * Sıkıştırılmış dosyalar MEDIA_CACHE_DIR'de (varsayılan
 * node_modules/.cache/escay-media) tutulur; aynı içerik bir daha
 * sıkıştırılmaz. Docker'da bu klasör BuildKit cache mount'udur.
 *
 * Kaynak dosyalara dokunmaz; eski yollar (e-posta, dış linkler) çalışmaya devam eder.
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'

const appDir = path.resolve(process.argv[2] ?? process.cwd())
const publicDir = path.join(appDir, 'public')
const outDir = path.join(publicDir, '_m')
const manifestPath = path.join(appDir, 'src/generated/media.json')
const cacheDir = path.resolve(process.env.MEDIA_CACHE_DIR || path.join(appDir, 'node_modules/.cache/escay-media'))

// sharp uygulamanın kendi node_modules'ünden (Next'in bağımlılığı): iki uygulama farklı sürümde.
const sharp = createRequire(path.join(appDir, 'package.json'))('sharp')

/** core.ts `widthsFor` ile aynı basamaklar. 160: 80 px küçük resim ×2 ekran. */
const LADDER = [160, 320, 480, 640, 960, 1280, 1600, 1920, 2560]
// effort 2: effort 4 ile aynı boyut (±%1), 7 kat hızlı (2560 px: 0,8 sn / 5,4 sn).
const AVIF = { quality: 52, effort: 2, chromaSubsampling: '4:2:0' }
const WEBP = { quality: 78, effort: 4, smartSubsample: true }
/** Ayarlar değişince tüm hash'ler değişsin (eski dosyalar önbellekte kalmasın). */
const RECIPE = JSON.stringify({ v: 1, LADDER, AVIF, WEBP })

const IMAGE = /\.(jpe?g|png|webp|avif)$/i
const VIDEO = /\.(mp4|webm)$/i
/** _m: kendi çıktımız. email: e-posta şablonları mutlak adresle çağırır. */
const SKIP_DIRS = new Set(['_m', 'email'])

function widthsFor(width) {
  const top = Math.min(width, LADDER[LADDER.length - 1])
  return [...LADDER.filter((w) => w < top), top]
}

async function walk(dir, rel = '') {
  const out = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const relPath = `${rel}/${entry.name}`
    if (entry.isDirectory()) {
      if (!rel && SKIP_DIRS.has(entry.name)) continue
      out.push(...(await walk(path.join(dir, entry.name), relPath)))
    } else if (IMAGE.test(entry.name) || VIDEO.test(entry.name)) {
      out.push(relPath)
    }
  }
  return out
}

const exists = (p) => fs.access(p).then(() => true, () => false)

function hex({ r, g, b }) {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`
}

async function pool(items, limit, fn) {
  let next = 0
  const run = async () => {
    while (next < items.length) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
}

async function main() {
  if (!(await exists(publicDir))) throw new Error(`public/ yok: ${publicDir}`)
  await fs.mkdir(outDir, { recursive: true })
  await fs.mkdir(cacheDir, { recursive: true })
  await fs.mkdir(path.dirname(manifestPath), { recursive: true })

  const started = Date.now()
  const files = (await walk(publicDir)).sort()
  const images = {}
  const others = {}
  const wanted = new Set()
  const jobs = []

  for (const rel of files) {
    const buf = await fs.readFile(path.join(publicDir, rel))
    const hash = createHash('sha256').update(RECIPE).update(buf).digest('hex').slice(0, 12)
    if (VIDEO.test(rel)) {
      const name = `${hash}${path.extname(rel).toLowerCase()}`
      others[rel] = `/_m/${name}`
      wanted.add(name)
      jobs.push({ name, copy: path.join(publicDir, rel) })
      continue
    }
    const meta = await sharp(buf).metadata()
    // EXIF yönü 5-8: fotoğraf 90° dönük saklanır, ekrandaki boyut ters.
    const turned = (meta.orientation ?? 1) >= 5
    const width = turned ? meta.height : meta.width
    const height = turned ? meta.width : meta.height
    const stats = await sharp(buf).stats()
    images[rel] = [hash, width, height, hex(stats.dominant), meta.hasAlpha && !stats.isOpaque ? 1 : 0]
    for (const w of widthsFor(width)) {
      for (const ext of ['avif', 'webp']) {
        const name = `${hash}-${w}.${ext}`
        wanted.add(name)
        jobs.push({ name, buf, w, ext })
      }
    }
  }

  let encoded = 0
  // Linux/glibc'de sharp her işi tek iş parçacığında çalıştırır (concurrency 1):
  // orada her çekirdeğe bir iş. macOS'ta libvips kendisi paralel; yarısı yeter.
  const cores = availableParallelism()
  const limit = sharp.concurrency() === 1 ? cores : Math.max(2, Math.floor(cores / 2))
  await pool(jobs, limit, async (job) => {
    const target = path.join(outDir, job.name)
    if (await exists(target)) return
    const cached = path.join(cacheDir, job.name)
    if (!(await exists(cached))) {
      if (job.copy) {
        await fs.copyFile(job.copy, cached)
      } else {
        const img = sharp(job.buf).rotate().resize({ width: job.w, withoutEnlargement: true })
        const data = await (job.ext === 'avif' ? img.avif(AVIF) : img.webp(WEBP)).toBuffer()
        // Yarım yazılmış dosya önbellekte kalmasın: önce geçici ad, sonra taşı.
        await fs.writeFile(`${cached}.tmp`, data)
        await fs.rename(`${cached}.tmp`, cached)
        encoded++
      }
    }
    await fs.copyFile(cached, target)
  })

  let removed = 0
  for (const name of await fs.readdir(outDir)) {
    if (!wanted.has(name)) {
      await fs.rm(path.join(outDir, name), { force: true })
      removed++
    }
  }

  // Girdi başına bir satır: görsel değişince git diff'i tek satır olur.
  const block = (obj) =>
    Object.entries(obj)
      .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      .join(',\n')
  const json =
    `{\n "v": 1,\n "base": "/_m",\n "widths": ${JSON.stringify(LADDER)},\n` +
    ` "images": {\n${block(images)}\n },\n "files": {\n${block(others)}\n }\n}\n`
  const previous = await fs.readFile(manifestPath, 'utf8').catch(() => '')
  if (previous !== json) await fs.writeFile(manifestPath, json)

  const secs = ((Date.now() - started) / 1000).toFixed(1)
  console.log(
    `[media] ${path.basename(appDir)}: ${Object.keys(images).length} görsel, ${Object.keys(others).length} video, ` +
      `${wanted.size} dosya (${encoded} yeni sıkıştırma, ${removed} eski silindi) ${secs} sn`,
  )
}

main().catch((err) => {
  console.error('[media] başarısız:', err)
  process.exit(1)
})

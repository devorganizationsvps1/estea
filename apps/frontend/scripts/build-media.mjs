// Görsel hattını çalıştırır (shared/media/build-media.mjs). shared/ yerelde
// repo kökünde, Docker'da (Dockerfile.storefront) uygulamanın içinde durur.
import { existsSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const app = path.resolve(import.meta.dirname, "..")
const script = ["shared/media/build-media.mjs", "../../shared/media/build-media.mjs"]
  .map((p) => path.join(app, p))
  .find((p) => existsSync(p))
if (!script) {
  console.error("[media] shared/media/build-media.mjs bulunamadı")
  process.exit(1)
}
process.argv[2] = app
await import(pathToFileURL(script).href)

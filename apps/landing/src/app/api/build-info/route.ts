export const dynamic = 'force-dynamic'

/** Deploy sonrası gerçekten yeni kodun çalıştığını görmek için (uptime / HEALTHCHECK). */
export function GET() {
  return Response.json({
    service: 'escay-landing',
    gitCommit: process.env.GIT_COMMIT ?? 'unknown',
    builtAt: process.env.BUILD_TIMESTAMP ?? 'unknown',
  })
}

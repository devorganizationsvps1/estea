export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return

  // sdk → backend isteklerinde müşterinin gerçek IP'si (istek sınırları için; lib/client-ip.ts)
  const { installClientIpHeadersProvider } = await import("./lib/server-client-ip")
  installClientIpHeadersProvider()
  if (process.env.NODE_ENV === "production" && !process.env.STOREFRONT_PROXY_SECRET) {
    console.warn(
      "[escay-storefront] STOREFRONT_PROXY_SECRET yok — backend istek sınırları tüm müşteriler için tek sayaç olur."
    )
  }

  const url = process.env.MEDUSA_BACKEND_URL
  const pub = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY
  const region = process.env.NEXT_PUBLIC_MEDUSA_REGION_ID

  console.log(
    `[escay-storefront] MEDUSA_BACKEND_URL=${url ?? "(missing)"} pk=${pub ? "set" : "missing"} region=${region ?? "missing"}`
  )

  if (process.env.NODE_ENV === "production" && !url && !process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL) {
    console.error(
      "[escay-storefront] No backend URL in env — API calls will fail. Set MEDUSA_BACKEND_URL in Dokploy Environment + Build-time Arguments."
    )
  }
}

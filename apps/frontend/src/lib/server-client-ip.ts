import { headers } from "next/headers"
import { clientIpHeadersFrom, registerClientIpHeadersProvider } from "./client-ip"

/** instrumentation.register() çağırır: sdk istekleri müşteri IP'sini buradan alır. */
export function installClientIpHeadersProvider(): void {
  registerClientIpHeadersProvider(async () => {
    const h = await headers()
    return clientIpHeadersFrom((name) => h.get(name))
  })
}

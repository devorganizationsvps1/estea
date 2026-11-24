import type { Logger } from "@medusajs/framework/types"

import { ShopsideClient } from "./client"
import {
  isConfigured,
  normalizeOptions,
  type ShopsideOptions,
  type ShopsideRawOptions,
} from "./options"

type InjectedDependencies = {
  logger: Logger
}

/** Shopside modül servisi. DB modeli yok; durum Shopside'da ve Medusa stoğunda tutulur. */
class ShopsideModuleService {
  protected readonly logger_: Logger
  protected readonly options_: ShopsideOptions
  private client_: ShopsideClient | null = null

  constructor(container: InjectedDependencies, options?: ShopsideRawOptions) {
    this.logger_ = container.logger
    this.options_ = normalizeOptions(options ?? {})
    if (!isConfigured(this.options_)) {
      this.logger_.info("[shopside] Kimlik yok — kapalı (SHOPSIDE_API_KEY / SHOPSIDE_API_SECRET)")
    } else {
      this.logger_.info(
        `[shopside] Hazır — stok yazma=${this.options_.stockApply ? "AÇIK" : "kapalı (yalnız rapor)"} sipariş okuma=${this.options_.ordersEnabled ? "açık" : "kapalı"}`
      )
    }
  }

  getOptions(): ShopsideOptions {
    return this.options_
  }

  isConfigured(): boolean {
    return isConfigured(this.options_)
  }

  getClient(): ShopsideClient {
    if (!this.client_) {
      this.client_ = new ShopsideClient({ ...this.options_, logger: this.logger_ })
    }
    return this.client_
  }

  /** Testler için: sahte taşıyıcılı istemci. */
  replaceClientForTests(client: ShopsideClient | null) {
    this.client_ = client
  }
}

export default ShopsideModuleService

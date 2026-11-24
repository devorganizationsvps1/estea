import { Module } from "@medusajs/framework/utils"
import ShopsideModuleService from "./service"

export const SHOPSIDE_MODULE = "shopside"

export { ShopsideClient, ShopsideError } from "./client"
export { isConfigured, normalizeOptions, SHOPSIDE_DEFAULT_BASE_URL } from "./options"
export type { ShopsideOptions, ShopsideRawOptions } from "./options"

export default Module(SHOPSIDE_MODULE, {
  service: ShopsideModuleService,
})

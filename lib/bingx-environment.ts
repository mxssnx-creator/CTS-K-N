export const BINGX_PROD_LIVE_ORIGIN = "https://open-api.bingx.com"
export const BINGX_PROD_LIVE_FALLBACK_ORIGIN = "https://open-api.bingx.pro"
export const BINGX_PROD_VST_ORIGIN = "https://open-api-vst.bingx.com"
export const BINGX_PROD_VST_FALLBACK_ORIGIN = "https://open-api-vst.bingx.pro"

export type BingXEnvironment = "prod-live" | "prod-vst"

export function normalizeBingXEnvironment(value: unknown): BingXEnvironment | null {
  const normalized = String(value ?? "").trim().toLowerCase()
  if (!normalized) return null
  if (["prod-live", "live", "mainnet", "production"].includes(normalized)) return "prod-live"
  if (["prod-vst", "vst", "demo", "testnet"].includes(normalized)) return "prod-vst"
  throw new Error(`Unsupported BINGX_ENVIRONMENT '${normalized}'; expected prod-live or prod-vst`)
}

export function configuredBingXEnvironment(): BingXEnvironment | null {
  return normalizeBingXEnvironment(process.env.BINGX_ENVIRONMENT)
}

export function bingXOriginForEnvironment(environment: BingXEnvironment): string {
  return environment === "prod-vst" ? BINGX_PROD_VST_ORIGIN : BINGX_PROD_LIVE_ORIGIN
}

/**
 * Resolve the one exact origin used by authenticated requests.
 *
 * Public quote reads may safely fail over between the two official hosts.
 * Account/order requests must not be replayed after an ambiguous transport
 * failure, so Prod-VST supports an explicit whole-process pin instead. The
 * canonical .com host remains the default; operators can deliberately select
 * the official .pro alternative when .com is unreachable.
 */
export function configuredBingXOriginForEnvironment(environment: BingXEnvironment): string {
  if (environment !== "prod-vst") return BINGX_PROD_LIVE_ORIGIN
  const raw = String(process.env.BINGX_VST_ORIGIN || "").trim()
  if (!raw) return BINGX_PROD_VST_ORIGIN
  let origin: string
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("origin must be an HTTPS origin without a path, query, or fragment")
    }
    origin = parsed.origin
  } catch {
    throw new Error(
      `Unsupported BINGX_VST_ORIGIN '${raw}'; expected ${BINGX_PROD_VST_ORIGIN} or ${BINGX_PROD_VST_FALLBACK_ORIGIN}`,
    )
  }
  if (origin !== BINGX_PROD_VST_ORIGIN && origin !== BINGX_PROD_VST_FALLBACK_ORIGIN) {
    throw new Error(
      `Unsupported BINGX_VST_ORIGIN '${raw}'; expected ${BINGX_PROD_VST_ORIGIN} or ${BINGX_PROD_VST_FALLBACK_ORIGIN}`,
    )
  }
  return origin
}

export function bingXEnvironmentForTestnetFlag(isTestnet: boolean): BingXEnvironment {
  return isTestnet ? "prod-vst" : "prod-live"
}

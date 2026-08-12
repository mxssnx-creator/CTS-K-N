export const BINGX_PROD_LIVE_ORIGIN = "https://open-api.bingx.com"
export const BINGX_PROD_LIVE_FALLBACK_ORIGIN = "https://open-api.bingx.pro"
export const BINGX_PROD_VST_ORIGIN = "https://open-api-vst.bingx.com"
// Prod-VST is deliberately single-origin. Keeping the fallback value pinned to
// the approved host prevents any demo account workflow from drifting to .pro.
export const BINGX_PROD_VST_FALLBACK_ORIGIN = BINGX_PROD_VST_ORIGIN

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

export function bingXEnvironmentForTestnetFlag(isTestnet: boolean): BingXEnvironment {
  return isTestnet ? "prod-vst" : "prod-live"
}

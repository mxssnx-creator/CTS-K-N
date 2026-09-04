export const X02_CONNECTION_ID = "bingx-x02"
export const PROD_VST_ORIGINS = new Set([
  "https://open-api-vst.bingx.com",
  "https://open-api-vst.bingx.pro",
])
export const X02_LIFECYCLE_CONFIRMATION =
  "I authorize X02 BingX Prod-VST virtual minimum-volume lifecycle orders"

export interface LifecycleAuthorization {
  connectionId?: unknown
  exchange?: unknown
  environment?: unknown
  origin?: unknown
  confirmation?: unknown
  maintenanceMarker?: unknown
  tradingServicesInactive?: unknown
}

const text = (value: unknown) => String(value ?? "").trim()

/** Fail-closed authorization used before credentials are read or a child process is started. */
export function assertExactX02LifecycleAuthorization(input: LifecycleAuthorization): void {
  if (text(input.connectionId).toLowerCase() !== X02_CONNECTION_ID) {
    throw new Error("Authenticated verification is restricted to connection bingx-x02")
  }
  if (text(input.exchange).toLowerCase() !== "bingx") {
    throw new Error("Authenticated verification is restricted to BingX; Bybit is forbidden")
  }
  if (text(input.environment).toLowerCase() !== "prod-vst") {
    throw new Error("Authenticated verification cannot target mainnet")
  }
  let origin = ""
  try { origin = new URL(text(input.origin)).origin } catch { /* rejected below */ }
  if (!PROD_VST_ORIGINS.has(origin) || origin !== text(input.origin).replace(/\/$/, "")) {
    throw new Error("Authenticated verification requires an exact BingX Prod-VST origin")
  }
  if (input.confirmation !== X02_LIFECYCLE_CONFIRMATION) {
    throw new Error("Authenticated verification requires the exact X02 authorization")
  }
  if (input.maintenanceMarker !== true || input.tradingServicesInactive !== true) {
    throw new Error("Authenticated verification requires maintenance and inactive trading services")
  }
}

export function assertAllowedVerifierRequest(url: string, authenticated: boolean): void {
  const parsed = new URL(url)
  const host = parsed.hostname.toLowerCase()
  if (host.includes("bybit")) throw new Error(`Unexpected Bybit request blocked: ${host}`)
  if (host.includes("bingx") && authenticated && !PROD_VST_ORIGINS.has(parsed.origin)) {
    throw new Error(`Unexpected BingX mainnet request blocked: ${parsed.origin}`)
  }
}



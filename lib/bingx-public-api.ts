import {
  BINGX_PROD_LIVE_FALLBACK_ORIGIN,
  BINGX_PROD_LIVE_ORIGIN,
  BINGX_PROD_VST_FALLBACK_ORIGIN,
  BINGX_PROD_VST_ORIGIN,
} from "@/lib/bingx-environment"

const DEFAULT_PRIMARY_ORIGIN = BINGX_PROD_LIVE_ORIGIN
const VERIFIED_PUBLIC_HOSTS = new Set([
  new URL(BINGX_PROD_LIVE_ORIGIN).hostname,
  new URL(BINGX_PROD_LIVE_FALLBACK_ORIGIN).hostname,
  new URL(BINGX_PROD_VST_ORIGIN).hostname,
  new URL(BINGX_PROD_VST_FALLBACK_ORIGIN).hostname,
])

let preferredOrigin = DEFAULT_PRIMARY_ORIGIN

function verifiedOrigins(configured: string[]): string[] {
  return [...new Set(configured.flatMap((value) => {
    try {
      const origin = new URL(value).origin
      return VERIFIED_PUBLIC_HOSTS.has(new URL(origin).hostname) ? [origin] : []
    } catch {
      return []
    }
  }))]
}

function configuredOrigins(): string[] {
  const configured = [process.env.BINGX_PUBLIC_ORIGIN || DEFAULT_PRIMARY_ORIGIN]
  if (process.env.BINGX_PUBLIC_FALLBACK_ORIGIN) configured.push(process.env.BINGX_PUBLIC_FALLBACK_ORIGIN)
  return verifiedOrigins(configured)
}

function publicUrl(pathname: string | URL, origin: string): URL {
  const input = pathname instanceof URL ? pathname : new URL(pathname, origin)
  const url = new URL(`${input.pathname}${input.search}`, origin)
  if (url.protocol !== "https:" || !VERIFIED_PUBLIC_HOSTS.has(url.hostname)) {
    throw new Error(`Refusing unverified BingX public host: ${url.origin}`)
  }
  if (!url.pathname.includes("/quote/") || url.pathname.includes("/trade/") || url.pathname.includes("/user/")) {
    throw new Error(`Refusing non-public BingX endpoint: ${url.pathname}`)
  }
  return url
}

/**
 * Fetch a public, read-only BingX quote endpoint with official host failover.
 *
 * This helper intentionally rejects account/trade paths and non-GET methods.
 * Write requests must keep their existing idempotency/ambiguity handling and
 * must never be replayed automatically on another host.
 */
export async function fetchBingXPublic(
  pathname: string | URL,
  init: RequestInit = {},
  options: { timeoutMs?: number; fetchImpl?: typeof fetch; origins?: string[] } = {},
): Promise<Response> {
  const method = String(init.method || "GET").toUpperCase()
  if (method !== "GET" && method !== "HEAD") {
    throw new Error(`Refusing non-read-only BingX public request: ${method}`)
  }

  // Account-scoped workflows (especially Prod-VST smoke/soak runs) may pin
  // one exact official origin. This prevents a process-global public-market
  // default from leaking a demo workflow onto the live quote host.
  const origins = options.origins ? verifiedOrigins(options.origins) : configuredOrigins()
  if (origins.length === 0) throw new Error("No verified BingX public origin is configured")
  const preferredIndex = origins.indexOf(preferredOrigin)
  const orderedOrigins = preferredIndex > 0
    ? [origins[preferredIndex], ...origins.filter((_, index) => index !== preferredIndex)]
    : origins
  const timeoutMs = Math.max(1_000, Math.min(60_000, Number(options.timeoutMs) || 5_000))
  const fetchImpl = options.fetchImpl || fetch
  const { signal: callerSignal, ...requestInit } = init
  let lastError: unknown = null
  let lastResponse: Response | null = null

  for (const origin of orderedOrigins) {
    const url = publicUrl(pathname, origin)
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal
    const headers = new Headers(requestInit.headers)
    if (!headers.has("Accept")) headers.set("Accept", "application/json")
    try {
      const response = await fetchImpl(url, {
        ...requestInit,
        method,
        headers,
        signal,
      })
      if (response.ok) {
        preferredOrigin = origin
        return response
      }
      lastResponse = response
    } catch (error) {
      lastError = error
    }
  }

  if (lastResponse) return lastResponse
  throw lastError instanceof Error
    ? lastError
    : new Error("Both BingX public API origins failed")
}

export function resetBingXPublicOriginForTests(): void {
  preferredOrigin = DEFAULT_PRIMARY_ORIGIN
}

const DEFAULT_PRIMARY_ORIGIN = "https://open-api.bingx.com"
const DEFAULT_FALLBACK_ORIGIN = "https://open-api.bingx.pro"

let preferredOrigin = DEFAULT_PRIMARY_ORIGIN

function configuredOrigins(): string[] {
  return [...new Set([
    process.env.BINGX_PUBLIC_ORIGIN || DEFAULT_PRIMARY_ORIGIN,
    process.env.BINGX_PUBLIC_FALLBACK_ORIGIN || DEFAULT_FALLBACK_ORIGIN,
  ].map((value) => new URL(value).origin))]
}

function publicUrl(pathname: string | URL, origin: string): URL {
  const input = pathname instanceof URL ? pathname : new URL(pathname, origin)
  const url = new URL(`${input.pathname}${input.search}`, origin)
  if (url.protocol !== "https:") throw new Error(`Refusing non-HTTPS BingX endpoint: ${url}`)
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
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const method = String(init.method || "GET").toUpperCase()
  if (method !== "GET" && method !== "HEAD") {
    throw new Error(`Refusing non-read-only BingX public request: ${method}`)
  }

  const origins = configuredOrigins()
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

import { NextResponse } from "next/server"
import { verifyAuth } from "@/lib/auth"
import { isKiloDeploymentRuntime } from "@/lib/deployment-runtime"
import { getRealTradeInfrastructureBlockReason } from "@/lib/real-trade-gates"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const fetchCache = "force-no-store"
export const maxDuration = 60

function isSameOriginBrowserRequest(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site")
  return Boolean(
    request.headers.get("x-cts-dashboard-pulse") === "1" &&
    (!fetchSite || fetchSite === "same-origin"),
  )
}

/**
 * Kilo's user-deployment service currently uploads a Worker without the cron
 * trigger declared in wrangler.jsonc. While an authenticated operator has the
 * dashboard open, this endpoint supplies one bounded, minute-deduplicated
 * continuity tick. An unauthenticated same-origin request may run only while
 * real exchange ordering is infrastructure-blocked, and never runs live
 * recovery. It is deliberately not a substitute for an always-on platform
 * scheduler: status APIs report its source explicitly.
 */
export async function POST(request: Request) {
  const auth = await verifyAuth(request)
  const authenticatedAdmin = auth.authenticated && auth.user?.role === "admin"
  const safePaperPulse =
    !authenticatedAdmin &&
    isSameOriginBrowserRequest(request) &&
    getRealTradeInfrastructureBlockReason().length > 0
  if (!authenticatedAdmin && !safePaperPulse) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }
  const requestHostname = (() => {
    try {
      return new URL(request.url).hostname.toLowerCase()
    } catch {
      return ""
    }
  })()
  if (!isKiloDeploymentRuntime() && !requestHostname.endsWith(".kiloapps.io")) {
    return NextResponse.json({ success: true, skipped: true, reason: "not-kilo-runtime" })
  }

  const pulseSource = authenticatedAdmin
    ? "authenticated-dashboard-fallback"
    : "same-origin-paper-dashboard-fallback"
  const internalRequest = (pathname: string) => new Request(`https://cts-v-yd.internal${pathname}`, {
    method: "GET",
    headers: {
      "x-cloudflare-cron": "1",
      "x-cron-source": pulseSource,
    },
  })
  const continuityRoute = await import("@/app/api/cron/server-continuity/route")
  const continuityResponse = await continuityRoute.GET(internalRequest("/api/cron/server-continuity"))
  const continuity = await continuityResponse.json().catch(() => null)

  let recoveryResponse: Response | null = null
  let recovery: unknown = {
    skipped: true,
    reason: "admin authentication required for live-position recovery",
  }
  if (authenticatedAdmin) {
    const recoveryRoute = await import("@/app/api/cron/sync-live-positions/route")
    recoveryResponse = await recoveryRoute.GET(internalRequest("/api/cron/sync-live-positions"))
    recovery = await recoveryResponse.json().catch(() => null)
  }
  const success = continuityResponse.ok && (recoveryResponse?.ok ?? true)

  return NextResponse.json({
    success,
    source: pulseSource,
    continuity,
    recovery,
  }, { status: success ? 200 : 502 })
}

export async function GET(request: Request) {
  return POST(request)
}

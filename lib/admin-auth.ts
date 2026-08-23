import { timingSafeEqual } from "node:crypto"
import type { User } from "@/lib/auth"

export type AdminAuthorizationResult =
  | { ok: true }
  | {
      ok: false
      status: 401 | 403 | 503
      error: "Unauthorized" | "Forbidden" | "Admin authentication is not configured"
    }

const UNCONFIGURED_ADMIN_SECRET = /^(?:replace[_-]?me|change[_-]?me|your[_-]?admin)/i

function hasConfiguredAdminSecret(secret: string | undefined): secret is string {
  const normalized = secret?.trim()
  return Boolean(normalized && normalized.length >= 16 && !UNCONFIGURED_ADMIN_SECRET.test(normalized))
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8")
  const rightBytes = Buffer.from(right, "utf8")
  if (leftBytes.length !== rightBytes.length) return false
  return timingSafeEqual(leftBytes, rightBytes)
}

/**
 * Fail-closed bearer authentication for server-only administrative endpoints.
 * Placeholder or short secrets are deliberately treated as unconfigured.
 */
export function authorizeAdminBearer(
  authorizationHeader: string | null,
  configuredSecret = process.env.ADMIN_SECRET,
): AdminAuthorizationResult {
  if (!hasConfiguredAdminSecret(configuredSecret)) {
    return {
      ok: false,
      status: 503,
      error: "Admin authentication is not configured",
    }
  }

  const prefix = "Bearer "
  const supplied = authorizationHeader?.startsWith(prefix)
    ? authorizationHeader.slice(prefix.length)
    : ""
  if (!supplied || !constantTimeEqual(supplied, configuredSecret.trim())) {
    return { ok: false, status: 401, error: "Unauthorized" }
  }

  return { ok: true }
}

type SessionVerifier = (request: Request) => Promise<{
  authenticated: boolean
  user: User | null
}>

const verifyConfiguredSession: SessionVerifier = async (request) => {
  // Keep the JOSE/browser-session dependency out of bearer-only route module
  // evaluation. This matters for scripts/tests and still loads the exact same
  // verifier on the first Admin UI request.
  const { verifyAuth } = await import("@/lib/auth")
  return verifyAuth(request)
}

function isSameOriginBrowserMutation(request: Request): boolean {
  const fetchSite = String(request.headers.get("sec-fetch-site") || "").toLowerCase()
  if (fetchSite && fetchSite !== "same-origin") return false
  const origin = request.headers.get("origin")
  if (!origin) return true
  try {
    const forwardedHost = request.headers.get("x-forwarded-host")
      || request.headers.get("host")
      || new URL(request.url).host
    return new URL(origin).host === forwardedHost
  } catch {
    return false
  }
}

/**
 * Authorize an administrative mutation from either a server-to-server bearer
 * or the product's authenticated same-origin admin session. This keeps the
 * bearer-only contract for automation while allowing the built-in Admin UI to
 * work without exposing ADMIN_SECRET to browser JavaScript.
 */
export async function authorizeAdminRequest(
  request: Request,
  configuredSecret = process.env.ADMIN_SECRET,
  verifySession: SessionVerifier = verifyConfiguredSession,
): Promise<AdminAuthorizationResult> {
  const header = request.headers.get("authorization")
  if (header) return authorizeAdminBearer(header, configuredSecret)
  if (!isSameOriginBrowserMutation(request)) {
    return { ok: false, status: 403, error: "Forbidden" }
  }
  const session = await verifySession(request).catch(() => ({ authenticated: false, user: null }))
  if (session.authenticated && String(session.user?.role || "").toLowerCase() === "admin") {
    return { ok: true }
  }
  return { ok: false, status: 401, error: "Unauthorized" }
}

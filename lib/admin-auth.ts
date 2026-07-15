import { timingSafeEqual } from "node:crypto"

export type AdminAuthorizationResult =
  | { ok: true }
  | {
      ok: false
      status: 401 | 503
      error: "Unauthorized" | "Admin authentication is not configured"
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

import { NextResponse } from "next/server"

export type CronAuthorization =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: string }

function configuredCronSecret(): string {
  const value = String(process.env.CRON_SECRET || "").trim()
  if (value.length < 16) return ""
  if (/^(replace|change|example|secret|changeme)/i.test(value)) return ""
  return value
}

function constantTimeEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length)
  let different = left.length ^ right.length
  for (let index = 0; index < maxLength; index++) {
    different |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return different === 0
}

/**
 * Authorize an external cron request. Calls made directly between server
 * modules omit the Request and are trusted. Development remains convenient
 * without a secret; production fails closed when no portable scheduler secret
 * is configured. The internal Cloudflare scheduled origin is also trusted.
 */
export function authorizeCronRequest(request?: Request): CronAuthorization {
  if (!request) return { ok: true }

  const secret = configuredCronSecret()
  const authorization = request.headers.get("authorization") || ""
  const supplied = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : ""
  if (secret && supplied && constantTimeEqual(supplied, secret)) return { ok: true }

  try {
    const url = new URL(request.url)
    if (
      url.hostname === "cts-v-yd.internal" &&
      request.headers.get("x-cloudflare-cron") === "1"
    ) {
      return { ok: true }
    }
  } catch {
    // Invalid URLs are handled as unauthorized below.
  }

  const production = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL_ENV)
  if (!production && !secret) return { ok: true }
  if (!secret) {
    return {
      ok: false,
      status: 503,
      error: "CRON_SECRET is not configured for production scheduling",
    }
  }
  return { ok: false, status: 401, error: "Unauthorized cron request" }
}

/** Build a request for direct, same-process cron handler composition. */
export function createInternalCronRequest(pathname: string): Request {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`
  return new Request(`https://cts-v-yd.internal${path}`, {
    method: "GET",
    headers: { "x-cloudflare-cron": "1", "x-cron-source": "same-process" },
  })
}

export function cronAuthorizationResponse(auth: Exclude<CronAuthorization, { ok: true }>) {
  return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })
}

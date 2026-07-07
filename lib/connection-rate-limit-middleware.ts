import { NextRequest, NextResponse } from "next/server"
import { generalLimiter } from "@/lib/connection-rate-limiter"

/**
 * Middleware for applying systemwide rate limits to connection endpoints
 * Can be used with middleware.ts to apply globally
 */
export async function applyConnectionRateLimit(
  request: NextRequest,
  connectionId?: string
): Promise<{ allowed: boolean; response?: NextResponse }> {
  try {
    const id = connectionId || request.nextUrl.pathname.split("/").pop() || "unknown"

    const limitResult = await generalLimiter.checkLimit(id)

    if (!limitResult.allowed) {
      const response = NextResponse.json(
        {
          error: "Rate limit exceeded",
          details: `Too many requests. Please wait ${limitResult.retryAfter} seconds before retrying.`,
          retryAfter: limitResult.retryAfter,
          resetTime: limitResult.resetTime,
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(limitResult.retryAfter),
            "X-RateLimit-Limit": "60",
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(Math.ceil(limitResult.resetTime / 1000)),
          },
        }
      )

      return { allowed: false, response }
    }

    return { allowed: true }
  } catch (error) {
    console.error("[v0] [RateLimitMiddleware] Error:", error)
    // On error, allow the request (fail open)
    return { allowed: true }
  }
}

/**
 * Add rate limit headers to response
 */
export function addRateLimitHeaders(
  response: NextResponse,
  limitResult: { remaining: number; resetTime: number }
): NextResponse {
  response.headers.set("X-RateLimit-Limit", "60")
  response.headers.set("X-RateLimit-Remaining", String(limitResult.remaining))
  response.headers.set("X-RateLimit-Reset", String(Math.ceil(limitResult.resetTime / 1000)))
  return response
}

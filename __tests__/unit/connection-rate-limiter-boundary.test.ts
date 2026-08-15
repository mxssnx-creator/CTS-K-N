import {
  isRateLimitWindowExpired,
  remainingRateLimitWindowTtlSeconds,
  shouldStartNewRateLimitWindow,
} from "@/lib/connection-rate-limiter"

describe("connection rate-limit window boundary", () => {
  test("opens the next window at the exact advertised reset time", () => {
    expect(isRateLimitWindowExpired(59_999, 0, 60_000)).toBe(false)
    expect(isRateLimitWindowExpired(60_000, 0, 60_000)).toBe(true)
    expect(isRateLimitWindowExpired(60_001, 0, 60_000)).toBe(true)
  })

  test("a missing or invalid window never inherits a stale count key", () => {
    expect(shouldStartNewRateLimitWindow(null, 10_000, 60_000)).toBe(true)
    expect(shouldStartNewRateLimitWindow("invalid", 10_000, 60_000)).toBe(true)
    expect(shouldStartNewRateLimitWindow("1", 60_001, 60_000)).toBe(true)
    expect(shouldStartNewRateLimitWindow("1", 60_000, 60_000)).toBe(false)
  })

  test("counter increments retain only the current window's remaining TTL", () => {
    expect(remainingRateLimitWindowTtlSeconds(1_000, 0, 60_000)).toBe(59)
    expect(remainingRateLimitWindowTtlSeconds(59_999, 0, 60_000)).toBe(1)
    expect(remainingRateLimitWindowTtlSeconds(60_000, 0, 60_000)).toBe(1)
  })
})

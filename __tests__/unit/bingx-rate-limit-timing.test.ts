import { ErrorCode, ErrorHandler } from "@/lib/error-handling"

describe("BingX rate-limit timing", () => {
  test("classifies the 100410 endpoint disabled period as rate limited", () => {
    expect(ErrorHandler.classifyError(new Error(
      "code:100410:The endpoint trigger frequency limit rule is currently in the disabled period",
    ))).toBe(ErrorCode.RATE_LIMITED)
  })

  test("parses both BingX absolute unblock timestamp formats", () => {
    const now = Date.now()
    const rolling = ErrorHandler.parseBingXRetryAfter(
      `109429: can retry after time: ${now + 45_000}`,
    )
    const endpoint = ErrorHandler.parseBingXRetryAfter(
      `100410: disabled period and will be unblocked after ${now + 30_000}`,
    )

    expect(rolling).not.toBeNull()
    expect(endpoint).not.toBeNull()
    expect(rolling!).toBeGreaterThanOrEqual(44_000)
    expect(endpoint!).toBeGreaterThanOrEqual(29_000)
  })
})

import {
  evaluateRealTradeReadiness,
  getRealTradeBlockReason,
  hasUsableLiveCredentials,
} from "@/lib/real-trade-gates"

const credentialed = {
  api_key: "1234567890",
  api_secret: "abcdefghijklmnopqrstuvwxyz",
}

describe("Main Trade Engine live execution readiness", () => {
  const originalEnv = {
    REDIS_URL: process.env.REDIS_URL,
    KV_URL: process.env.KV_URL,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    ALLOW_INLINE_REDIS_LIVE_TRADING: process.env.ALLOW_INLINE_REDIS_LIVE_TRADING,
  }

  beforeEach(() => {
    delete process.env.REDIS_URL
    delete process.env.KV_URL
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
    delete process.env.KV_REST_API_URL
    delete process.env.KV_REST_API_TOKEN
    delete process.env.ALLOW_INLINE_REDIS_LIVE_TRADING
  })

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test("uses real exchange mode when Main Live is on, credentials are usable, and coordination is shared", () => {
    process.env.REDIS_URL = "redis://shared-test"
    const result = evaluateRealTradeReadiness({
      ...credentialed,
      is_live_trade: "1",
      live_trade_requested: "1",
    })

    expect(result).toMatchObject({
      requested: true,
      enabled: true,
      credentialsValid: true,
      durableCoordinationReady: true,
      canPlaceRealOrders: true,
      executionMode: "live",
      blockCode: null,
      blockReason: "",
    })
  })

  test("never silently selects simulation when Main Live was requested without shared coordination", () => {
    const result = evaluateRealTradeReadiness({
      ...credentialed,
      is_live_trade: "1",
      live_trade_requested: "1",
    })

    expect(result.canPlaceRealOrders).toBe(false)
    expect(result.executionMode).toBe("blocked")
    expect(result.blockCode).toBe("shared_redis_required")
    expect(result.blockReason).toContain("shared Redis is not configured")
    expect(getRealTradeBlockReason({})).toContain("shared Redis is not configured")
  })

  test("reports credential failures before attempting a venue order", () => {
    process.env.REDIS_URL = "redis://shared-test"
    const result = evaluateRealTradeReadiness({
      api_key: "••••••••••••",
      api_secret: "replace_me_secret",
      is_live_trade: "1",
      live_trade_requested: "1",
    })

    expect(result).toMatchObject({
      credentialsValid: false,
      canPlaceRealOrders: false,
      executionMode: "blocked",
      blockCode: "credentials_missing",
    })
    expect(hasUsableLiveCredentials(credentialed)).toBe(true)
  })

  test("keeps paper simulation only for an operator-disabled Main Live switch", () => {
    process.env.REDIS_URL = "redis://shared-test"
    const result = evaluateRealTradeReadiness({
      ...credentialed,
      is_live_trade: "0",
      live_trade_requested: "0",
    })

    expect(result).toMatchObject({
      requested: false,
      canPlaceRealOrders: false,
      executionMode: "simulation",
      blockCode: "disabled",
    })
  })

  test("an explicit canonical OFF switch overrides a stale legacy ON alias", () => {
    process.env.REDIS_URL = "redis://shared-test"
    const result = evaluateRealTradeReadiness({
      ...credentialed,
      is_live_trade: "0",
      live_trade_enabled: "1",
      live_trade_requested: "0",
    })

    expect(result).toMatchObject({
      requested: false,
      enabled: false,
      executionMode: "simulation",
      blockCode: "disabled",
    })
  })

  test("legacy live alias remains supported when the canonical switch is absent", () => {
    process.env.REDIS_URL = "redis://shared-test"
    const result = evaluateRealTradeReadiness({
      ...credentialed,
      live_trade_enabled: "1",
    })

    expect(result).toMatchObject({
      requested: true,
      enabled: true,
      executionMode: "live",
      blockCode: null,
    })
  })

  test("authorizes the independently enabled Preset engine without changing Main Live intent", () => {
    process.env.REDIS_URL = "redis://shared-test"
    const settings = {
      ...credentialed,
      is_live_trade: "0",
      live_trade_requested: "0",
      is_preset_trade: "1",
    }

    expect(evaluateRealTradeReadiness(settings)).toMatchObject({
      intent: "main",
      requested: false,
      executionMode: "simulation",
    })
    expect(evaluateRealTradeReadiness(settings, "preset")).toMatchObject({
      intent: "preset",
      requested: true,
      enabled: true,
      canPlaceRealOrders: true,
      executionMode: "live",
    })
  })

  test("preserves an explicit exchange validation block", () => {
    process.env.REDIS_URL = "redis://shared-test"
    const result = evaluateRealTradeReadiness({
      ...credentialed,
      is_live_trade: "1",
      live_trade_requested: "1",
      live_trade_blocked_reason: "Connection test failed: invalid signature",
    })

    expect(result).toMatchObject({
      canPlaceRealOrders: false,
      executionMode: "blocked",
      blockCode: "explicit_block",
      blockReason: "Connection test failed: invalid signature",
    })
  })
})

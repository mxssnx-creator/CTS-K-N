import {
  evaluateRealTradeReadiness,
  getRealTradeBlockReason,
  hasUsableLiveCredentials,
  hasUsableForexExecutionConfig,
  isBingXVirtualFundsDemo,
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
    FORCE_SIMULATED: process.env.FORCE_SIMULATED,
    FORCE_LIVE: process.env.FORCE_LIVE,
    ALLOW_LIVE_ORDER_PLACEMENT: process.env.ALLOW_LIVE_ORDER_PLACEMENT,
    LIVE_ORDER_CONNECTION_IDS: process.env.LIVE_ORDER_CONNECTION_IDS,
  }

  beforeEach(() => {
    delete process.env.REDIS_URL
    delete process.env.KV_URL
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
    delete process.env.KV_REST_API_URL
    delete process.env.KV_REST_API_TOKEN
    delete process.env.ALLOW_INLINE_REDIS_LIVE_TRADING
    delete process.env.FORCE_SIMULATED
    delete process.env.FORCE_LIVE
    delete process.env.ALLOW_LIVE_ORDER_PLACEMENT
    delete process.env.LIVE_ORDER_CONNECTION_IDS
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

  test("FORCE_SIMULATED overrides a persisted Live request without a rejected-order loop", () => {
    process.env.REDIS_URL = "redis://shared-test"
    process.env.FORCE_SIMULATED = "1"
    process.env.FORCE_LIVE = "0"
    const result = evaluateRealTradeReadiness({
      ...credentialed,
      is_live_trade: "1",
      live_trade_requested: "1",
    })

    expect(result).toMatchObject({
      requested: true,
      enabled: true,
      canPlaceRealOrders: false,
      executionMode: "simulation",
      blockCode: "forced_simulation",
    })
  })

  test("permits a caller-scoped FORCE_SIMULATED override only for BingX virtual funds", () => {
    process.env.REDIS_URL = "redis://shared-test"
    process.env.FORCE_SIMULATED = "1"
    process.env.FORCE_LIVE = "0"

    expect(evaluateRealTradeReadiness({
      ...credentialed,
      exchange: "bingx",
      is_testnet: "1",
      is_live_trade: "1",
      live_trade_requested: "1",
    }, "main", { allowForcedSimulationForAuthorizedVst: true })).toMatchObject({
      canPlaceRealOrders: true,
      executionMode: "live",
      blockCode: null,
    })
    expect(evaluateRealTradeReadiness({
      ...credentialed,
      exchange: "bingx",
      is_testnet: "0",
      is_live_trade: "1",
      live_trade_requested: "1",
    }, "main", { allowForcedSimulationForAuthorizedVst: true })).toMatchObject({
      canPlaceRealOrders: false,
      executionMode: "simulation",
      blockCode: "forced_simulation",
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

  test("blocks production live entries unless the server placement gate is enabled", () => {
    const previousNodeEnv = process.env.NODE_ENV
    try {
      Object.defineProperty(process.env, "NODE_ENV", {
        value: "production",
        configurable: true,
        enumerable: true,
        writable: true,
      })
      process.env.REDIS_URL = "redis://shared-test"
      delete process.env.ALLOW_LIVE_ORDER_PLACEMENT

      expect(evaluateRealTradeReadiness({
        ...credentialed,
        is_live_trade: "1",
        live_trade_requested: "1",
      })).toMatchObject({
        canPlaceRealOrders: false,
        executionMode: "blocked",
        blockCode: "placement_disabled",
      })

      process.env.ALLOW_LIVE_ORDER_PLACEMENT = "1"
      expect(evaluateRealTradeReadiness({
        ...credentialed,
        is_live_trade: "1",
        live_trade_requested: "1",
      })).toMatchObject({
        canPlaceRealOrders: true,
        executionMode: "live",
        blockCode: null,
      })
    } finally {
      Object.defineProperty(process.env, "NODE_ENV", {
        value: previousNodeEnv,
        configurable: true,
        enumerable: true,
        writable: true,
      })
    }
  })

  test("allows only the explicit BingX VST virtual-funds path without opening a mainnet bypass", () => {
    const previousNodeEnv = process.env.NODE_ENV
    try {
      Object.defineProperty(process.env, "NODE_ENV", {
        value: "production",
        configurable: true,
        enumerable: true,
        writable: true,
      })
      process.env.REDIS_URL = "redis://shared-test"
      delete process.env.ALLOW_LIVE_ORDER_PLACEMENT

      const vst = {
        ...credentialed,
        exchange: "bingx",
        is_testnet: "1",
        is_live_trade: "1",
        live_trade_requested: "1",
      }
      expect(isBingXVirtualFundsDemo(vst)).toBe(true)
      expect(evaluateRealTradeReadiness(vst)).toMatchObject({
        canPlaceRealOrders: true,
        executionMode: "live",
        blockCode: null,
      })

      expect(evaluateRealTradeReadiness({ ...vst, is_testnet: "0" })).toMatchObject({
        canPlaceRealOrders: false,
        executionMode: "blocked",
        blockCode: "placement_disabled",
      })
      expect(evaluateRealTradeReadiness({ ...vst, exchange: "bybit" })).toMatchObject({
        canPlaceRealOrders: false,
        executionMode: "blocked",
        blockCode: "placement_disabled",
      })
    } finally {
      Object.defineProperty(process.env, "NODE_ENV", {
        value: previousNodeEnv,
        configurable: true,
        enumerable: true,
        writable: true,
      })
    }
  })

  test("production connection allow-list keeps X01 read-only while authorizing X02 virtual funds", () => {
    const previousNodeEnv = process.env.NODE_ENV
    try {
      Object.defineProperty(process.env, "NODE_ENV", {
        value: "production",
        configurable: true,
        enumerable: true,
        writable: true,
      })
      process.env.REDIS_URL = "redis://shared-test"
      process.env.ALLOW_LIVE_ORDER_PLACEMENT = "1"
      process.env.LIVE_ORDER_CONNECTION_IDS = "bingx-x02"

      const base = {
        ...credentialed,
        exchange: "bingx",
        is_live_trade: "1",
        live_trade_requested: "1",
      }
      expect(evaluateRealTradeReadiness({ ...base, id: "bingx-x01", is_testnet: "0" })).toMatchObject({
        canPlaceRealOrders: false,
        executionMode: "blocked",
        blockCode: "connection_not_allowed",
      })
      expect(evaluateRealTradeReadiness({ ...base, id: "bingx-x02", is_testnet: "1" })).toMatchObject({
        canPlaceRealOrders: true,
        executionMode: "live",
        blockCode: null,
      })
      expect(evaluateRealTradeReadiness({ ...base, is_testnet: "1" })).toMatchObject({
        canPlaceRealOrders: false,
        blockCode: "connection_not_allowed",
      })
    } finally {
      Object.defineProperty(process.env, "NODE_ENV", {
        value: previousNodeEnv,
        configurable: true,
        enumerable: true,
        writable: true,
      })
    }
  })

  test("accepts a private Forex bridge when the legacy execution_mode alias is the selected mode", () => {
    const forex = {
      exchange: "instaforex",
      market_type: "forex",
      account_id: "12345678",
      account_password: "terminal-password-for-test-only",
      bridge_url: "http://127.0.0.1:8765",
      execution_mode: "mt5_bridge",
      connection_method: "bridge",
      read_only: false,
    }

    expect(hasUsableForexExecutionConfig(forex)).toBe(true)
  })
})

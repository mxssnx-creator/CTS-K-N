import { evaluateRealTradeReadiness, isMainnetReadOnlyConnection } from "@/lib/real-trade-gates"

describe("connection-scoped X01 mainnet authorization", () => {
  const keys = ["BINGX_X01_MAINNET_LIVE", "ALLOW_LIVE_ORDER_PLACEMENT", "LIVE_ORDER_CONNECTION_IDS", "REDIS_URL", "FORCE_SIMULATED", "FORCE_LIVE"]
  const env = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const settings = { id: "bingx-x01", exchange: "bingx", is_live_trade: "1", is_signal_trade: "1", is_preset_trade: "1",
    api_key: "1234567890123456", api_secret: "abcdefghijklmnopqrstuv" }
  beforeEach(() => {
    keys.forEach((key) => delete process.env[key])
    process.env.REDIS_URL = "redis://127.0.0.1:6399"
  })
  afterAll(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const authorize = () => {
    process.env.BINGX_X01_MAINNET_LIVE = "1"
    process.env.ALLOW_LIVE_ORDER_PLACEMENT = "1"
    process.env.LIVE_ORDER_CONNECTION_IDS = "bingx-x01"
  }
  test("old flags and a saved live toggle remain read-only without the new explicit opt-in", () => {
    process.env.FORCE_LIVE = "1"
    process.env.ALLOW_LIVE_ORDER_PLACEMENT = "1"
    process.env.LIVE_ORDER_CONNECTION_IDS = "bingx-x01"
    expect(isMainnetReadOnlyConnection(settings)).toBe(true)
  })
  test("authorizes only canonical X01 with every opt-in present", () => {
    authorize()
    for (const intent of ["main", "signal", "preset"] as const) {
      expect(evaluateRealTradeReadiness(settings, intent).canPlaceRealOrders).toBe(true)
    }
    for (const row of [{ ...settings, id: "bingx-other" }, { ...settings, id: undefined },
      { ...settings, read_only: "1" }, { ...settings, exchange: "bybit" }]) {
      expect(isMainnetReadOnlyConnection(row)).toBe(true)
    }
    process.env.LIVE_ORDER_CONNECTION_IDS = "bingx-x02"
    expect(isMainnetReadOnlyConnection(settings)).toBe(true)
  })
  test("preserves simulation, credentials and explicit runtime blocks after authorization", () => {
    authorize()
    expect(evaluateRealTradeReadiness({ ...settings, api_key: "", api_secret: "", id: "bingx-x01" }).credentialsValid).toBe(false)
    expect(evaluateRealTradeReadiness({ ...settings, live_trade_blocked_reason: "entry protection unresolved" }).blockCode).toBe("explicit_block")
    process.env.FORCE_SIMULATED = "1"
    expect(evaluateRealTradeReadiness(settings).executionMode).toBe("simulation")
  })
})

import fs from "node:fs"
import path from "node:path"
import {
  DIRECT_TRADE_LIVE_EXECUTION_READY,
  directTradeLiveExecutionReadiness,
} from "@/lib/direct-trade-live-readiness"

describe("Direct-Trade production live readiness", () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test("exposes the canonical capability but keeps runtime placement off without exact X02 opt-in", () => {
    delete process.env.DIRECT_TRADE_LIVE_ORDER_PLACEMENT
    delete process.env.DIRECT_TRADE_LIVE_CONNECTION_IDS
    expect(DIRECT_TRADE_LIVE_EXECUTION_READY).toBe(true)
    expect(directTradeLiveExecutionReadiness({
      id: "bingx-x02",
      exchange: "bingx",
      is_testnet: "1",
    }, "bingx-x02")).toMatchObject({
      ready: false,
      capabilityReady: true,
      blockCode: "placement_disabled",
      virtualFundsOnly: true,
    })
  })

  test("authorises only explicitly allowlisted BingX X02 virtual funds despite global paper mode", () => {
    process.env.DIRECT_TRADE_LIVE_ORDER_PLACEMENT = "1"
    process.env.DIRECT_TRADE_LIVE_CONNECTION_IDS = "bingx-x02"
    process.env.FORCE_SIMULATED = "1"
    process.env.FORCE_LIVE = "0"
    process.env.REDIS_URL = "redis://127.0.0.1:6379"
    const credentials = { api_key: "valid-api-key-123", api_secret: "valid-api-secret-123" }

    expect(directTradeLiveExecutionReadiness({
      ...credentials,
      id: "bingx-x02",
      exchange: "bingx",
      is_testnet: "1",
    }, "bingx-x02").ready).toBe(true)
    expect(directTradeLiveExecutionReadiness({
      ...credentials,
      id: "bingx-x01",
      exchange: "bingx",
      is_testnet: "0",
    }, "bingx-x01").ready).toBe(false)
  })

  test("guards the settings route, canonical gateway, processor, and operator switch", () => {
    const root = process.cwd()
    const sources = [
      "app/api/trade-engine/direct-trade/route.ts",
      "app/api/trade-engine/direct-trade/order/route.ts",
      "scripts/direct-trade-processor.mjs",
      "components/dashboard/direct-trade-section.tsx",
    ].map((file) => fs.readFileSync(path.join(root, file), "utf8"))
    expect(sources[0]).toContain("directTradeLiveExecutionReadiness")
    expect(sources[1]).toContain("executeDirectTradeCanonicalOrder")
    expect(sources[2]).toContain("DIRECT_TRADE_LIVE_EXECUTION_READY = true")
    const dashboard = sources.at(-1) || ""
    expect(dashboard).toContain("state.liveExecutionReady === false && !state.liveMode")
  })

  test("hydrates positions before syncing and keeps blocked legacy recovery bounded", () => {
    const processor = fs.readFileSync(
      path.join(process.cwd(), "scripts/direct-trade-processor.mjs"),
      "utf8",
    )
    const loadState = processor.slice(
      processor.indexOf("async function loadState"),
      processor.indexOf("// ─── Entry Signal Check"),
    )

    expect(loadState).toContain("if (Array.isArray(result?.positions)) positions =")
    expect(loadState).not.toMatch(/await refreshActiveSignals\(\)\s*return/)
    expect(processor).toContain('"quarantined_live_readiness"')
    expect(processor).toContain('startsWith("quarantined_")')
    expect(processor).toContain("lastLiveReadinessWarningAt >= 60_000")
    expect(processor).toContain("no durable exchange order acknowledgement exists")
  })
})

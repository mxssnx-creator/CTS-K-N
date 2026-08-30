import fs from "node:fs"
import path from "node:path"
import {
  DIRECT_TRADE_LIVE_EXECUTION_BLOCK_CODE,
  DIRECT_TRADE_LIVE_EXECUTION_READY,
  directTradeLiveExecutionReadiness,
} from "@/lib/direct-trade-live-readiness"

describe("Direct-Trade production live readiness", () => {
  test("fails closed until native exact protection and slot ownership are unified", () => {
    expect(DIRECT_TRADE_LIVE_EXECUTION_READY).toBe(false)
    expect(directTradeLiveExecutionReadiness()).toMatchObject({
      ready: false,
      blockCode: DIRECT_TRADE_LIVE_EXECUTION_BLOCK_CODE,
    })
  })

  test("guards the settings route, order gateway, processor, and operator switch", () => {
    const root = process.cwd()
    const sources = [
      "app/api/trade-engine/direct-trade/route.ts",
      "app/api/trade-engine/direct-trade/order/route.ts",
      "scripts/direct-trade-processor.mjs",
      "components/dashboard/direct-trade-section.tsx",
    ].map((file) => fs.readFileSync(path.join(root, file), "utf8"))
    for (const source of sources) {
      expect(
        source.includes("DIRECT_TRADE_LIVE_EXECUTION_READY")
        || source.includes("liveExecutionReady"),
      ).toBe(true)
    }
    const dashboard = sources.at(-1) || ""
    expect(dashboard).toContain("state.liveExecutionReady === false && !state.liveMode")
  })

  test("hydrates positions before syncing and settles blocked legacy openings without retry storms", () => {
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

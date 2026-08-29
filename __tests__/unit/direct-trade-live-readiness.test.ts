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
  })
})

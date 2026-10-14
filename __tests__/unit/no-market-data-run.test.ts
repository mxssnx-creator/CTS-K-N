import { readFileSync } from "node:fs"
import path from "node:path"
import { SUPPORTED_CONNECTOR_EXCHANGES, isSupportedConnectorExchange } from "@/lib/supported-exchanges"

/**
 * 2026-10-07: a paper run QuickStarted mexc-x01 (no connector), loaded no
 * market data, evaluated nothing and was still reported as complete, Live
 * active and coverage-clean.
 */
const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")

describe("connections without a connector", () => {
  test("only exchanges the connector factory builds are supported", () => {
    expect([...SUPPORTED_CONNECTOR_EXCHANGES]).toEqual(["bybit", "bingx", "pionex", "orangex", "binance", "okx", "instaforex"])
    expect(isSupportedConnectorExchange("BingX")).toBe(true)
    expect(isSupportedConnectorExchange("mexc")).toBe(false)
    expect(isSupportedConnectorExchange("gateio")).toBe(false)
    expect(isSupportedConnectorExchange(undefined)).toBe(false)
  })

  test("the factory and QuickStart share that list", () => {
    expect(source("lib/exchange-connectors/index.ts")).toContain("Supported exchanges: ${SUPPORTED_CONNECTOR_EXCHANGES.join(\", \")}")
    const quickStart = source("app/api/trade-engine/quick-start/route.ts")
    const guard = quickStart.slice(quickStart.indexOf("const canUseRequestedConnection"))
    expect(guard.indexOf("isSupportedConnectorExchange(normalizeQuickstartExchange(c))"))
      .toBeLessThan(guard.indexOf("if (!liveTradeRequested) return true"))
  })

  test("the observation harness defaults to the BingX public-data connection and stops without candles", () => {
    const harness = source("scripts/run-engine-observation.mjs")
    expect(harness).toContain('String(process.env.OBS_CONNECTION_ID || "bingx-x01").trim()')
    expect(harness).toContain("prehistoric phase complete with 0 candles (no market data)")
  })
})

describe("prehistoric bootstrap without market data", () => {
  test("is a failure, never a completed run", () => {
    const engine = source("lib/trade-engine/engine-manager.ts")
    const guard = engine.indexOf("Historic bootstrap loaded no market data")
    expect(guard).toBeGreaterThan(0)
    // Before any completion write of the same bootstrap.
    expect(guard).toBeLessThan(engine.indexOf("prehistoric_processed", guard - 2000))
    expect(engine).toContain("Number(processingResult.symbolsWithoutData) >= processingResult.symbolsTotal")
  })
})

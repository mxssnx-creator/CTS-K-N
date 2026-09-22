import { readFileSync } from "node:fs"
import { resolve } from "node:path"
const p = readFileSync(resolve(process.cwd(), "scripts/direct-trade-processor.mjs"), "utf8")
const status = readFileSync(resolve(process.cwd(), "app/api/trade-engine/direct-trade/status/route.ts"), "utf8")

describe("Direct Trade: a warming config trades in shadow, never for real", () => {
  test("a warming config's entry is marked shadow; a proven one is not", () => {
    expect(p).toContain('if (configEvaluation.enabled && configEvaluation.reason === "warming") shadowEntryKeys.add(candidateKey)')
    expect(p).toContain("else shadowEntryKeys.delete(candidateKey)")
  })
  test("a shadow position is simulated even in live mode — it never reaches the venue", () => {
    expect(p).toContain('mode: shadowEntryKeys.has(configKey(config)) ? "simulated" : (state.liveMode ? "live" : "simulated")')
    expect(p).toContain("shadow: shadowEntryKeys.has(configKey(config)),")
  })
  test("shadow positions take no capacity from proven configs", () => {
    const fn = p.slice(p.indexOf("function currentRuntimePositions()"))
    expect(fn.slice(0, 300)).toContain("!position?.shadow")
  })
  test("shadow positions are excluded from the processor's stats and the status route", () => {
    expect(p).toContain("if (position.shadow) return false // warming configs are not results")
    expect(status).toContain("const positions: any[] = storedRows.filter((p: any) => p?.shadow !== true)")
    expect(status).toContain("shadowPositionCount: shadowCount,")
  })
  test("shadow closes still feed the config history that proves or disables a config", () => {
    // Closes are recorded for every position; the evaluation reads that history.
    expect(p).toContain("recordAccountedConfigOutcome(position, position.exitReason)")
    expect(p).toContain("const history = configPerformance.get(key) || []")
  })
})

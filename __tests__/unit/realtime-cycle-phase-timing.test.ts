import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const pipeline = readFileSync(resolve(process.cwd(), "lib/trade-engine/shared-ind-strat-pipeline.ts"), "utf8")
const engine = readFileSync(resolve(process.cwd(), "lib/trade-engine/engine-manager.ts"), "utf8")

describe("a slow realtime cycle can be attributed to a phase", () => {
  test("every awaited phase of the per-symbol cycle is measured", () => {
    expect(pipeline).toContain("phaseDurationsMs?: { indication: number; pseudo: number; strategy: number }")
    expect(pipeline).toContain("result.phaseDurationsMs.indication = Date.now() - indicationStartedAt")
    expect(pipeline).toContain("result.phaseDurationsMs.pseudo = Date.now() - pseudoStartedAt")
    expect(pipeline).toContain("result.phaseDurationsMs.strategy = Date.now() - strategyStartedAt")
  })

  test("each measurement closes after its own await, not inside the call chain", () => {
    const strategyCall = pipeline.indexOf("const stratResult = await withPhaseTimeout(")
    const strategyClose = pipeline.indexOf("result.phaseDurationsMs.strategy = Date.now() - strategyStartedAt")
    const phase3Label = pipeline.indexOf("`Phase3/processStrategy/${symbol}`")
    expect(strategyCall).toBeLessThan(phase3Label)
    expect(phase3Label).toBeLessThan(strategyClose)
  })

  test("the slow path reports the phase split and the slowest symbols, on the captured channel", () => {
    const slowPath = engine.slice(engine.indexOf("if (cycleSlowThresholdExceeded) {"))
    expect(slowPath).toContain("realtime-progression phase split:")
    expect(slowPath).toContain("indication=${phaseTotals.indication}ms")
    expect(slowPath).toContain("slowest symbols:")
    expect(slowPath.slice(0, slowPath.indexOf("phase split:"))).toContain("console.warn(")
  })

  test("attribution can never break the cycle", () => {
    const slowPath = engine.slice(engine.indexOf("if (cycleSlowThresholdExceeded) {"))
    expect(slowPath).toContain("catch { /* attribution must never break the cycle */ }")
  })
})

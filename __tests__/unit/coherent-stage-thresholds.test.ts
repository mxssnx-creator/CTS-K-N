import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { MAIN_TRADE_PF_RATIO_MAX, resolveCoherentStageThresholds } from "@/lib/main-trade-profit-factor"

describe("stage ProfitFactor thresholds form one coherent pipeline", () => {
  test("a later stage looser than an earlier one is lifted — no dead gates", () => {
    // Production: base 1.1, downstream 1.02 made Main/Real/Live dead gates.
    const t = resolveCoherentStageThresholds({ base: 1.1, main: 1.02, real: 1.02, live: 1.02 })
    expect([t.base, t.main, t.real, t.live]).toEqual([1.1, 1.1, 1.1, 1.1])
    expect(t.lifted.map((l) => l.stage)).toEqual(["main", "real", "live"])
  })

  test("a stricter downstream stage is kept — it genuinely refines", () => {
    const t = resolveCoherentStageThresholds({ base: 1.1, main: 1.2, real: 1.3, live: 1.3 })
    expect([t.base, t.main, t.real, t.live]).toEqual([1.1, 1.2, 1.3, 1.3])
    expect(t.lifted).toEqual([])
  })

  test("thresholds never decrease along the pipeline", () => {
    for (const raw of [
      { base: 1.5, main: 1.02, real: 1.3, live: 1.02 },
      { base: 0.9, main: 1.4, real: 1.02, live: 2.0 },
      { base: 2.0, main: 2.0, real: 1.02, live: 1.02 },
    ]) {
      const t = resolveCoherentStageThresholds(raw)
      expect(t.main).toBeGreaterThanOrEqual(t.base)
      expect(t.real).toBeGreaterThanOrEqual(t.main)
      expect(t.live).toBeGreaterThanOrEqual(t.real)
    }
  })

  test("an unreachable value is reported as clamped, not swallowed silently", () => {
    // Production: base 7 became 2.3 and blocked 58 of 63 symbols unnoticed.
    const t = resolveCoherentStageThresholds({ base: 7, main: 1.02, real: 1.02, live: 1.02 })
    expect(t.base).toBe(MAIN_TRADE_PF_RATIO_MAX)
    expect(t.clamped).toEqual([{ stage: "base", configured: 7, effective: MAIN_TRADE_PF_RATIO_MAX }])
  })

  test("equal thresholds need no adjustment", () => {
    const t = resolveCoherentStageThresholds({ base: 1.1, main: 1.1, real: 1.1, live: 1.1 })
    expect(t.lifted).toEqual([])
    expect(t.clamped).toEqual([])
  })

  test("the coordinator applies the coherent values and reports every adjustment", () => {
    const src = readFileSync(resolve(process.cwd(), "lib/strategy-coordinator.ts"), "utf8")
    expect(src).toContain("const coherent = resolveCoherentStageThresholds({")
    expect(src).toContain("const mainPF = coherent.main")
    expect(src).toContain("clamped (unreachable)")
    expect(src).toContain("lifted (was looser than the stage before)")
    // Reported once per change, not every cycle.
    expect(src).toContain("this._lastThresholdSignature !== thresholdSignature")
  })
})

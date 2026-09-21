import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { MAX_INDICATION_WINDOW } from "@/lib/constants"
import { roundTripCostPercent } from "@/lib/trading-round-trip-cost"
import { BLOCK_MAX_STACK_RATIO, BLOCK_SHARED_RATIO_DEFAULT, BLOCK_STEP_MAX } from "@/lib/historic-test-family-derivations"
import { HISTORIC_TEST_MIN_PROFIT_FACTOR_DEFAULT } from "@/lib/historic-test-settings"

/**
 * Guards the configuration the 2026-09-19 baseline was measured under.
 *
 * If one of these changes, the baseline numbers no longer describe the code —
 * either re-measure and update docs/baseline, or the change is unintended.
 */
describe("stable baseline 2026-09-19 — calculation configuration", () => {
  test("round-trip cost is the real 0.26%, not the PositionCost sizing setting", () => {
    expect(roundTripCostPercent()).toBeCloseTo(0.26, 10)
  })

  test("indication windows reach 48", () => {
    expect(MAX_INDICATION_WINDOW).toBe(48)
  })

  test("validation threshold is 1.1", () => {
    expect(HISTORIC_TEST_MIN_PROFIT_FACTOR_DEFAULT).toBe(1.1)
  })

  test("Block: 5x stack ceiling, 3 steps, shared ratio 0.8", () => {
    expect(BLOCK_MAX_STACK_RATIO).toBe(5)
    expect(BLOCK_STEP_MAX).toBe(3)
    expect(BLOCK_SHARED_RATIO_DEFAULT).toBe(0.8)
  })

  test("the reproducible dataset and script are committed", () => {
    for (const path of [
      "docs/baseline/STABLE-BASELINE-2026-09-19.md",
      "docs/baseline/candles-2026-09-19-1m.json.gz",
      "scripts/baseline/simulate-24h-portfolio.ts",
      "scripts/baseline/fetch-candles-1m.mjs",
    ]) {
      expect([path, existsSync(resolve(process.cwd(), path))]).toEqual([path, true])
    }
  })

  test("the recorded reference numbers are present for comparison", () => {
    const doc = readFileSync(resolve(process.cwd(), "docs/baseline/STABLE-BASELINE-2026-09-19.md"), "utf8")
    for (const figure of ["1.1405", "1.1415", "1.1373", "15.63 %", "17,576", "52,728"]) {
      expect([figure, doc.includes(figure)]).toEqual([figure, true])
    }
  })
})

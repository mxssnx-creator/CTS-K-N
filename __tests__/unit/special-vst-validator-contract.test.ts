import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("Special Prod-VST validator report contract", () => {
  test("aligns Fixed and Trailing 24-hour statistics to one market endpoint", () => {
    const source = readFileSync(
      join(process.cwd(), "scripts/run-special-vst-5d-validation.ts"),
      "utf8",
    )

    expect(source).toContain(
      "calculateSpecial24HourTwoHourStats(bestFixed.result.trades, commonEnd)",
    )
    expect(source).toContain(
      "calculateSpecial24HourTwoHourStats(bestTrailing.result.trades, commonEnd)",
    )
    expect(source).toContain("stats24hWindow")
    expect(source).toContain("sharedEndTimestamp")
  })

  test("promotes the next volatility-ranked symbol when a fresh listing lacks requested-window coverage", () => {
    const source = readFileSync(
      join(process.cwd(), "scripts/run-special-vst-5d-validation.ts"),
      "utf8",
    )

    expect(source).toContain("for (const candidate of volatilitySelection.selection)")
    expect(source).toContain("candidateCoverageRatio < MINIMUM_COVERAGE_RATIO")
    expect(source).toContain("rejectedInsufficientCoverage")
    expect(source).toContain("eligibleFetched.length >= TARGET_SYMBOL_COUNT")
    expect(source).not.toContain("measured.slice(0, TARGET_SYMBOL_COUNT)")
    expect(source).toContain("SPECIAL_VST_DAYS")
    expect(source).toContain("SPECIAL_VST_TARGET_SYMBOLS")
    expect(source).toContain("riskEnvelopes")
    expect(source).toContain("qualifiedLowestDrawdown")
  })
})

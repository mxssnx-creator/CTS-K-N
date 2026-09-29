import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { DEFAULT_BASE_MIN_STEP, DEFAULT_TRAILING_MIN_STEP } from "@/lib/constants"
import { DEFAULT_STRATEGY_EXECUTION_POLICY, normalizeStrategyExecutionPolicy } from "@/lib/strategy-execution-policy"
import { strategyIndicationConfigurationIdentity, withoutVolatileIndicationConfigFields } from "@/lib/strategy-coordinator"

const src = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8")

describe("Min Trailing Step defaults to 8, independent of the base step", () => {
  test("the constants", () => {
    expect(DEFAULT_TRAILING_MIN_STEP).toBe(8)
    expect(DEFAULT_BASE_MIN_STEP).toBe(5) // minStep / indicationRangeMin are unchanged
  })
  test("every trailingMinStep default uses it, and the base-step users do not", () => {
    for (const f of ["components/settings/utils.ts", "components/settings/strategy-coordination-section.tsx", "app/api/settings/connections/[id]/settings/route.ts", "lib/strategy-coordinator.ts", "lib/redis-migrations.ts"]) {
      const text = src(f)
      expect(text).not.toMatch(/trailingMinStep\s*[:=]\s*(String\()?DEFAULT_BASE_MIN_STEP/)
      expect(text).toContain("DEFAULT_TRAILING_MIN_STEP")
    }
    expect(src("components/settings/utils.ts")).toMatch(/minStep:\s*DEFAULT_BASE_MIN_STEP/)
  })
})

describe("DCA is disabled by default", () => {
  test("the execution policy default and an unconfigured policy", () => {
    expect(DEFAULT_STRATEGY_EXECUTION_POLICY.dcaEnabled).toBe(false)
    expect(normalizeStrategyExecutionPolicy({}).dcaEnabled).toBe(false)
  })
  test("an explicit operator choice still wins, under each accepted name", () => {
    expect(normalizeStrategyExecutionPolicy({ dcaEnabled: true }).dcaEnabled).toBe(true)
    expect(normalizeStrategyExecutionPolicy({ dca_enabled: "1" }).dcaEnabled).toBe(true)
    expect(normalizeStrategyExecutionPolicy({ dcaEnabled: false }).dcaEnabled).toBe(false)
  })
})

describe("Hedge is the default position mode", () => {
  test("a missing position_mode means hedge everywhere it used to mean one-way; forex keeps one-way", () => {
    const live = src("lib/trade-engine/stages/live-stage.ts")
    expect(live).toContain('const hedgeMode = positionMode === ""\n      ? livePosition.marketType !== "forex"')
    const factory = src("lib/exchange-connectors/factory.ts")
    expect(factory).toContain('positionMode: isInstaForex ? "one_way" : (connection.position_mode || "hedge"),')
    expect(factory).toContain('position_mode: isInstaForex ? "one_way" : (connection.position_mode || "hedge"),')
    expect(src("lib/connection-manager-v2.ts")).toContain('position_mode: input.position_mode ?? (isInstaForex ? "one_way" : "hedge"),')
  })
  test("the dialogs already start on hedge", () => {
    expect(src("components/settings/add-connection-dialog.tsx")).toContain('position_mode: "hedge",')
    expect(src("components/settings/exchange-connection-dialog.tsx")).toContain('position_mode: "hedge",')
  })
})

describe("a Set keeps its identity while the market moves (config sets are not lost)", () => {
  const trend = (m: Record<string, unknown>, structural: Record<string, unknown> = {}) => ({
    type: "trend", name: "trend", direction: "long",
    config: {
      combined: false, configuredActiveSituationRatio: 0.5, configuredDrawdownFactor: -1, configuredLastSituationRatio: 0.5,
      direction: "long", positionCostPct: 0.1, timeframeMinutes: 5,
      adaptiveTpRange: { maxFactor: 10, minMultiplier: 2, positionCostPct: 0.1, step: 1, appliedMinFactor: 1, calculatedMinFactor: 0.27, factors: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], averageOneMinuteChangePct: 0.0137, marketChangePositionCostRatio: 0.137 },
      activeMarketChangePct: 0.0188, activeSituationRatio: 0.84, adverseDrawdownFactor: 0, adverseDrawdownPct: 0, averageOneMinuteChangePct: 0.0222,
      continuationAgreement: 1, directionEvaluation: { long: { agreement: 1, evidenceCount: 5, score: 0.11 } }, lastSituationPct: 0.0337, lastSituationRatio: 0.758,
      positionCostRatio: 1.11, totalChangePct: 0.111,
      ...structural, ...m,
    },
  })
  test("two cycles that differ only in measurements are the same Set", () => {
    const a = strategyIndicationConfigurationIdentity(trend({}))
    const b = strategyIndicationConfigurationIdentity(trend({
      activeMarketChangePct: 0.0555, activeSituationRatio: 0.91, averageOneMinuteChangePct: 0.031, lastSituationPct: 0.09, lastSituationRatio: 0.66,
      positionCostRatio: 1.5, totalChangePct: 0.17, directionEvaluation: { long: { agreement: 0.6, evidenceCount: 9, score: 0.4 } },
      adaptiveTpRange: { maxFactor: 10, minMultiplier: 2, positionCostPct: 0.1, step: 1, appliedMinFactor: 3, calculatedMinFactor: 2.78, factors: [3, 4, 5, 6, 7, 8, 9, 10], averageOneMinuteChangePct: 0.139, marketChangePositionCostRatio: 1.39 },
    }))
    expect(a).toBe(b)
  })
  test("a structural difference is a different Set: timeframe, direction, configured ratios, adaptive step", () => {
    const base = strategyIndicationConfigurationIdentity(trend({}))
    expect(strategyIndicationConfigurationIdentity(trend({ timeframeMinutes: 1 }))).not.toBe(base)
    expect(strategyIndicationConfigurationIdentity(trend({ configuredLastSituationRatio: 0.7 }))).not.toBe(base)
    expect(strategyIndicationConfigurationIdentity(trend({ configuredDrawdownFactor: 2 }))).not.toBe(base)
    expect(strategyIndicationConfigurationIdentity(trend({ adaptiveTpRange: { maxFactor: 10, minMultiplier: 3, positionCostPct: 0.1, step: 1 } }))).not.toBe(base)
    expect(strategyIndicationConfigurationIdentity({ ...trend({}), direction: "short", config: { ...trend({}).config, direction: "short" } })).not.toBe(base)
  })
  test("an explicit setKey is still preserved byte-for-byte, and the move type keeps its structural direction", () => {
    expect(strategyIndicationConfigurationIdentity({ name: "trend", setKey: "type=trend|name=trend|config={x:1}" })).toBe("type=trend|name=trend|config={x:1}")
    const move = (range: number, extra: Record<string, unknown> = {}) => ({ name: "move", direction: "long", config: { direction: "long", primary: true, rangePercent: range, directionEvaluation: { long: { score: range } }, ...extra } })
    expect(strategyIndicationConfigurationIdentity(move(0.015))).toBe(strategyIndicationConfigurationIdentity(move(0.031)))
  })
  test("the sanitiser drops only measurements, at every depth, and leaves the input untouched", () => {
    const input = { keep: 1, score: 0.5, nested: { keep: 2, evidenceCount: 3, adaptiveTpRange: { step: 1, factors: [1], calculatedMinFactor: 2 } }, list: [{ keep: 3, agreement: 1 }] }
    const out: any = withoutVolatileIndicationConfigFields(input)
    expect(out).toEqual({ keep: 1, nested: { keep: 2, adaptiveTpRange: { step: 1 } }, list: [{ keep: 3 }] })
    expect(input.score).toBe(0.5)
    // `factors` is only dropped inside adaptiveTpRange
    expect((withoutVolatileIndicationConfigFields({ factors: [1, 2] }) as any).factors).toEqual([1, 2])
  })
})

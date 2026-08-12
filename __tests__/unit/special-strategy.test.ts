import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  DEFAULT_SPECIAL_STRATEGY_SETTINGS,
  SPECIAL_MAX_HOLDING_SECONDS,
  SPECIAL_MAX_POSITIONS_PER_DIRECTION,
  SPECIAL_MAX_SL_TO_TP_RATIO,
  SPECIAL_MAX_VOLUME_RATIO,
  backtestSpecialStrategy,
  buildSpecialTimeframeSeries,
  calculateSpecial24HourTwoHourStats,
  calculateSpecialPositionPlan,
  evaluateSpecialDirectionLanes,
  evaluateSpecialIndication,
  evaluateSpecialMultiTimeframeCoordination,
  normalizeSpecialStrategySettings,
  sanitizeSpecialPositionPlan,
  specialExitVariantSettings,
  type SpecialBacktestTrade,
} from "@/lib/special-strategy"

const permissive = {
  minStep: 3,
  maxStep: 3,
  stepSize: 1,
  activeWindow: 3,
  minimumEvidence: 2,
  minimumAgreement: 0.6,
  minimumMarketChangePct: 0.01,
  minimumMarketChangeSpeedRatio: 0,
  minimumScore: 0,
  noiseFilterPct: 0,
  minimumActivityRatio: 0,
  maximumVolatilityPct: 100,
  maximumSpreadBps: 10_000,
} as const

describe("Special independent direction and safety contracts", () => {
  test("reapplies every non-bypassable cap to imported settings", () => {
    const settings = normalizeSpecialStrategySettings({
      minStep: 1,
      maxPositionsPerDirection: 99,
      maxVolumeRatio: 40,
      stopLossMaxTakeProfitRatio: 12,
      additionalPositionStepPositionCostRatio: 1,
      maximumHoldingSeconds: 99_999,
      targetHoldingSeconds: 99_999,
      minimumMarketChangePct: 0.001,
      roundTripCostPct: 0.2,
      minimumTakeProfitAfterCostsRatio: 2,
    })

    expect(settings.minStep).toBe(3)
    expect(settings.maxPositionsPerDirection).toBe(SPECIAL_MAX_POSITIONS_PER_DIRECTION)
    expect(settings.maxVolumeRatio).toBe(SPECIAL_MAX_VOLUME_RATIO)
    expect(settings.stopLossMaxTakeProfitRatio).toBe(SPECIAL_MAX_SL_TO_TP_RATIO)
    expect(settings.additionalPositionStepPositionCostRatio).toBe(3)
    expect(settings.maximumHoldingSeconds).toBe(SPECIAL_MAX_HOLDING_SECONDS)
    expect(settings.targetHoldingSeconds).toBe(SPECIAL_MAX_HOLDING_SECONDS)
    expect(settings.minimumMarketChangePct).toBe(0.4)
  })

  test("calculates Long and Short independently and emits only the effective side", () => {
    const prices = [100, 100.2, 100.45, 100.8]
    const lanes = evaluateSpecialDirectionLanes(prices, permissive, undefined, 15)
    expect(lanes?.long.qualified).toBe(true)
    expect(lanes?.short.qualified).toBe(false)
    expect(lanes?.long.marketChangeSpeedPctPerSecond).toBeGreaterThan(0)
    expect(lanes?.short.marketChangeSpeedPctPerSecond).toBeLessThan(0)

    expect(evaluateSpecialIndication(prices, "long", 3, permissive, undefined, 15)?.direction)
      .toBe("long")
    expect(evaluateSpecialIndication(prices, "short", 3, permissive, undefined, 15)).toBeNull()
  })

  test("does not invent a paired direction for a neutral range", () => {
    const prices = [100, 100, 100, 100]
    expect(evaluateSpecialIndication(prices, "long", 3, permissive, undefined, 15)).toBeNull()
    expect(evaluateSpecialIndication(prices, "short", 3, permissive, undefined, 15)).toBeNull()
  })

  test("does not fabricate 15-second bars from one-minute observations", () => {
    const observations = Array.from({ length: 10 }, (_, index) => ({
      timestampMs: 1_700_000_000_000 + index * 60_000,
      price: 100 + index,
      volume: 10,
    }))
    expect(buildSpecialTimeframeSeries(observations, 15)).toBeNull()
    expect(buildSpecialTimeframeSeries(observations, 60)?.closes).toHaveLength(10)
  })

  test("coordinates multiple timeframe hypotheses into one winning direction", () => {
    const observations = Array.from({ length: 32 }, (_, index) => ({
      timestampMs: 1_700_000_000_000 + index * 15_000,
      price: 100 + index * 0.1,
      volume: 10 + index,
    }))
    const result = evaluateSpecialMultiTimeframeCoordination({
      observations,
      sampleRange: 3,
      settings: {
        ...permissive,
        timeframe15sEnabled: true,
        timeframe1mEnabled: true,
        timeframe15mEnabled: false,
        timeframe30mEnabled: false,
        minimumTimeframeConfirmations: 2,
        minimumCombinedScoreMargin: 0,
      },
    })

    expect(result?.frames.map((frame) => frame.timeframeSeconds)).toEqual([15, 60])
    expect(result?.long.qualifiedTimeframes).toBe(2)
    expect(result?.short.qualifiedTimeframes).toBe(0)
    expect(result?.selectedDirection).toBe("long")
  })

  test("bounds logical legs, total volume, protection and holding time", () => {
    const indication = evaluateSpecialIndication(
      [100, 101, 102, 103],
      "long",
      3,
      permissive,
      undefined,
      15,
    )!
    const plan = calculateSpecialPositionPlan({
      indication,
      positionCostPct: 0.1,
      entryPrice: 100,
      currentPrice: 120,
      settings: {
        ...permissive,
        maxPositionsPerDirection: 99,
        maxVolumeRatio: 99,
        volumeIncrementRatio: 2,
        stopLossMaxTakeProfitRatio: 99,
        maximumHoldingSeconds: 99_999,
      },
    })!

    expect(plan.logicalPositionCount).toBe(SPECIAL_MAX_POSITIONS_PER_DIRECTION)
    expect(plan.legs).toHaveLength(SPECIAL_MAX_POSITIONS_PER_DIRECTION)
    expect(plan.totalVolumeRatio).toBe(SPECIAL_MAX_VOLUME_RATIO)
    expect(plan.protection.stopLossPct).toBeLessThanOrEqual(
      plan.protection.takeProfitPct * SPECIAL_MAX_SL_TO_TP_RATIO,
    )
    expect(plan.maximumHoldingSeconds).toBe(SPECIAL_MAX_HOLDING_SECONDS)
  })

  test("materializes trailing and fixed exits as independent variants", () => {
    const variants = specialExitVariantSettings({
      ...permissive,
      nonTrailingVariantEnabled: true,
      trailingEnabled: true,
    })
    expect(variants.map((variant) => variant.exitVariant)).toEqual(["fixed", "trailing"])
    expect(variants.map((variant) => variant.settings.trailingEnabled)).toEqual([false, true])

    const indication = evaluateSpecialIndication(
      [100, 100.2, 100.5, 101],
      "long",
      3,
      permissive,
      { volumes: [10, 11, 14, 20] },
      15,
    )!
    const plans = variants.map((variant) => calculateSpecialPositionPlan({
      indication,
      positionCostPct: 0.1,
      entryPrice: 100,
      currentPrice: 101,
      settings: variant.settings,
    })!)
    expect(plans.map((plan) => plan.exitVariant)).toEqual(["fixed", "trailing"])
    expect(plans[0].logicalPositionCount).toBe(plans[1].logicalPositionCount)
    expect(plans[0].totalVolumeRatio).toBe(plans[1].totalVolumeRatio)
    expect(plans[0].protection.trailingEnabled).toBe(false)
    expect(plans[1].protection.trailingEnabled).toBe(true)
    expect(plans[1].protection.trailingAdaptive).toBe(true)
  })

  test("exposes every Special engine setting in Settings → Special", () => {
    const source = readFileSync(
      resolve(process.cwd(), "components/settings/tabs/special-tab.tsx"),
      "utf8",
    )
    const missing = Object.keys(DEFAULT_SPECIAL_STRATEGY_SETTINGS).filter((key) => {
      const settingKey = `special${key[0].toUpperCase()}${key.slice(1)}`
      return !source.includes(`settingKey="${settingKey}"`)
    })
    expect(missing).toEqual([])
  })

  test("sanitizes stale plans and rebuilds absolute prices for the exact direction", () => {
    const malicious: any = {
      direction: "short",
      logicalPositionCount: 90,
      maxPositionsPerDirection: 90,
      totalVolumeRatio: 30,
      maxVolumeRatio: 30,
      favorableMarketMovePct: -4,
      weightedEntryPrice: 100,
      minimumHoldingSeconds: 1,
      targetHoldingSeconds: 99_999,
      maximumHoldingSeconds: 99_999,
      legs: [],
      protection: {
        takeProfitPct: 1,
        stopLossPct: 10,
        takeProfitPrice: 999,
        stopLossPrice: 1,
        trailingEnabled: true,
        trailingActivationPct: 0.5,
        trailingDistancePct: 9,
        trailingStepPct: 9,
        trailingActivationPrice: 1,
      },
    }
    const plan = sanitizeSpecialPositionPlan(malicious, "short")!
    expect(plan.logicalPositionCount).toBe(5)
    expect(plan.totalVolumeRatio).toBe(3)
    expect(plan.legs).toHaveLength(5)
    expect(plan.protection.stopLossPct).toBe(3)
    expect(plan.protection.takeProfitPrice).toBe(99)
    expect(plan.protection.stopLossPrice).toBe(103)
    expect(plan.maximumHoldingSeconds).toBe(90 * 60)
    expect(sanitizeSpecialPositionPlan(malicious, "long")).toBeNull()
  })
})

describe("Special validation statistics", () => {
  test("keeps naturally asymmetric Long/Short counts instead of mirroring them", () => {
    const closes = Array.from({ length: 180 }, (_, index) => 100 + index * 0.08)
    const timestamps = closes.map((_, index) => 1_700_000_000_000 + index * 60_000)
    const result = backtestSpecialStrategy({
      series: [{ symbol: "UP-USDT", closes, timestamps, volumes: closes.map(() => 10) }],
      positionCostPct: 0.01,
      settings: {
        ...permissive,
        timeframe15sEnabled: false,
        timeframe1mEnabled: true,
        timeframe15mEnabled: false,
        timeframe30mEnabled: false,
        combinedTimeframesEnabled: false,
        minimumHoldingSteps: 0,
        maximumHoldingSteps: 3,
        minimumHoldingSeconds: 1,
        targetHoldingSeconds: 60,
        maximumHoldingSeconds: 180,
        takeProfitMinPositionCostRatio: 1,
        takeProfitMaxPositionCostRatio: 2,
        roundTripCostPct: 0,
        backtestMinimumTrades: 1,
        backtestMinimumTradesPerDirection: 0,
        backtestMinimumTradesPerSymbol: 1,
        backtestMinimumStableProfitFactor: 0,
        backtestMaximumDrawdownPct: 100,
      },
    })

    expect(result.longTrades).toBeGreaterThan(0)
    expect(result.shortTrades).toBe(0)
    expect(result.longTrades).not.toBe(result.shortTrades)
  })

  test("prints all twelve two-hour buckets with combined Pi/PF/DDT statistics", () => {
    const start = Date.UTC(2026, 7, 10, 0, 0, 0)
    const trade = (
      hour: number,
      direction: "long" | "short",
      pnlPct: number,
      symbol: string,
    ): SpecialBacktestTrade => ({
      symbol,
      direction,
      exitVariant: "fixed",
      entryIndex: 0,
      exitIndex: 1,
      entryPrice: 100,
      exitPrice: 100 + pnlPct,
      entryTimestamp: start + hour * 60 * 60 * 1_000 - 60_000,
      exitTimestamp: start + hour * 60 * 60 * 1_000,
      pnlPct,
      volumeRatio: 1,
      exitReason: "time",
    })
    const rows = calculateSpecial24HourTwoHourStats([
      trade(1, "long", 2, "BTC-USDT"),
      trade(1.5, "short", -1, "ETH-USDT"),
      trade(5, "long", 3, "SOL-USDT"),
    ], start + 24 * 60 * 60 * 1_000)

    expect(rows).toHaveLength(12)
    expect(rows[0]).toMatchObject({ pisCount: 2, longCount: 1, shortCount: 1 })
    expect(rows[0].profitFactor).toBe(2)
    expect(rows[1].pisCount).toBe(0)
    expect(rows[2].pisCount).toBe(1)
    expect(rows[0].maxDrawdownDurationSeconds).toBeGreaterThan(0)
  })
})

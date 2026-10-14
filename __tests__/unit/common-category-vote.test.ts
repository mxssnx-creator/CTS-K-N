/**
 * Auto's Common vote counts categories, not types; the Common settings,
 * cooldown and Preset helpers resolve every type through the catalogue.
 */
import {
  COMMON_INDICATOR_TYPES,
  LEGACY_COMMON_INDICATOR_TYPES,
  normalizeCommonIndicationSettings,
} from "@/lib/common-indicator-config"
import { summarizeCommonCategories } from "@/lib/common-indicators/categories"
import { syntheticCandles } from "@/lib/common-indicators/synthetic"
import { IndicationSetsProcessor } from "@/lib/indication-sets-processor"
import { expandLegacyDefaultIndicatorTypes } from "@/lib/preset-optimizer"
import { StepBasedIndicators } from "@/lib/step-based-indicators"

const reading = (direction: "long" | "short" | "neutral", strength = 0.5) => ({ direction, strength })

describe("Common category vote", () => {
  test("many agreeing types of one category are one vote", () => {
    const summary = summarizeCommonCategories({
      rsi: reading("long", 0.8),
      stochastic: reading("long", 0.6),
      williamsR: reading("long", 0.4),
      cci: reading("long"),
      rsiReversion: reading("long"),
      zScore: reading("long"),
      stochRsi: reading("long"),
    })
    expect(summary).toMatchObject({ direction: "long", signals: 1, longVotes: 1, shortVotes: 0, agreement: 1 })
    expect(summary.categories.oscillator).toMatchObject({ direction: "long", long: 7, short: 0 })
    // minimumSignals (default 3) counts categories: a single family cannot carry Auto
    expect(summary.signals).toBeLessThan(3)
  })

  test("each category's majority votes; ties and neutral readings abstain", () => {
    const summary = summarizeCommonCategories({
      ma: reading("long", 1),
      ema: reading("long", 0.5),
      sma: reading("short"),
      rsi: reading("short", 0.6),
      williamsR: reading("short", 0.4),
      obv: reading("long"),
      adl: reading("short"),
      fibonacci: reading("neutral"),
      macd: reading("long", 0.9),
    })
    expect(summary.categories.trend).toMatchObject({ direction: "long", long: 2, short: 1, strength: 0.75 })
    expect(summary.categories.oscillator).toMatchObject({ direction: "short", strength: 0.5 })
    expect(summary.categories.volume).toMatchObject({ direction: "neutral" })
    expect(summary.categories.structure).toMatchObject({ direction: "neutral", neutral: 1 })
    expect(summary).toMatchObject({
      direction: "long",
      longVotes: 2,
      shortVotes: 1,
      neutralVotes: 2,
      signals: 3,
    })
    expect(summary.agreement).toBeCloseTo(2 / 3, 6)
    expect(summary.strength).toBeCloseTo((0.75 + 0.9) / 2, 6)
  })

  test("step summaries carry the category vote and keep the per-type summary", async () => {
    const candles = syntheticCandles("AAA-USDT", 1, 400, Date.UTC(2026, 9, 1), 3)
    const result = await StepBasedIndicators.calculateSummariesAsync(candles, [1, 5])
    for (const timeframe of ["1", "5"]) {
      const step = result[timeframe]
      expect(step.summary.categories).toBeDefined()
      expect(step.summary.signals).toBeLessThanOrEqual(6)
      expect(step.typeSummary.signals).toBe(
        Object.values(step.indicators).filter((item) => item && item.direction !== "neutral").length,
      )
    }
  })

  test("minimumSignals is bounded by the number of categories", () => {
    expect(normalizeCommonIndicationSettings({ coordination: { minimumSignals: 40 } }).coordination.minimumSignals).toBe(6)
    expect(normalizeCommonIndicationSettings({}).coordination.minimumSignals).toBe(3)
  })
})

describe("Common settings are read by storage key", () => {
  test("a psar Set's cooldown uses the timeout stored under parabolicSAR", async () => {
    const processor = new IndicationSetsProcessor("conn-cooldown") as any
    await processor.settingsReady
    processor.commonSettings = normalizeCommonIndicationSettings({
      parabolicSAR: { enabled: true, timeout: 30, interval: 2 },
      emaTrend: { enabled: true, timeout: 7, interval: 1 },
    })
    const cooldown = (type: string) => processor.candidateCooldown("BTCUSDT", {
      setKey: `indication_set:conn-cooldown:BTCUSDT:common:long:${type}:tf1:p%7B%7D`,
      indication: { direction: "long", metadata: { direction: "long" } },
      config: { indicatorType: type, timeframeMinutes: 1, parameters: {} },
    })
    expect(cooldown("psar").timeoutMs).toBe(30_000)
    expect(cooldown("emaTrend").timeoutMs).toBe(7_000)
  })
})

describe("Preset type lists", () => {
  test("the former 17-type default gains every new type; a customised list is kept", () => {
    expect(expandLegacyDefaultIndicatorTypes([...LEGACY_COMMON_INDICATOR_TYPES])).toEqual([...COMMON_INDICATOR_TYPES])
    expect(expandLegacyDefaultIndicatorTypes([...LEGACY_COMMON_INDICATOR_TYPES.filter((type) => type !== "psar"), "sar"]))
      .toEqual([...COMMON_INDICATOR_TYPES])
    expect(expandLegacyDefaultIndicatorTypes(["rsi", "macd"])).toEqual(["rsi", "macd"])
  })
})

describe("Preset selection resolves a position's exact Common type", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { inferIndicationType } = require("@/lib/preset-store") as typeof import("@/lib/preset-store")
  test("reads the type segment of the Common Set key, never a substring of the symbol", () => {
    expect(inferIndicationType({
      setKey: "indication_set:c1:MATICUSDT:common:long:rsi:tf5:p%7B%7D",
    })).toBe("rsi")
    expect(inferIndicationType({
      setKey: "indication_set:c1:BTCUSDT:common:short:emaTrend:tf1:p%7B%7D",
    })).toBe("emaTrend")
    expect(inferIndicationType({ indicationType: "WilliamsR" })).toBe("williamsR")
    expect(inferIndicationType({ indicationType: "sar" })).toBe("psar")
    expect(inferIndicationType({ setKey: "indication_set:c1:MATICUSDT:direction:long:range5" })).toBeNull()
  })
})

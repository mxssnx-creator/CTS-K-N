/**
 * Generic checks over every Common type (the 17 original ones and the types
 * ported from CTS-A-O): catalogue / registry consistency, causality (a bar's
 * reading never changes when later bars arrive), both directions fire, the
 * long/short symmetry on the price mirror, warm-up and parameter validity.
 */
import {
  COMMON_INDICATOR_CATEGORIES,
  COMMON_INDICATOR_DEFINITIONS,
  COMMON_INDICATOR_TYPES,
  DEFAULT_COMMON_INDICATION_SETTINGS,
  LEGACY_COMMON_INDICATOR_TYPES,
  commonIndicatorParameterConfigurations,
  commonIndicatorStorageKey,
  normalizeCommonIndicationSettings,
  type CommonIndicatorDefinition,
  type CommonIndicatorSettings,
} from "@/lib/common-indicator-config"
import { COMMON_CATALOG } from "@/lib/common-indicators/catalog"
import { createCommonSeriesContext } from "@/lib/common-indicators/context"
import { AO_RULES, NEW_RULE_MAPPINGS } from "@/lib/common-indicators/new-rules"
import { COMMON_RULES, commonRuleStates, evaluateCommonRule } from "@/lib/common-indicators/registry"
import { mirrorCandles, syntheticCandles } from "@/lib/common-indicators/synthetic"
import type { TechnicalCandle } from "@/lib/common-indicators/types"

const END = Date.UTC(2026, 9, 1, 0, 0)
const MAIN_TYPES = ["direction", "move", "active", "active_advanced", "special", "optimal", "auto", "signal", "trend", "common"]

const settingsOf = (definition: CommonIndicatorDefinition) =>
  DEFAULT_COMMON_INDICATION_SETTINGS[definition.storageKey] as CommonIndicatorSettings

/** first and last default tuple of a type */
function sampleTuples(definition: CommonIndicatorDefinition): Record<string, number>[] {
  const tuples = commonIndicatorParameterConfigurations(definition, settingsOf(definition))
  return tuples.length > 1 ? [tuples[0], tuples[tuples.length - 1]] : tuples
}

/**
 * Synthetic markets with injected shocks so rare events occur on both sides: every 97 bars one of three shock bars
 * (alternating up / down per kind) — an impulse closing near its extreme, a stop-run that pierces and closes back
 * with a long wick, and a capitulation bar closing in the middle of its range — each on a volume burst.
 */
function richCandles(symbol: string, timeframe: number, count: number, seed: number): TechnicalCandle[] {
  const candles = syntheticCandles(symbol, timeframe, count, END, seed)
  let shock = 0
  for (let index = 150; index < candles.length; index += 97, shock++) {
    const kind = shock % 3
    const sign = Math.floor(shock / 3) % 2 === 0 ? 1 : -1
    const candle = candles[index]
    const open = candle.open
    const size = open * (kind === 2 ? 0.035 : 0.02)
    if (kind === 0) {
      candle.close = open + sign * size * 0.85
      candle.high = sign > 0 ? open + size * 0.9 : open + size * 0.05
      candle.low = sign > 0 ? open - size * 0.05 : open - size * 0.9
    } else if (kind === 1) {
      candle.close = open + sign * size * 0.05
      candle.high = sign > 0 ? open + size : Math.max(open, candle.close) + size * 0.05
      candle.low = sign > 0 ? Math.min(open, candle.close) - size * 0.05 : open - size
    } else {
      candle.close = open + sign * size * 0.5
      candle.high = sign > 0 ? open + size : open + size * 0.05
      candle.low = sign > 0 ? open - size * 0.05 : open - size
    }
    candle.volume *= 8
  }
  return candles
}

describe("Common catalogue and registry", () => {
  test("every type has one definition and one rule; storage keys are unique and never collide with Main types", () => {
    expect(COMMON_INDICATOR_TYPES).toHaveLength(COMMON_INDICATOR_DEFINITIONS.length)
    expect(new Set(COMMON_INDICATOR_TYPES).size).toBe(COMMON_INDICATOR_TYPES.length)
    expect(COMMON_INDICATOR_TYPES.slice(0, 17)).toEqual([...LEGACY_COMMON_INDICATOR_TYPES])
    const storageKeys = COMMON_INDICATOR_DEFINITIONS.map((definition) => definition.storageKey)
    expect(new Set(storageKeys).size).toBe(storageKeys.length)
    for (const definition of COMMON_INDICATOR_DEFINITIONS) {
      expect(COMMON_RULES.get(definition.type)?.type).toBe(definition.type)
      expect(MAIN_TYPES).not.toContain(definition.storageKey)
      expect(COMMON_INDICATOR_CATEGORIES).toContain(definition.category)
      expect(commonIndicatorStorageKey(definition.type)).toBe(definition.storageKey)
    }
    expect(COMMON_RULES.size).toBe(COMMON_INDICATOR_DEFINITIONS.length)
    expect(commonIndicatorStorageKey("psar")).toBe("parabolicSAR")
    expect(commonIndicatorStorageKey("sar")).toBe("parabolicSAR")
  })

  test("every ported type maps to a registered CTS-A-O rule and its parameters", () => {
    expect(COMMON_CATALOG.length).toBe(112)
    for (const entry of COMMON_CATALOG) {
      const mapping = NEW_RULE_MAPPINGS[entry.type]
      expect(mapping).toBeDefined()
      expect(AO_RULES.has(mapping.source)).toBe(true)
      expect(entry.sources.length).toBeGreaterThan(0)
    }
    // Stable-02 belongs to the CTS-G project, the Micro relations need the whole universe: neither is ported
    const sources = [...AO_RULES.keys()]
    expect(sources.some((id) => id.startsWith("s2-"))).toBe(false)
    expect(sources.some((id) => /^mc-(lag|rsrev|mturn|act|irsi2|mrsi2|iz|ivwapd)/.test(id))).toBe(false)
  })

  test("default tuples are valid, constraints hold and a stored document gains every new type enabled with a 1 s timeout", () => {
    for (const definition of COMMON_INDICATOR_DEFINITIONS) {
      const tuples = commonIndicatorParameterConfigurations(definition, settingsOf(definition))
      expect(tuples.length).toBeGreaterThan(0)
      for (const tuple of tuples) {
        for (const [left, operator, right] of definition.constraints || []) {
          expect(operator === "<" ? tuple[left] < tuple[right] : tuple[left] <= tuple[right]).toBe(true)
        }
        for (const [key, parameter] of Object.entries(definition.parameters)) {
          expect(tuple[key]).toBeGreaterThanOrEqual(parameter.min)
          expect(tuple[key]).toBeLessThanOrEqual(parameter.max)
        }
      }
    }
    // a document saved before the CTS-A-O types existed (17 types, rsi customised)
    const stored = normalizeCommonIndicationSettings({
      coordination: { minimumSignals: 3 },
      rsi: { enabled: false, timeout: 5, interval: 2 },
    })
    expect((stored.rsi as CommonIndicatorSettings).enabled).toBe(false)
    expect((stored.rsi as CommonIndicatorSettings).timeout).toBe(5)
    for (const entry of COMMON_CATALOG) {
      const settings = stored[entry.type] as CommonIndicatorSettings
      expect(settings.enabled).toBe(true)
      expect(settings.timeout).toBe(1)
    }
    const sparse = normalizeCommonIndicationSettings({ macd: { enabled: true } })
    expect((sparse.macd as CommonIndicatorSettings).timeout).toBe(1)
  })
})

describe("Common rules are causal and two-sided", () => {
  const cuts = [260, 520, 777]
  const markets = [3, 11].flatMap((seed) => [
    { tf: 1, candles: richCandles("AAA-USDT", 1, 1_200, seed) },
    { tf: 15, candles: richCandles("BBB-USDT", 15, 1_200, seed) },
  ])

  test("a bar's state never changes when later bars arrive (full series vs prefixes)", () => {
    const violations: string[] = []
    for (const definition of COMMON_INDICATOR_DEFINITIONS) {
      const rule = COMMON_RULES.get(definition.type)!
      for (const tuple of sampleTuples(definition)) {
        for (const market of markets.slice(0, 2)) {
          const full = commonRuleStates(createCommonSeriesContext(market.candles, { normalized: true }), rule, tuple)
          for (const cut of cuts) {
            const prefix = commonRuleStates(
              createCommonSeriesContext(market.candles.slice(0, cut), { normalized: true }), rule, tuple)
            for (let index = 0; index < cut; index++) {
              if (prefix[index] !== full[index]) {
                violations.push(`${definition.type} ${JSON.stringify(tuple)} tf${market.tf} cut ${cut} bar ${index}`)
                break
              }
            }
          }
        }
      }
    }
    expect(violations).toEqual([])
  })

  test("the live last-bar result equals the state series at that bar", () => {
    const market = markets[0]
    for (const definition of COMMON_INDICATOR_DEFINITIONS) {
      const rule = COMMON_RULES.get(definition.type)!
      const tuple = sampleTuples(definition)[0]
      const series = commonRuleStates(createCommonSeriesContext(market.candles, { normalized: true }), rule, tuple)
      for (const cut of [400, 811]) {
        const result = evaluateCommonRule(
          createCommonSeriesContext(market.candles.slice(0, cut), { normalized: true }), rule, tuple, 14)
        const direction = result?.direction === "long" ? 1 : result?.direction === "short" ? -1 : 0
        expect([definition.type, direction]).toEqual([definition.type, series[cut - 1]])
      }
    }
  })

  // Rules that need UTC days, quarter-hour boundaries or the previous day's range only fire on wall-clock bars of
  // the right length; the 4× trend rules need ~200 bars of history. They are checked on long 1m and 15m series.
  test("every type fires long and short on synthetic markets", () => {
    const silent: string[] = []
    const series = [
      ...[3, 11, 29].map((seed) => richCandles("CCC-USDT", 15, 3_000, seed)),
      ...[5, 17].map((seed) => richCandles("DDD-USDT", 1, 4_320, seed)),
    ]
    for (const definition of COMMON_INDICATOR_DEFINITIONS) {
      const rule = COMMON_RULES.get(definition.type)!
      let long = 0
      let short = 0
      for (const tuple of commonIndicatorParameterConfigurations(definition, settingsOf(definition)).slice(0, 4)) {
        for (const candles of series) {
          const states = commonRuleStates(createCommonSeriesContext(candles, { normalized: true }), rule, tuple)
          for (const value of states) {
            if (value > 0) long++
            else if (value < 0) short++
          }
        }
      }
      if (long === 0 || short === 0) silent.push(`${definition.type}: long ${long} short ${short}`)
    }
    expect(silent).toEqual([])
  })

  test("long/short symmetry on the price mirror (K / price)", () => {
    const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(20, 0.3 * Math.max(a, b))
    const bad: string[] = []
    const series = [3, 11].map((seed) => richCandles("EEE-USDT", 5, 3_000, seed))
    for (const definition of COMMON_INDICATOR_DEFINITIONS) {
      const rule = COMMON_RULES.get(definition.type)!
      // A reversion rule mirrors onto the same rule only with symmetric levels: the
      // first default RSI tuple is 20 / 60, whose mirror is 40 / 80, so RSI uses
      // overbought = 100 − oversold here (audit F1: rsi is a reversion rule).
      const base = sampleTuples(definition)[0]
      const tuple = definition.type === "rsi" ? { ...base, overbought: 100 - base.oversold } : base
      const count = { up: 0, dn: 0, mup: 0, mdn: 0 }
      for (const candles of series) {
        const a = commonRuleStates(createCommonSeriesContext(candles, { normalized: true }), rule, tuple)
        const b = commonRuleStates(createCommonSeriesContext(mirrorCandles(candles), { normalized: true }), rule, tuple)
        for (let index = 0; index < a.length; index++) {
          if (a[index] > 0) count.up++
          else if (a[index] < 0) count.dn++
          if (b[index] > 0) count.mup++
          else if (b[index] < 0) count.mdn++
        }
      }
      if (!near(count.up, count.mdn) || !near(count.dn, count.mup)) {
        bad.push(`${definition.type}: long ${count.up} short ${count.dn} | mirrored long ${count.mup} short ${count.mdn}`)
      }
    }
    // Kept as they were (original types): "fibonacci" reads the close against the nearest retracement level, which
    // is not mirror symmetric (the mirror's 38.2 % level is the market's 61.8 % level), and the first default
    // Williams %R tuple has asymmetric levels (−90 oversold, −30 overbought).
    expect(bad.filter((line) => !/^(fibonacci|williamsR):/.test(line))).toEqual([])
  })

  test("no result before the warm-up; a result once the series is long enough", () => {
    const candles = richCandles("FFF-USDT", 15, 1_500, 7)
    for (const definition of COMMON_INDICATOR_DEFINITIONS) {
      const rule = COMMON_RULES.get(definition.type)!
      const tuple = sampleTuples(definition)[0]
      const warmup = rule.warmup(rule.resolve(tuple, 14))
      expect(warmup).toBeGreaterThan(0)
      if (warmup > 1) {
        const short = createCommonSeriesContext(candles.slice(0, warmup - 1), { normalized: true })
        expect([definition.type, evaluateCommonRule(short, rule, tuple, 14)]).toEqual([definition.type, undefined])
      }
      const long = createCommonSeriesContext(candles, { normalized: true })
      expect([definition.type, evaluateCommonRule(long, rule, tuple, 14) !== undefined]).toEqual([definition.type, true])
    }
  })
})

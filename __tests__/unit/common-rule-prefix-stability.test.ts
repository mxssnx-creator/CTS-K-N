/**
 * Prefix stability of every Common rule: the full result (direction, strength,
 * value, signal, details) read at bar k of a longer series equals the live
 * result of the series cut after bar k. The one-pass replay
 * (StepBasedIndicators.createSummarySeries) relies on it to reproduce live
 * Auto exactly; a failure here is a causality bug in the rule.
 */
import {
  COMMON_INDICATOR_DEFINITIONS,
  DEFAULT_COMMON_INDICATION_SETTINGS,
  commonIndicatorParameterConfigurations,
  type CommonIndicatorDefinition,
  type CommonIndicatorSettings,
} from "@/lib/common-indicator-config"
import { createCommonSeriesContext } from "@/lib/common-indicators/context"
import { normalizeTechnicalCandles, resampleNormalizedCandles } from "@/lib/common-indicators/kn-math"
import { evaluateCommonRule, getCommonRule, toCommonResult } from "@/lib/common-indicators/registry"
import { syntheticCandles } from "@/lib/common-indicators/synthetic"
import type { TechnicalCandle } from "@/lib/common-indicators/types"

const END = Date.UTC(2026, 9, 3, 0, 0)

/** synthetic minutes with impulse / wick / capitulation shocks on volume bursts (both sides) */
function shockedMinutes(count: number, seed: number): TechnicalCandle[] {
  const candles = syntheticCandles("PFX-USDT", 1, count, END, seed)
  let shock = 0
  for (let index = 120; index < candles.length; index += 89, shock++) {
    const sign = Math.floor(shock / 3) % 2 === 0 ? 1 : -1
    const candle = candles[index]
    const size = candle.open * 0.02
    candle.close = candle.open + sign * size * (shock % 3 === 1 ? 0.05 : 0.8)
    candle.high = Math.max(candle.open, candle.close) + size * (sign > 0 ? 0.3 : 0.05)
    candle.low = Math.min(candle.open, candle.close) - size * (sign > 0 ? 0.05 : 0.3)
    candle.volume *= 8
  }
  return candles
}

function sampleTuples(definition: CommonIndicatorDefinition): Record<string, number>[] {
  const tuples = commonIndicatorParameterConfigurations(
    definition,
    DEFAULT_COMMON_INDICATION_SETTINGS[definition.storageKey] as CommonIndicatorSettings,
  )
  if (tuples.length <= 2) return tuples
  return [tuples[0], tuples[Math.floor(tuples.length / 2)], tuples[tuples.length - 1]]
}

const MINUTES = shockedMinutes(1_200, 5)
const SERIES: Array<{ tf: number; candles: TechnicalCandle[] }> = [
  { tf: 1, candles: MINUTES },
  { tf: 15, candles: resampleNormalizedCandles(normalizeTechnicalCandles(MINUTES), 15) },
]

describe("Common rules are prefix-stable", () => {
  for (const { tf, candles } of SERIES) {
    const full = createCommonSeriesContext(candles, { normalized: true, tfMin: tf })
    const n = candles.length
    test(`tf${tf}: every type, three tuples, four cuts`, () => {
      const mismatches: string[] = []
      let compared = 0
      for (const definition of COMMON_INDICATOR_DEFINITIONS) {
        const rule = getCommonRule(definition.type)!
        for (const tuple of sampleTuples(definition)) {
          const params = rule.resolve(tuple, 14)
          const warmup = rule.warmup(params)
          const cuts = [...new Set([warmup - 1, warmup + 13, Math.floor(n / 2), n - 2])]
            .filter((k) => k >= 0 && k < n && k + 1 >= warmup)
          for (const k of cuts) {
            const prefix = createCommonSeriesContext(candles.slice(0, k + 1), { normalized: true, tfMin: tf })
            const live = evaluateCommonRule(prefix, rule, tuple, 14)
            const sample = rule.at(full, params, k)
            const series = sample ? toCommonResult(rule.type, sample) : undefined
            compared++
            if (JSON.stringify(series) !== JSON.stringify(live)) {
              mismatches.push(`${definition.type} ${JSON.stringify(tuple)} k=${k}: series=${JSON.stringify(series)} live=${JSON.stringify(live)}`)
            }
          }
        }
      }
      expect(compared).toBeGreaterThan(COMMON_INDICATOR_DEFINITIONS.length)
      expect(mismatches.slice(0, 10)).toEqual([])
    })
  }
})

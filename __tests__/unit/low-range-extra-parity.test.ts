/**
 * The K-N Low-Range extra port (band reclaim, squeeze break, RSI(2) reclaim) must
 * reproduce the CTS-A-O reference bar for bar, in both its batch and streaming
 * paths, including resets on gaps and invalid bars and the inverse variants.
 */
import { SeriesCache as AoSeriesCache } from "@/shared/cts-indications/origin/indications/cache.ts"
import { lowRangeExtraSpecs } from "@/shared/cts-indications/origin/indications/low-range-extra.ts"
import { SeriesCache } from "@/lib/common-indicators/ao/series-cache"
import {
  LOW_RANGE_EXTRA_FILTERS,
  LOW_RANGE_EXTRA_METHODS,
  LOW_RANGE_EXTRA_WINDOWS,
  lowRangeExtraState,
} from "@/lib/common-indicators/ao/low-range-extra"
import { AO_RULES } from "@/lib/common-indicators/new-rules"
import { syntheticCandles } from "@/lib/common-indicators/synthetic"

const END = Date.UTC(2026, 9, 1)

function bars(symbol: string, tfMin: number, count: number) {
  const candles = syntheticCandles(symbol, tfMin, count, END)
  // a one-bar gap and one malformed bar exercise the fresh-warmup resets
  candles.splice(900, 1)
  candles[1500] = { ...candles[1500], low: candles[1500].high * 1.01 }
  const n = candles.length
  const col = (pick: (c: (typeof candles)[number]) => number) => Float64Array.from(candles, pick)
  return {
    sym: symbol, tfMin, n,
    t: col((c) => c.timestamp), o: col((c) => c.open), h: col((c) => c.high),
    l: col((c) => c.low), c: col((c) => c.close), v: col((c) => c.volume),
  }
}

describe("Low-Range extra parity with CTS-A-O", () => {
  const series = [bars("BTC-USDT", 1, 3000), bars("SOL-USDT", 5, 3000), bars("XRP-USDT", 15, 2500)]

  test("every reference spec matches the K-N state exactly (batch and streaming)", () => {
    const specs = lowRangeExtraSpecs()
    expect(specs).toHaveLength(LOW_RANGE_EXTRA_WINDOWS.length * LOW_RANGE_EXTRA_METHODS.length * LOW_RANGE_EXTRA_FILTERS.length * 2)
    const fired = new Map<string, number>()
    for (const b of series) {
      const batch = new AoSeriesCache(b as never)
      const stream = new AoSeriesCache(b as never).enableStreaming()
      const kn = new SeriesCache(b)
      for (const spec of specs) {
        const [, , , window, ...rest] = spec.id.split("-")
        const inverse = rest[rest.length - 1] === "inverse"
        const filter = (inverse ? rest[rest.length - 2] : rest[rest.length - 1]) as (typeof LOW_RANGE_EXTRA_FILTERS)[number]
        const method = rest.slice(0, rest.length - (inverse ? 2 : 1)).join("-") as (typeof LOW_RANGE_EXTRA_METHODS)[number]
        const expected = spec.fn(batch as never)
        const actual = lowRangeExtraState(kn, Number(window), method, filter, inverse)
        expect(Array.from(actual)).toEqual(Array.from(expected))
        expect(Array.from(spec.fn(stream as never))).toEqual(Array.from(expected))
        fired.set(method, (fired.get(method) ?? 0) + actual.reduce((sum, value) => sum + (value ? 1 : 0), 0))
      }
    }
    // the fixture must actually exercise every method, not compare empty vectors
    for (const method of LOW_RANGE_EXTRA_METHODS) expect(fired.get(method)).toBeGreaterThan(0)
  })

  test("registered K-N rules resolve filter/inverse parameters onto the reference", () => {
    const b = series[1]
    const ref = new AoSeriesCache(b as never)
    for (const method of LOW_RANGE_EXTRA_METHODS) {
      const rule = AO_RULES.get(`r-low-range-extra-${method}`)
      expect(rule).toBeDefined()
      for (const spec of lowRangeExtraSpecs().filter((s) => s.id.includes(`-${method}-`) && s.id.startsWith("low-range-research-12-"))) {
        const inverse = spec.id.endsWith("-inverse")
        const filterName = LOW_RANGE_EXTRA_FILTERS.find((f) => spec.id.includes(`-${f}`))!
        const actual = rule!.fn(new SeriesCache(b), { window: 12, filter: LOW_RANGE_EXTRA_FILTERS.indexOf(filterName), inverse: inverse ? 1 : 0 })
        expect(Array.from(actual)).toEqual(Array.from(spec.fn(ref as never)))
      }
    }
  })
})

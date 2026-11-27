import { CommonSeriesContext } from "@/lib/common-indicators/context"
import { getCommonRule } from "@/lib/common-indicators/registry"
import { evaluateSignalCandles, normalizeSignalIndicationSettings } from "@/lib/signal-indication"
import { getSignalSource, SIGNAL_CANDIDATE_SOURCE_IDS } from "@/lib/signal-source-registry"

describe("Trend-Reversal", () => {
  const minute = 60_000
  const sourceId = "bingx-trend-reversal-structure-10"
  let seed = 291, close = 100
  const random = () => (seed = (Math.imul(1664525, seed) + 1013904223) >>> 0) / 2 ** 32
  const rows = Array.from({ length: 200 }, (_, i) => {
    const open = close
    close += Math.sin(i / 3) * .23 + (random() - .5) * 1.2
    return { timestamp: 1_790_000_040_000 + i * minute, open, close,
      high: Math.max(open, close) + random() * .25, low: Math.min(open, close) - random() * .25, volume: 5 + random() * 40 }
  })

  it("keeps Common and candidate Signal identities and opt-in separate", () => {
    const rule = getCommonRule("trendReversal-structure")!
    expect(rule.resolve({ period: 10 })).toEqual({ period: 10 })
    const raw = rule.states!(new CommonSeriesContext(rows, 1), { period: 10 })
    expect(Array.from(raw)).toContain(1)
    expect(Array.from(raw)).toContain(-1)
    const source = getSignalSource(sourceId)!
    expect(source.candleSourceId).toBe("bingx-swap")
    expect(SIGNAL_CANDIDATE_SOURCE_IDS).toContain(sourceId)
    const settings = normalizeSignalIndicationSettings({ candleLimit: 200, minimumConfidence: .5, minimumStrength: .05, stopLossMaxPct: 5 })
    expect(settings.sources[sourceId]?.enabled).toBe(false)
    const evaluated = rows.flatMap((_, i) => {
      const r = evaluateSignalCandles({ source, candles: rows.slice(0, i + 1), settings, positionCostPct: .11 })
      return r ? [{ r, i }] : []
    })
    expect(evaluated.length).toBeGreaterThan(0)
    expect(evaluated.every(({ r, i }) =>
      r.sourceId === sourceId && r.direction === (raw[i] === 1 ? "long" : "short") && raw[i] !== raw[i - 1])).toBe(true)
  })
})

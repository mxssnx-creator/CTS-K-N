import { compactCtsGMinuteCloses, ctsGTimeframeCloses, ctsGLegacyTimeframeCloses } from "@/lib/cts-g-timeframes"
import { evaluateCtsGTrend } from "@/lib/cts-g-indications"

const start = Date.UTC(2026, 8, 4)
const minutes = (count: number) => Array.from({ length: count }, (_, index) => ({
  timestamp: start + index * 60_000, close: 100 + index * 0.1,
}))

describe("CTS-G real timeframe history", () => {
  test.each([1, 5, 15, 30])("evaluates genuine %i-minute Trend bars from compact day history", width => {
    const bars = ctsGTimeframeCloses(minutes(1440), width, start + 86_400_000)
    expect(bars).toHaveLength(1440 / width)
    expect(bars[0]).toBeCloseTo(100 + (width - 1) * 0.1)
    expect(evaluateCtsGTrend(bars)?.direction).toBe("long")
  })
  test("does not label the last partial or future bar as a completed 30-minute candle", () => {
    const rows = minutes(65)
    rows[64].close = 999
    expect(ctsGTimeframeCloses(rows, 30, start + 64 * 60_000)).toEqual([102.9, 105.9])
    expect(ctsGTimeframeCloses(rows, 30, start + 30 * 60_000)).toEqual([102.9])
  })
  test("missing minutes reset warm-up, without filling prices across the gap", () => {
    const rows = minutes(65).filter((_, index) => index !== 37)
    expect(ctsGTimeframeCloses(rows, 30, start + 65 * 60_000)).toEqual([])
    expect(ctsGTimeframeCloses(minutes(90).filter((_, i) => i !== 37), 30, start + 90 * 60_000)).toEqual([108.9])
  })
  test("second-frequency data collapse deterministically with bounded retention", () => {
    const rows = Array.from({ length: 86_400 }, (_, index) => ({ timestamp: start + index * 1000, close: index + 1 }))
    const compact = compactCtsGMinuteCloses([...rows].reverse())
    expect(compact).toHaveLength(1440)
    expect(compact[0].close).toBe(60)
    expect(compact.at(-1)?.close).toBe(86_400)
    expect(ctsGTimeframeCloses(compact, 30, start + 86_400_000)).toHaveLength(48)
    expect(compactCtsGMinuteCloses(minutes(5000))).toHaveLength(1441)
  })
  test("legacy minute arrays do not treat adjacent samples as 30-minute bars", () => {
    expect(ctsGLegacyTimeframeCloses([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([4, 7])
    expect(ctsGLegacyTimeframeCloses([1, 2, 3], 30)).toEqual([])
  })
})

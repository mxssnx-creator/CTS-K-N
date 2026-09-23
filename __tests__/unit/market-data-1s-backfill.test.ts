import { expandMinuteBarsToSeconds, mergeSecondsWithMinuteBackfill, ONE_SECOND_BACKFILL_WINDOW_S } from "@/lib/market-data-1s-backfill"

const bar = (t: number, o: number, h: number, l: number, c: number, v = 60) => ({ timestamp: t, open: o, high: h, low: l, close: c, volume: v })

describe("one-second history from real minute bars", () => {
  test("a minute keeps its real open and close and stays inside its real high/low", () => {
    const s = expandMinuteBarsToSeconds([bar(0, 10, 12, 9, 11)], 0, 60_000)
    expect(s).toHaveLength(60)
    expect(s[0].open).toBe(10)
    expect(s[59].close).toBeCloseTo(11, 10)
    for (const c of s) { expect(c.high).toBeLessThanOrEqual(12); expect(c.low).toBeGreaterThanOrEqual(9); expect(c.volume).toBeCloseTo(1, 10) }
    for (let i = 1; i < s.length; i++) expect(s[i].open).toBeCloseTo(s[i - 1].close, 10) // continuous
  })
  test("real trade-built seconds win; minute bars fill the rest of the window densely", () => {
    const now = 10_000_000_000
    // Illiquid: 509 real seconds scattered over the last 40 minutes (gaps between them).
    const real = Array.from({ length: 509 }, (_, i) => bar(Math.floor((now - 2_400_000 + i * 4_700) / 1000) * 1000, 5, 5, 5, 5, 1))
    const minutes = Array.from({ length: 125 }, (_, i) => bar(Math.floor((now - (124 - i) * 60_000) / 60_000) * 60_000, 4, 4.5, 3.5, 4))
    const { candles } = mergeSecondsWithMinuteBackfill(real, minutes, now)
    const ts = candles.map((c) => c.timestamp)
    expect(new Set(ts).size).toBe(ts.length)
    // dense: at least the 5,400-second minimum, no gaps above one second
    expect(candles.length).toBeGreaterThanOrEqual(5_400)
    for (let i = 1; i < ts.length; i++) expect(ts[i] - ts[i - 1]).toBe(1000)
    // every real second is present unchanged
    const byT = new Map(candles.map((c) => [c.timestamp, c]))
    for (const r of real) expect(byT.get(r.timestamp)?.close).toBe(5)
  })
  test("with complete real seconds nothing is backfilled", () => {
    const now = 10_000_000_000
    const fromMs = Math.floor((now - ONE_SECOND_BACKFILL_WINDOW_S * 1000) / 1000) * 1000
    const real = Array.from({ length: ONE_SECOND_BACKFILL_WINDOW_S }, (_, i) => bar(fromMs + i * 1000, 1, 1, 1, 1))
    const minutes = Array.from({ length: 125 }, (_, i) => bar(Math.floor((now - (124 - i) * 60_000) / 60_000) * 60_000, 2, 2, 2, 2))
    expect(mergeSecondsWithMinuteBackfill(real, minutes, now).backfilledSeconds).toBe(0)
  })
})

describe("per-connection leverage ceiling", () => {
  const src = require("node:fs").readFileSync(require("node:path").resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
  test("max_leverage caps the venue maximum; unset keeps the venue maximum", () => {
    expect(src).toContain("const connectionCap = Math.floor(Number((connRecord as any)?.max_leverage || 0))")
    expect(src).toContain("livePosition.leverage = connectionCap > 0 ? Math.max(1, Math.min(venueMax, connectionCap)) : venueMax")
    // ... and it survives the volume calculator, which reports its own maximum.
    const after = src.indexOf("livePosition.leverage = volumeResult?.leverage || livePosition.leverage")
    expect(src.indexOf("if (cap > 0) livePosition.leverage = Math.max(1, Math.min(Number(livePosition.leverage) || cap, cap))", after)).toBeGreaterThan(after)
  })
})

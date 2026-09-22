import { runBotBacktest, BOT_FEES, BOT_TUNING, type Candle } from "@/lib/bots/backtest"
import { BOT_BOUNDS, defaultBotSettings, normalizeBotSettings } from "@/lib/bots/settings"

function synthetic(symbols: number, bars: number): Record<string, Candle[]> {
  const out: Record<string, Candle[]> = {}
  for (let s = 0; s < symbols; s++) {
    let px = 100 + s
    const rows: Candle[] = []
    for (let i = 0; i < bars; i++) {
      // deterministic oscillation with occasional excursions
      const step = Math.sin((i + s * 7) / 9) * 0.12 + (i % 97 === 0 ? -1.2 : 0) + (i % 131 === 0 ? 1.2 : 0)
      const open = px; px = Math.max(1, px * (1 + step / 100))
      rows.push({ time: 1_700_000_000_000 + i * 60_000, open, high: Math.max(open, px) * 1.0008, low: Math.min(open, px) * 0.9992, close: px, volume: 1000 + s })
    }
    out[`S${s}USDT`] = rows
  }
  return out
}

describe("bot settings follow the operator's bounds", () => {
  test("defaults", () => {
    const d = defaultBotSettings("sandwich")
    expect(d).toMatchObject({ symbolCount: 10, symbolRanking: "volatility_1h", minTakeProfitPct: 0.4, minStopLossPct: 0.5, trailingDistancePct: 0.3, volumeFactor: 1, rebaseRatio: 0.6 })
  })
  test("values are clamped and snapped to the configured steps", () => {
    const n = normalizeBotSettings("sandwich", { symbolCount: 37, minTakeProfitPct: 9, minStopLossPct: 0.1, trailingDistancePct: 0.44, volumeFactor: 0, backtestHours: 100 } as any)
    expect(n.symbolCount).toBe(40)
    expect(n.minTakeProfitPct).toBe(BOT_BOUNDS.minTakeProfitPct.max)
    expect(n.minStopLossPct).toBe(BOT_BOUNDS.minStopLossPct.min)
    expect(n.trailingDistancePct).toBeCloseTo(0.4, 10)
    expect(n.volumeFactor).toBe(1)
    expect(n.backtestHours).toBe(72)
  })
  test("each bot type keeps independent settings", () => {
    expect(defaultBotSettings("sandwich").type).toBe("sandwich")
    expect(defaultBotSettings("momentum_breakout").type).toBe("momentum_breakout")
  })
})

describe("bot backtest engine", () => {
  const candles = synthetic(12, 24 * 60 + 200)

  test("is deterministic", () => {
    const s = { ...defaultBotSettings("sandwich"), backtestHours: 24 }
    expect(runBotBacktest(candles, s).summary).toEqual(runBotBacktest(candles, s).summary)
  })

  test("produces one hourly row per backtest hour with coherent totals", () => {
    const s = { ...defaultBotSettings("sandwich"), backtestHours: 24 }
    const r = runBotBacktest(candles, s)
    expect(r.hours).toHaveLength(24)
    expect(r.hours.reduce((a, h) => a + h.closed, 0)).toBe(r.trades.length)
  })

  test("costs come from the BingX fee schedule, maker for a bracket entry and TP", () => {
    expect(BOT_FEES).toEqual({ makerPct: 0.02, takerPct: 0.05, slippagePct: 0.03 })
    const r = runBotBacktest(candles, { ...defaultBotSettings("sandwich"), backtestHours: 24 })
    expect(r.summary.costPctPerTrade).toBeCloseTo(0.04, 10)
  })

  test("only the validated bot type is marked validated", () => {
    expect(BOT_TUNING.sandwich.validated).toBe(true)
    expect(BOT_TUNING.momentum_breakout.validated).toBe(false)
    expect(BOT_TUNING.trend_pullback.validated).toBe(false)
  })

  test("overview windows are reported for 12/25/75 positions and 2/6/20 hours", () => {
    const m = runBotBacktest(candles, { ...defaultBotSettings("sandwich"), backtestHours: 24 }).summary
    expect(Object.keys(m.pfLastPositions)).toEqual(["12", "25", "75"])
    expect(Object.keys(m.pfLastHours)).toEqual(["2", "6", "20"])
    expect(Object.keys(m.ddtLastHours)).toEqual(["2", "6", "20"])
  })

  test("never trades once the account is exhausted", () => {
    const r = runBotBacktest(candles, { ...defaultBotSettings("trend_pullback"), backtestHours: 24, volumeFactor: 10 }, { riskPerStopPct: 50 })
    expect(r.summary.endBalance).toBeGreaterThanOrEqual(0)
  })
})

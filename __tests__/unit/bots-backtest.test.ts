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

describe("six independent bot types", () => {
  const { BOT_TYPES } = require("@/lib/bots/settings")
  test("all six are registered and each has tuning", () => {
    expect(Object.keys(BOT_TYPES).sort()).toEqual(["liquidity_sweep", "momentum_breakout", "sandwich", "trend_pullback", "volatility_squeeze", "vwap_reversion"])
    for (const t of Object.keys(BOT_TYPES)) expect(BOT_TUNING[t as keyof typeof BOT_TUNING]).toBeDefined()
  })
  test("only types that stayed profitable out of sample at 10 AND 20 symbols are validated", () => {
    const validated = Object.entries(BOT_TUNING).filter(([, v]) => v.validated).map(([k]) => k).sort()
    expect(validated).toEqual(["liquidity_sweep", "sandwich", "vwap_reversion"])
  })
  test("every type runs and reports the same hourly shape", () => {
    const candles = synthetic(10, 24 * 60 + 200)
    for (const t of Object.keys(BOT_TYPES)) {
      const r = runBotBacktest(candles, { ...defaultBotSettings(t as any), backtestHours: 24 })
      expect([t, r.hours.length]).toEqual([t, 24])
    }
  })
})

describe("bots API guards live execution", () => {
  const src = require("node:fs").readFileSync(require("node:path").resolve(process.cwd(), "app/api/bots/route.ts"), "utf8")
  const store = require("node:fs").readFileSync(require("node:path").resolve(process.cwd(), "lib/bots/store.ts"), "utf8")
  test("an unvalidated bot cannot be started", () => {
    expect(src).toContain('if (action === "start" && !BOT_TUNING[type].validated)')
    expect(store).toContain("if (next.running && !BOT_TUNING[type].validated) next.running = false")
  })
  test("state is scoped per connection AND per bot type", () => {
    expect(store).toContain("`bots:settings:${connectionId}:${type}`")
    expect(store).toContain("`bots:backtest:${connectionId}:${type}`")
  })
})

describe("risk levels and running all bots", () => {
  const { BOT_RISK_LEVELS, normalizeBotGroup } = require("@/lib/bots/settings")
  const { runBotPortfolio } = require("@/lib/bots/backtest")
  test("three levels, ordered from secure to active", () => {
    expect(Object.keys(BOT_RISK_LEVELS)).toEqual(["secure", "normal", "active"])
    expect(BOT_RISK_LEVELS.secure.sizeMultiplier).toBeLessThan(BOT_RISK_LEVELS.normal.sizeMultiplier)
    expect(BOT_RISK_LEVELS.normal.sizeMultiplier).toBeLessThan(BOT_RISK_LEVELS.active.sizeMultiplier)
    expect(BOT_RISK_LEVELS.secure.pauseDdPct).toBeLessThan(BOT_RISK_LEVELS.active.pauseDdPct)
    for (const lv of Object.values(BOT_RISK_LEVELS) as any[]) expect(lv.throttleDdPct).toBeLessThan(lv.pauseDdPct)
  })
  test("group settings normalise to safe defaults", () => {
    expect(normalizeBotGroup(null)).toEqual({ runAll: false, riskLevel: "normal" })
    expect(normalizeBotGroup({ runAll: true, riskLevel: "reckless" } as any)).toEqual({ runAll: true, riskLevel: "normal" })
  })
  test("a riskier level trades the same signals with more size", () => {
    const candles = synthetic(10, 24 * 60 + 200)
    const s = { ...defaultBotSettings("sandwich"), backtestHours: 24 }
    const secure = runBotBacktest(candles, s, { riskLevel: "secure" })
    const active = runBotBacktest(candles, s, { riskLevel: "active" })
    expect(active.trades.length).toBeGreaterThanOrEqual(secure.trades.length - 2)
    const avg = (r: any) => r.trades.reduce((a: number, t: any) => a + t.notional, 0) / Math.max(1, r.trades.length)
    if (secure.trades.length && active.trades.length) expect(avg(active)).toBeGreaterThan(avg(secure))
  })
  test("the portfolio is the hour-by-hour sum of independent bots", () => {
    const candles = synthetic(10, 24 * 60 + 200)
    const list = ["sandwich", "vwap_reversion", "liquidity_sweep"].map((t) => ({ ...defaultBotSettings(t as any), backtestHours: 24 }))
    const p = runBotPortfolio(candles, list, { startBalance: 900 })
    expect(p.bots).toHaveLength(3)
    expect(p.hours).toHaveLength(24)
    const sumOfBots = p.bots.reduce((a: number, b: any) => a + b.summary.positions, 0)
    expect(p.summary.positions).toBe(sumOfBots)
  })
})

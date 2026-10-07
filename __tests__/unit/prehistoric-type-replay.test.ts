import {
  minuteBars,
  minuteClosesOfSorted,
  replayDirectIndicationTypes,
  summarizeTypeReplay,
  type ReplayCandle,
} from "@/lib/trade-engine/prehistoric-type-replay"
import { oneMinuteClosesOldestFirst } from "@/lib/trade-engine/direct-indications"
import { movePctToMainTradePfRatio } from "@/lib/main-trade-profit-factor"

/**
 * The per-type measurement replays the engine's direct indication rules
 * causally and closes each position like a pseudo position: on the first
 * 1-second close beyond TP or SL, or at the maximum hold time, net of
 * PositionCost.
 */
const T0 = Date.UTC(2026, 9, 5, 0, 0, 0)
const SECOND = 1_000
const MINUTE = 60_000

/** Rising 1-second candles (every body bullish); `pathFrom` reshapes the price after `breakAt`. */
function candles(totalSeconds: number, breakAt: number, pathFrom: (secondsAfterBreak: number, base: number) => number): ReplayCandle[] {
  const out: ReplayCandle[] = []
  let price = 100
  for (let second = 0; second < totalSeconds; second++) {
    const timestamp = T0 + second * SECOND
    const open = price
    const close = second < breakAt ? price * (1 + 1e-6) : pathFrom(second - breakAt, out[breakAt - 1]?.close ?? price)
    out.push({ timestamp, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1 })
    price = close
  }
  return out
}

const protection = { takeProfitPct: 0.5, stopLossPct: 0.6 }
const baseInput = (series: ReplayCandle[], overrides: Record<string, unknown> = {}) => ({
  symbol: "BTCUSDT",
  candles: series,
  rangeStartMs: T0,
  rangeEndMs: series[series.length - 1].timestamp,
  positionCostPct: 0.1,
  indicationSettings: {},
  protectionFor: () => protection,
  ...overrides,
})

describe("per-type prehistoric measurement", () => {
  test("no entry before 90 minutes of history; an entry closes on the first close beyond TP, net of cost", async () => {
    const breakAt = 95 * 60
    // After the break the price climbs 0.01 % per second: TP (0.5 %) is crossed after ~50 s.
    const series = candles(100 * 60, breakAt, (after, base) => base * (1 + 0.0001 * (after + 1)))
    const result = await replayDirectIndicationTypes(baseInput(series))
    expect(result.steps).toBeGreaterThan(0)
    const direction = result.closes.find((close) => close.type === "direction" && close.rule === "independent")!
    expect(direction).toBeDefined()
    expect(direction.entryTime).toBeGreaterThanOrEqual(T0 + 90 * MINUTE)
    expect(direction.direction).toBe("long")
    expect(direction.reason).toBe("take_profit")
    expect(direction.grossPct).toBeGreaterThanOrEqual(0.5)
    expect(direction.netPct).toBeCloseTo(direction.grossPct - 0.1, 10)
    // Every close comes from a long entry in a rising market.
    expect(result.closes.every((close) => close.direction === "long")).toBe(true)
  })

  test("a falling market stops the long positions out at the stop-loss", async () => {
    const breakAt = 95 * 60
    const series = candles(100 * 60, breakAt, (after, base) => base * (1 - 0.0001 * (after + 1)))
    const result = await replayDirectIndicationTypes(baseInput(series))
    const stopped = result.closes.filter((close) => close.reason === "stop_loss")
    expect(stopped.length).toBeGreaterThan(0)
    for (const close of stopped) {
      expect(close.grossPct).toBeLessThanOrEqual(-0.6)
      expect(close.netPct).toBeCloseTo(close.grossPct - 0.1, 10)
    }
  })

  test("one open position per type, direction and rule; max hold closes a stalled position", async () => {
    const series = candles(130 * 60, 130 * 60, () => 0)
    const result = await replayDirectIndicationTypes(baseInput(series, { maxHoldMs: 10 * MINUTE }))
    const independent = result.closes.filter((close) => close.type === "direction" && close.rule === "independent")
    expect(independent.length).toBeGreaterThan(1)
    for (const close of independent) expect(close.reason).toBe("max_hold")
    // Never two overlapping positions of the same rule.
    for (let index = 1; index < independent.length; index++) {
      expect(independent[index].entryTime).toBeGreaterThanOrEqual(independent[index - 1].exitTime)
    }
  })

  test("the summary uses the Base gate's PositionCost ratio", () => {
    const close = (netPct: number) => ({
      type: "move", direction: "long" as const, rule: "default", entryTime: 0, exitTime: 1, entryPrice: 1, exitPrice: 1,
      takeProfitPct: 0.5, stopLossPct: 0.6, grossPct: netPct + 0.1, netPct, positionCostPct: 0.1, holdMinutes: 1, reason: "take_profit" as const,
    })
    const summary = summarizeTypeReplay([close(0.4), close(-0.7), close(0.4)])
    expect(summary["move:long"]).toMatchObject({ closed: 3, wins: 2, losses: 1 })
    expect(summary["move:long"].positionCostRatio).toBeCloseTo(
      (movePctToMainTradePfRatio(0.4, 0.1) * 2 + movePctToMainTradePfRatio(-0.7, 0.1)) / 3,
      10,
    )
  })

  test("the fast minute closes equal oneMinuteClosesOldestFirst on gaps and duplicate timestamps", () => {
    let seed = 11
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const series: ReplayCandle[] = []
    let timestamp = T0
    for (let index = 0; index < 4 * 60 * 60; index++) {
      // Mostly one candle per second, with gaps of up to two minutes and repeated timestamps.
      const roll = random()
      timestamp += roll < 0.002 ? Math.floor(random() * 120) * SECOND : roll < 0.01 ? 0 : SECOND
      const close = 100 + random()
      series.push({ timestamp, open: close, high: close, low: close, close, volume: 1 })
    }
    const timestamps = series.map((candle) => candle.timestamp)
    const upper = (value: number) => timestamps.filter((candidate) => candidate <= value).length
    for (let step = T0 + 91 * MINUTE; step <= timestamps[timestamps.length - 1]; step += 7 * MINUTE + 13 * SECOND) {
      const end = upper(step)
      const start = upper(step - 90 * MINUTE)
      expect(minuteClosesOfSorted(series, start, end)).toEqual(oneMinuteClosesOldestFirst(series.slice(start, end)))
    }
  })

  test("step indicators are computed only where Auto can fire", async () => {
    // A flat market never passes the Common coordination: Auto cannot fire.
    const flat = candles(100 * 60, 100 * 60, () => 0)
    const flatCalls = jest.fn(async () => ({}))
    const flatResult = await replayDirectIndicationTypes(baseInput(flat, { stepIndicatorsFor: flatCalls }))
    expect(flatResult.steps).toBeGreaterThan(0)
    expect(flatCalls).not.toHaveBeenCalled()
    expect(flatResult.stepIndicatorCalls).toBe(0)
    // A strong trend passes it; every computed summary is counted.
    const trending = candles(100 * 60, 0, (after, base) => base * (1 + 0.00002 * (after + 1)))
    const trendCalls = jest.fn(async () => ({}))
    const trendResult = await replayDirectIndicationTypes(baseInput(trending, { stepIndicatorsFor: trendCalls }))
    expect(trendCalls).toHaveBeenCalled()
    expect(trendResult.stepIndicatorCalls).toBe(trendCalls.mock.calls.length)
  })

  test("one-minute bars aggregate seconds exactly", () => {
    const seconds: ReplayCandle[] = [
      { timestamp: T0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
      { timestamp: T0 + 30 * SECOND, open: 1.5, high: 3, low: 1, close: 2, volume: 2 },
      { timestamp: T0 + MINUTE, open: 2, high: 2.5, low: 1.8, close: 2.1, volume: 4 },
    ]
    expect(minuteBars(seconds)).toEqual([
      { timestamp: T0, open: 1, high: 3, low: 0.5, close: 2, volume: 3 },
      { timestamp: T0 + MINUTE, open: 2, high: 2.5, low: 1.8, close: 2.1, volume: 4 },
    ])
  })
})

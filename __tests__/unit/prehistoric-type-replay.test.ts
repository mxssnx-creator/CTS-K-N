const directCalls: any[] = []
jest.mock("@/lib/trade-engine/direct-indications", () => {
  const actual = jest.requireActual("@/lib/trade-engine/direct-indications")
  return {
    ...actual,
    computeDirectIndications: (input: any) => {
      directCalls.push(input)
      return actual.computeDirectIndications(input)
    },
  }
})

import {
  minuteBars,
  replayDirectIndicationTypes,
  summarizeTypeReplay,
  type ReplayCandle,
} from "@/lib/trade-engine/prehistoric-type-replay"
import { movePctToMainTradePfRatio } from "@/lib/main-trade-profit-factor"

/**
 * The per-type measurement replays the engine's direct indication rules on
 * the venue's real one-minute bars: a decision at each completed minute from
 * data up to that minute only, entry at its close, exits against every later
 * bar's real high/low (stop first when a bar reaches both), net of
 * PositionCost.
 */
const T0 = Date.UTC(2026, 9, 5, 0, 0, 0)
const MINUTE = 60_000

function bar(index: number, open: number, close: number): ReplayCandle {
  return { timestamp: T0 + index * MINUTE, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1 }
}

/** `count` bars each moving `stepPct`; `override` may reshape single bars. */
function series(count: number, stepPct: number, override?: (index: number, bar: ReplayCandle) => ReplayCandle | void): ReplayCandle[] {
  const out: ReplayCandle[] = []
  let price = 100
  for (let index = 0; index < count; index++) {
    const shaped = bar(index, price, price * (1 + stepPct / 100))
    const next = override?.(index, shaped) || shaped
    out.push(next)
    price = next.close
  }
  return out
}

const protection = { takeProfitPct: 0.5, stopLossPct: 0.6 }
const baseInput = (bars: ReplayCandle[], overrides: Record<string, unknown> = {}) => ({
  symbol: "BTCUSDT",
  bars,
  rangeStartMs: T0,
  rangeEndMs: bars[bars.length - 1].timestamp + MINUTE,
  positionCostPct: 0.1,
  indicationSettings: {},
  protectionFor: () => protection,
  ...overrides,
})
const independentDirection = (closes: any[]) => closes.find((close) => close.type === "direction" && close.rule === "independent")

describe("per-type prehistoric measurement on real minute bars", () => {
  beforeEach(() => { directCalls.length = 0 })

  test("the first decision follows 90 complete bars; a wick to the target exits there, net of cost", async () => {
    const bars = series(100, 0.001, (index, shaped) => index === 95 ? { ...shaped, high: shaped.open * 1.006 } : undefined)
    const result = await replayDirectIndicationTypes(baseInput(bars))
    const close = independentDirection(result.closes)
    expect(close).toMatchObject({ direction: "long", reason: "take_profit", entryTime: T0 + 90 * MINUTE, exitTime: T0 + 96 * MINUTE })
    expect(close.entryPrice).toBe(bars[89].close)
    expect(close.exitPrice).toBeCloseTo(close.entryPrice * 1.005, 10)
    expect(close.grossPct).toBeCloseTo(0.5, 10)
    expect(close.netPct).toBeCloseTo(0.4, 10)
    expect(result.closes.every((entry) => entry.direction === "long")).toBe(true)
  })

  test("a bar reaching both levels counts as a stop", async () => {
    const bars = series(100, 0.001, (index, shaped) => index === 95
      ? { ...shaped, high: shaped.open * 1.006, low: shaped.open * 0.993 }
      : undefined)
    const close = independentDirection((await replayDirectIndicationTypes(baseInput(bars))).closes)
    expect(close.reason).toBe("stop_loss")
    expect(close.grossPct).toBeCloseTo(-0.6, 10)
    expect(close.netPct).toBeCloseTo(-0.7, 10)
  })

  test("a bar opening beyond the stop exits at its open", async () => {
    const bars = series(100, 0.001, (index, shaped) => {
      if (index !== 95) return
      const open = shaped.open * 0.99
      return { ...shaped, open, low: open * 0.999, high: open * 1.001, close: open }
    })
    const close = independentDirection((await replayDirectIndicationTypes(baseInput(bars))).closes)
    expect(close).toMatchObject({ reason: "stop_loss", exitTime: T0 + 95 * MINUTE, exitPrice: bars[95].open })
    expect(close.grossPct).toBeLessThan(-0.6)
  })

  test("every decision sees data up to its own completed minute only", async () => {
    await replayDirectIndicationTypes(baseInput(series(120, 0.01)))
    expect(directCalls.length).toBe(120 - 89)
    for (const call of directCalls) {
      expect(call.now).toBe(call.current.timestamp + MINUTE)
      expect(call.candles[call.candles.length - 1].timestamp).toBe(call.current.timestamp)
      expect(call.pricesOldestFirst).toHaveLength(90)
      expect(call.pricesOldestFirst[89]).toBe(call.current.close)
    }
  })

  test("one open position per type, direction and rule; max hold closes at a bar close", async () => {
    const result = await replayDirectIndicationTypes(baseInput(series(160, 0.001), { maxHoldMs: 10 * MINUTE }))
    const independent = result.closes.filter((close) => close.type === "direction" && close.rule === "independent")
    expect(independent.length).toBeGreaterThan(3)
    for (const close of independent) {
      expect(close.reason).toBe("max_hold")
      expect(close.holdMinutes).toBe(10)
    }
    for (let index = 1; index < independent.length; index++) {
      expect(independent[index].entryTime).toBeGreaterThanOrEqual(independent[index - 1].exitTime)
    }
  })

  test("a missing minute leaves no complete 90-minute window", async () => {
    const bars = series(100, 0.001).filter((_, index) => index !== 50)
    const result = await replayDirectIndicationTypes(baseInput(bars))
    expect(result.steps).toBe(0)
    expect(result.closes).toEqual([])
  })

  test("step indicators are computed only where Auto can fire", async () => {
    const flatCalls = jest.fn(async () => ({}))
    const flat = await replayDirectIndicationTypes(baseInput(series(120, 0), { stepIndicatorsFor: flatCalls }))
    expect(flat.steps).toBeGreaterThan(0)
    expect(flatCalls).not.toHaveBeenCalled()
    expect(flat.stepIndicatorCalls).toBe(0)
    const trendCalls = jest.fn(async () => ({}))
    const trending = await replayDirectIndicationTypes(baseInput(series(120, 0.1), { stepIndicatorsFor: trendCalls }))
    expect(trendCalls).toHaveBeenCalled()
    expect(trending.stepIndicatorCalls).toBe(trendCalls.mock.calls.length)
    // Auto reads exactly the 90 bars of the decision.
    for (const [bars] of trendCalls.mock.calls as any[]) expect(bars).toHaveLength(90)
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

  test("one-minute bars aggregate finer candles exactly", () => {
    const seconds: ReplayCandle[] = [
      { timestamp: T0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
      { timestamp: T0 + 30_000, open: 1.5, high: 3, low: 1, close: 2, volume: 2 },
      { timestamp: T0 + MINUTE, open: 2, high: 2.5, low: 1.8, close: 2.1, volume: 4 },
    ]
    expect(minuteBars(seconds)).toEqual([
      { timestamp: T0, open: 1, high: 3, low: 0.5, close: 2, volume: 3 },
      { timestamp: T0 + MINUTE, open: 2, high: 2.5, low: 1.8, close: 2.1, volume: 4 },
    ])
  })
})

const venueBars: { current: any[] } = { current: [] }
jest.mock("@/lib/market-data-loader", () => ({
  loadRangeMinuteBars: jest.fn(async (_symbol: string, options: { startMs: number; endMs: number }) =>
    venueBars.current.filter((bar) => bar.timestamp >= options.startMs && bar.timestamp < options.endMs)),
}))
jest.mock("@/lib/trade-engine/indication-processor-fixed", () => ({
  loadDirectIndicationSettings: jest.fn(async () => ({ positionCost: 0.1 })),
}))

import { getRedisClient } from "@/lib/redis-db"
import { getPosWindowBatch } from "@/lib/pos-history"
import { replayDirectIndicationTypes } from "@/lib/trade-engine/prehistoric-type-replay"
import { deriveAdaptiveTrendProtection, deriveProtectionFromProfitFactor } from "@/lib/strategy-coordinator"
import { StepBasedIndicators } from "@/lib/step-based-indicators"
import {
  advanceTypeMeasurement,
  parseTypeMeasurementState,
  refreshTypeMeasurement,
  typeMeasurementRollingKey,
  typeMeasurementStateKey,
} from "@/lib/trade-engine/type-measurement"

/**
 * The per-type measurement continues in realtime: each advance resumes from
 * the stored state, books only its new closes and leaves the Base gate's
 * buckets exactly as one continuous replay would have.
 */
const MINUTE = 60_000
const T0 = Date.UTC(2026, 9, 5, 0, 0, 0)
const context = { indicationSettings: {}, positionCostPct: 0.1 }

function wavyBars(count: number): any[] {
  const price = (index: number) => 100 * (1 + 0.006 * Math.sin(index / 7) + 0.002 * Math.sin(index / 2.3))
  return Array.from({ length: count }, (_, index) => {
    const open = price(Math.max(0, index - 1))
    const close = price(index)
    return { timestamp: T0 + index * MINUTE, open, close, high: Math.max(open, close) * 1.0015, low: Math.min(open, close) * 0.9985, volume: 1 }
  })
}

async function ringLength(connectionId: string): Promise<number> {
  const client = getRedisClient() as any
  const keys: string[] = []
  for (const type of ["direction", "move", "optimal", "auto", "active", "trend"]) {
    for (const direction of ["long", "short"]) keys.push(`pos_ring:${connectionId}:BTCUSDT:${type}:${direction}`)
  }
  let total = 0
  for (const key of keys) total += Number(await client.llen(key)) || 0
  return total
}

describe("per-type measurement continues in realtime", () => {
  const bars = wavyBars(300)
  beforeEach(() => { venueBars.current = bars })

  test("fresh, then resumed: buckets hold exactly the continuous replay's closes", async () => {
    const connectionId = `rolling-${Date.now()}-${Math.random()}`
    const split = bars[180].timestamp + MINUTE
    const first = await advanceTypeMeasurement({
      connectionId, symbol: "BTCUSDT", bars: bars.slice(0, 181), rangeStartMs: T0, rangeEndMs: split, context,
    })
    expect(first?.resumed).toBe(false)
    const state = parseTypeMeasurementState(await getRedisClient().get(typeMeasurementStateKey(connectionId, "BTCUSDT")))
    expect(state?.lastBarMs).toBe(bars[180].timestamp)

    const second = await advanceTypeMeasurement({
      connectionId, symbol: "BTCUSDT", bars: bars.slice(181 - 89), rangeStartMs: T0, rangeEndMs: bars[299].timestamp + MINUTE, context,
    })
    expect(second?.resumed).toBe(true)

    const continuous = await replayDirectIndicationTypes({
      symbol: "BTCUSDT",
      bars,
      rangeStartMs: T0,
      rangeEndMs: bars[299].timestamp + MINUTE,
      positionCostPct: 0.1,
      indicationSettings: {},
      // The module's protection: the adaptive Trend ladder, else PF-derived.
      protectionFor: ({ type, profitFactor, row }) => {
        const protection = (type === "trend"
          ? deriveAdaptiveTrendProtection(row?.metadata?.adaptiveTpRange?.factors, 0.1)
          : null) ?? deriveProtectionFromProfitFactor(profitFactor, 0.1)
        return { takeProfitPct: protection.takeProfitPct, stopLossPct: protection.stopLossPct }
      },
      // The measurement includes Auto, exactly as the module runs it.
      stepIndicatorsFor: (window, timeframes) => StepBasedIndicators.calculateSummariesAsync(window, timeframes, undefined, undefined),
    })
    expect(first!.result.closes.length + second!.result.closes.length).toBe(continuous.closes.length)
    expect(await ringLength(connectionId)).toBe(continuous.closes.length)

    // A repeated advance over the same bars books nothing new.
    const again = await advanceTypeMeasurement({
      connectionId, symbol: "BTCUSDT", bars: bars.slice(181 - 89), rangeStartMs: T0, rangeEndMs: bars[299].timestamp + MINUTE, context,
    })
    expect(again?.result.closes).toEqual([])
    expect(await ringLength(connectionId)).toBe(continuous.closes.length)
    const windows = await getPosWindowBatch(connectionId, "BTCUSDT", [{ indicationType: "direction", direction: "long" }], 25)
    expect(windows.get("direction|long")?.count ?? 0).toBeGreaterThan(0)
  })

  test("a held lock makes a concurrent advance stand back", async () => {
    const connectionId = `rolling-lock-${Date.now()}-${Math.random()}`
    await (getRedisClient() as any).set(`prehistoric:type_measurement_lock:${connectionId}:BTCUSDT`, "other", { PX: 60_000 })
    expect(await advanceTypeMeasurement({
      connectionId, symbol: "BTCUSDT", bars, rangeStartMs: T0, rangeEndMs: bars[299].timestamp + MINUTE, context,
    })).toBeNull()
  })

  test("the heartbeat refresh continues only a started measurement, after enough new minutes", async () => {
    const connectionId = `rolling-refresh-${Date.now()}-${Math.random()}`
    // Nothing started yet: the prehistoric run owns the first measurement.
    expect(await refreshTypeMeasurement(connectionId, "BTCUSDT", bars[299].timestamp + MINUTE)).toBeNull()

    await advanceTypeMeasurement({
      connectionId, symbol: "BTCUSDT", bars: bars.slice(0, 181), rangeStartMs: T0, rangeEndMs: bars[180].timestamp + MINUTE, context,
    })
    // Five new minutes are fewer than the refresh interval (10 minutes).
    expect(await refreshTypeMeasurement(connectionId, "BTCUSDT", bars[185].timestamp + MINUTE)).toBeNull()

    const refreshed = await refreshTypeMeasurement(connectionId, "BTCUSDT", bars[299].timestamp + MINUTE + 30_000)
    expect(refreshed?.resumed).toBe(true)
    const state = parseTypeMeasurementState(await getRedisClient().get(typeMeasurementStateKey(connectionId, "BTCUSDT")))
    expect(state?.lastBarMs).toBe(bars[299].timestamp)
    const rolling = await (getRedisClient() as any).hgetall(typeMeasurementRollingKey(connectionId))
    expect(Number(rolling.closes)).toBe(refreshed!.result.closes.length)
  })
})

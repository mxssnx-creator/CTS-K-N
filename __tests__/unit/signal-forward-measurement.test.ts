import { readFileSync } from "node:fs"
import path from "node:path"
import { getRedisClient } from "@/lib/redis-db"
import { typeMeasurementRollingKey } from "@/lib/prehistoric-type-measurement"
import { baseMeasuredHistoryRejection, getPosWindowBatch } from "@/lib/pos-history"
import {
  SIGNAL_FORWARD_MAX_HOLD_MS,
  SIGNAL_FORWARD_REPLAY_LAG_MS,
  SIGNAL_FORWARD_SUMMARY_MAX_SYMBOLS,
  advanceSignalForwardEntry,
  noteSignalForwardEntries,
  readSignalForwardSummary,
  resolveSignalForwardMeasurements,
  type SignalForwardEntry,
} from "@/lib/trade-engine/signal-forward-measurement"
import { simulatedCloseCostPercent } from "@/lib/trading-round-trip-cost"

/**
 * Signal has no historic replay. Without a measurement of its own, Signal
 * Sets could never collect the closes the Base gate requires (162 of 165 Base
 * Sets per symbol were Signal Sets awaiting history in the 2026-10-07 run).
 */
const M = 60_000
const T0 = Date.UTC(2026, 9, 8, 0, 0)
const bar = (minute: number, open: number, high: number, low: number, close: number) => ({ timestamp: T0 + minute * M, open, high, low, close })
const entry = (over: Partial<SignalForwardEntry> = {}): SignalForwardEntry => ({
  direction: "long", sourceId: "bingx-swap", entryTime: T0 + 10_000, entryPrice: 100,
  takeProfitPct: 1, stopLossPct: 0.6, positionCostPct: 0.1, checkedUntilMs: 0, ...over,
})

describe("advanceSignalForwardEntry", () => {
  it("ignores the entry minute and takes the target on a later bar, net of the real round trip", () => {
    const result = advanceSignalForwardEntry(entry(), [bar(0, 100, 105, 95, 100), bar(1, 100, 101.2, 99.8, 101)])
    expect(result.close?.reason).toBe("take_profit")
    expect(result.close?.grossPct).toBeCloseTo(1, 9)
    expect(result.close?.netPct).toBeCloseTo(1 - simulatedCloseCostPercent(0.1), 9)
  })

  it("a bar touching both levels is a stop; a gap beyond the stop exits at the open", () => {
    expect(advanceSignalForwardEntry(entry(), [bar(1, 100, 101.5, 99, 100)]).close?.reason).toBe("stop_loss")
    const gap = advanceSignalForwardEntry(entry({ direction: "short" }), [bar(1, 101, 101.2, 100.8, 101)]).close
    expect(gap?.reason).toBe("stop_loss")
    expect(gap?.exitPrice).toBe(101)
    expect(gap?.grossPct).toBeCloseTo(-1, 9)
  })

  it("keeps an undecided entry open, trails its cursor by the replay lag, and closes at the max hold", () => {
    const open = advanceSignalForwardEntry(entry(), [bar(1, 100, 100.2, 99.9, 100.1), bar(2, 100.1, 100.3, 99.9, 100.2)])
    expect(open.close).toBeNull()
    expect(open.covered).toBe(true)
    expect(open.entry.checkedUntilMs).toBe(T0 + 3 * M - SIGNAL_FORWARD_REPLAY_LAG_MS)
    // The next window starts at the cursor, so the already-checked minutes are re-read from it.
    const holdBars = Array.from({ length: 262 }, (_, i) => bar(1 + i, 100, 100.2, 99.9, 100.05))
    const closed = advanceSignalForwardEntry(open.entry, holdBars).close
    expect(closed?.reason).toBe("max_hold")
    expect(closed!.exitTime - closed!.entryTime).toBeGreaterThanOrEqual(SIGNAL_FORWARD_MAX_HOLD_MS)
  })

  it("reports an uncovered window and moves nothing when the bars do not reach the first minute to check", () => {
    const result = advanceSignalForwardEntry(entry(), [bar(5, 100, 100.2, 99.9, 100.1), bar(6, 100, 100.2, 99.9, 100.1)])
    expect(result.covered).toBe(false)
    expect(result.close).toBeNull()
    expect(result.entry.checkedUntilMs).toBe(0)
  })
})

describe("note → resolve → Base gate", () => {
  const signalRow = (direction: "long" | "short", sourceId: string) => ({
    type: "signal",
    direction,
    metadata: { signal: { stopLossPct: 0.8, takeProfitPct: 1.2, rewardRisk: 1.5, sourceIds: [sourceId], sourceId, agreement: 0.7, confidence: 0.7, generatedAt: T0 } },
  })

  it("books Signal closes into the bucket the Base gate reads", async () => {
    const connectionId = `sigfwd-${Date.now()}-${Math.random()}`
    const sources = ["a", "b", "c", "d", "e"]
    const noted = await noteSignalForwardEntries({
      connectionId, symbol: "BTCUSDT", price: 100, positionCostPct: 0.1, nowMs: T0 + 5_000,
      indications: [...sources.map((s) => signalRow("long", s)), signalRow("long", "a"), { type: "trend", direction: "long" }],
    })
    // One open measurement per (direction × source); the duplicate and the non-Signal row are ignored.
    expect(noted).toBe(5)
    const again = await noteSignalForwardEntries({ connectionId, symbol: "BTCUSDT", price: 101, positionCostPct: 0.1, indications: [signalRow("long", "a")] })
    expect(again).toBe(0)
    // A fall through every stop on the next bar closes all five.
    const closes = await resolveSignalForwardMeasurements({ connectionId, symbol: "BTCUSDT", bars: [bar(1, 100, 100.1, 98, 98.5)] })
    expect(closes).toHaveLength(5)
    const windows = await getPosWindowBatch(connectionId, "BTCUSDT", [{ indicationType: "signal", direction: "long" }], 25)
    const window = windows.get("signal|long")
    expect(window?.positionCostRatioCount).toBe(5)
    expect(baseMeasuredHistoryRejection(window, 5)).toBeNull()
    // Resolved measurements are removed; a new provider snapshot can open a new one.
    const nextSnapshot = { ...signalRow("long", "a"), metadata: { signal: { ...signalRow("long", "a").metadata.signal, generatedAt: T0 + M } } }
    expect(await noteSignalForwardEntries({ connectionId, symbol: "BTCUSDT", price: 98, positionCostPct: 0.1, indications: [nextSnapshot] })).toBe(1)
  })

  it("does not re-open a stopped-out measurement from the snapshot that opened it", async () => {
    const connectionId = `sigsnap-${Date.now()}-${Math.random()}`
    await noteSignalForwardEntries({ connectionId, symbol: "BTCUSDT", price: 100, positionCostPct: 0.1, nowMs: T0 + 5_000, indications: [signalRow("long", "a")] })
    expect(await resolveSignalForwardMeasurements({ connectionId, symbol: "BTCUSDT", bars: [bar(1, 100, 100.1, 98, 98.5)] })).toHaveLength(1)
    // The same evaluation on the next ticks is one observation, not five more.
    expect(await noteSignalForwardEntries({ connectionId, symbol: "BTCUSDT", price: 98.5, positionCostPct: 0.1, nowMs: T0 + 2 * M, indications: [signalRow("long", "a")] })).toBe(0)
  })

  it("grades a minute that one batch missed when a later batch returns it", async () => {
    const connectionId = `siggap-${Date.now()}-${Math.random()}`
    await noteSignalForwardEntries({ connectionId, symbol: "BTCUSDT", price: 100, positionCostPct: 0.1, nowMs: T0 + 5_000, indications: [signalRow("long", "a")] })
    // Minute 3 is missing from the first batch; the cursor trails it by the replay lag, so it is not skipped.
    const first = [bar(1, 100, 100.2, 99.9, 100.1), bar(2, 100.1, 100.2, 99.9, 100.1), bar(4, 100.1, 100.2, 99.9, 100.1), bar(5, 100.1, 100.2, 99.9, 100.1)]
    expect(await resolveSignalForwardMeasurements({ connectionId, symbol: "BTCUSDT", bars: first })).toHaveLength(0)
    const second = [bar(1, 100, 100.2, 99.9, 100.1), bar(2, 100.1, 100.2, 99.9, 100.1), bar(3, 100.1, 100.2, 98, 98.5), bar(4, 100.1, 100.2, 99.9, 100.1), bar(5, 100.1, 100.2, 99.9, 100.1)]
    const closes = await resolveSignalForwardMeasurements({ connectionId, symbol: "BTCUSDT", bars: second })
    expect(closes).toHaveLength(1)
    expect(closes[0].reason).toBe("stop_loss")
  })

  it("counts Signal closes in the realtime rolling counters the report reads", async () => {
    const connectionId = `sigroll-${Date.now()}-${Math.random()}`
    await noteSignalForwardEntries({ connectionId, symbol: "BTCUSDT", price: 100, positionCostPct: 0.1, nowMs: T0 + 5_000, indications: [signalRow("long", "a")] })
    await resolveSignalForwardMeasurements({ connectionId, symbol: "BTCUSDT", bars: [bar(1, 100, 100.1, 98, 98.5)] })
    const client = getRedisClient() as any
    const rolling = await client.hgetall(typeMeasurementRollingKey(connectionId))
    expect(rolling).toMatchObject({ closes: "1", "n:signal:long": "1", "l:signal:long": "1" })
  })

  it("is wired into realtime Signal processing and the measurement heartbeat", () => {
    const processor = readFileSync(path.join(process.cwd(), "lib/trade-engine/indication-processor-fixed.ts"), "utf8")
    const measurement = readFileSync(path.join(process.cwd(), "lib/trade-engine/type-measurement.ts"), "utf8")
    expect(processor).toContain("noteSignalForwardEntries({")
    expect(measurement).toContain("await resolveSignalForwardMeasurements({")
  })
})

describe("resolve: exactly-once booking and expiry", () => {
  const signalRow = (direction: "long" | "short", sourceId: string) => ({
    type: "signal",
    direction,
    metadata: { signal: { stopLossPct: 0.8, takeProfitPct: 1.2, rewardRisk: 1.5, sourceIds: [sourceId], sourceId, agreement: 0.7, confidence: 0.7, generatedAt: T0 } },
  })

  it("books a close once, even when two passes resolve the same bars", async () => {
    const connectionId = `sigonce-${Date.now()}-${Math.random()}`
    await noteSignalForwardEntries({ connectionId, symbol: "BTCUSDT", price: 100, positionCostPct: 0.1, nowMs: T0 + 5_000, indications: [signalRow("long", "a")] })
    const stop = [bar(1, 100, 100.1, 98, 98.5)]
    expect(await resolveSignalForwardMeasurements({ connectionId, symbol: "BTCUSDT", bars: stop })).toHaveLength(1)
    expect(await resolveSignalForwardMeasurements({ connectionId, symbol: "BTCUSDT", bars: stop })).toHaveLength(0)
    const windows = await getPosWindowBatch(connectionId, "BTCUSDT", [{ indicationType: "signal", direction: "long" }], 25)
    expect(windows.get("signal|long")?.positionCostRatioCount).toBe(1)
  })

  it("expires an entry unbooked once bars past its cap never reached its first minute", async () => {
    const connectionId = `sigexp-${Date.now()}-${Math.random()}`
    await noteSignalForwardEntries({ connectionId, symbol: "BTCUSDT", price: 100, positionCostPct: 0.1, nowMs: T0 + 5_000, indications: [signalRow("long", "a")] })
    // Bars start long after the entry: nothing can be graded honestly, so nothing is booked.
    const late = [bar(400, 100, 100.1, 99.9, 100), bar(401, 100, 100.1, 99.9, 100)]
    expect(await resolveSignalForwardMeasurements({ connectionId, symbol: "BTCUSDT", bars: late })).toHaveLength(0)
    expect((await readSignalForwardSummary(connectionId, ["BTCUSDT"])).open).toBe(0)
    const windows = await getPosWindowBatch(connectionId, "BTCUSDT", [{ indicationType: "signal", direction: "long" }], 25)
    expect(windows.get("signal|long")?.positionCostRatioCount ?? 0).toBe(0)
  })

  it("keeps an entry whose window does not yet reach its first minute, for a later pass", async () => {
    const connectionId = `sigkeep-${Date.now()}-${Math.random()}`
    await noteSignalForwardEntries({ connectionId, symbol: "BTCUSDT", price: 100, positionCostPct: 0.1, nowMs: T0 + 5_000, indications: [signalRow("long", "a")] })
    expect(await resolveSignalForwardMeasurements({ connectionId, symbol: "BTCUSDT", bars: [bar(3, 100, 100.1, 99.9, 100)] })).toHaveLength(0)
    expect((await readSignalForwardSummary(connectionId, ["BTCUSDT"])).open).toBe(1)
    expect(await resolveSignalForwardMeasurements({ connectionId, symbol: "BTCUSDT", bars: [bar(1, 100, 100.1, 98, 98.5)] })).toHaveLength(1)
  })
})

describe("readSignalForwardSummary (stats endpoint)", () => {
  const signalRow = (direction: "long" | "short", sourceId: string) => ({
    type: "signal",
    direction,
    metadata: { signal: { stopLossPct: 0.8, takeProfitPct: 1.2, rewardRisk: 1.5, sourceIds: [sourceId], sourceId, agreement: 0.7, confidence: 0.7, generatedAt: T0 } },
  })

  it("reports open entries and measured closes per symbol and direction, without writing", async () => {
    const connectionId = `sigsum-${Date.now()}-${Math.random()}`
    await noteSignalForwardEntries({
      connectionId, symbol: "BTCUSDT", price: 100, positionCostPct: 0.1, nowMs: T0 + 5_000,
      indications: [signalRow("long", "a"), signalRow("long", "b"), signalRow("short", "a")],
    })
    await noteSignalForwardEntries({
      connectionId, symbol: "ETHUSDT", price: 50, positionCostPct: 0.1, nowMs: T0 + 5_000,
      indications: [signalRow("long", "a")],
    })
    // Only the BTC long entries close: their stop (99.2) is touched, while the
    // short's stop (100.8) and target (98.8) are not.
    await resolveSignalForwardMeasurements({ connectionId, symbol: "BTCUSDT", bars: [bar(1, 100, 100.1, 99.0, 99.5)] })
    const summary = await readSignalForwardSummary(connectionId, ["BTCUSDT", "ETHUSDT", "BTCUSDT"])
    expect(summary.symbols).toBe(2)
    expect(summary.bySymbol.BTCUSDT).toEqual({ open: 1, closedLong: 2, closedShort: 0 })
    expect(summary.bySymbol.ETHUSDT).toEqual({ open: 1, closedLong: 0, closedShort: 0 })
    expect(summary.open).toBe(2)
    expect(summary.closedLong).toBe(2)
    expect(summary.closedShort).toBe(0)
    // Read-only: a second read returns the same numbers.
    expect(await readSignalForwardSummary(connectionId, ["BTCUSDT", "ETHUSDT"])).toEqual(summary)
  })

  it("bounds the number of symbols read per call", async () => {
    const many = Array.from({ length: SIGNAL_FORWARD_SUMMARY_MAX_SYMBOLS + 10 }, (_, i) => `SYM${i}USDT`)
    const summary = await readSignalForwardSummary(`sigbound-${Date.now()}-${Math.random()}`, many)
    expect(summary.symbols).toBe(SIGNAL_FORWARD_SUMMARY_MAX_SYMBOLS)
  })

  it("is wired into the progression stats payload next to the type measurement", () => {
    const route = readFileSync(path.join(process.cwd(), "app/api/connections/progression/[id]/stats/route.ts"), "utf8")
    expect(route).toContain("signalForward:          signalForwardSummary,")
    expect(route).toContain("readSignalForwardSummary(\n      connectionId,\n      runtimeSymbolResolution.symbols,")
  })
})

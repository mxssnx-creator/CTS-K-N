import { readFileSync } from "node:fs"
import path from "node:path"
import { baseMeasuredHistoryRejection, getPosWindowBatch } from "@/lib/pos-history"
import {
  SIGNAL_FORWARD_MAX_HOLD_MS,
  advanceSignalForwardEntry,
  noteSignalForwardEntries,
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

  it("keeps an undecided entry open, remembers where it stopped, and closes at the max hold", () => {
    const open = advanceSignalForwardEntry(entry(), [bar(1, 100, 100.2, 99.9, 100.1), bar(2, 100.1, 100.3, 99.9, 100.2)])
    expect(open.close).toBeNull()
    expect(open.entry.checkedUntilMs).toBe(T0 + 3 * M)
    const holdBars = Array.from({ length: 260 }, (_, i) => bar(3 + i, 100, 100.2, 99.9, 100.05))
    const closed = advanceSignalForwardEntry(open.entry, holdBars).close
    expect(closed?.reason).toBe("max_hold")
    expect(closed!.exitTime - closed!.entryTime).toBeGreaterThanOrEqual(SIGNAL_FORWARD_MAX_HOLD_MS)
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
    // Resolved measurements are removed; new entries can be noted again.
    expect(await noteSignalForwardEntries({ connectionId, symbol: "BTCUSDT", price: 98, positionCostPct: 0.1, indications: [signalRow("long", "a")] })).toBe(1)
  })

  it("is wired into realtime Signal processing and the measurement heartbeat", () => {
    const processor = readFileSync(path.join(process.cwd(), "lib/trade-engine/indication-processor-fixed.ts"), "utf8")
    const measurement = readFileSync(path.join(process.cwd(), "lib/trade-engine/type-measurement.ts"), "utf8")
    expect(processor).toContain("noteSignalForwardEntries({")
    expect(measurement).toContain("await resolveSignalForwardMeasurements({")
  })
})

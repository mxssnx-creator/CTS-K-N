import { getRedisClient } from "@/lib/redis-db"
import { DEFAULT_SIGNAL_INDICATION_SETTINGS, recordSignalPerformanceOutcome } from "@/lib/signal-indication"
import { findDeactivatedLiveSetKeys, recordLiveConfigOutcome } from "@/lib/live-config-performance"
import { clearResultLedgerCache, ledgerEntriesKey, ledgerMetaKey } from "@/lib/results/ledger"
import { StrategyCoordinator } from "@/lib/strategy-coordinator"

let sequence = 0
const uniqueConnection = (name: string) => `live-adjust-${name}-${Date.now()}-${sequence++}`

describe("Signal quality from a real close", () => {
  async function samples(connectionId: string): Promise<any[]> {
    const raw = await getRedisClient().lrange(`signal:performance:${connectionId}:okx-swap:BTCUSDT:long:samples`, 0, -1)
    return (raw || []).map((value: string) => JSON.parse(value))
  }

  const input = (connectionId: string, positionId: string, pnlPctIsNet: boolean) => ({
    connectionId,
    positionId,
    symbol: "BTCUSDT",
    direction: "long" as const,
    pnl: 0.3,
    pnlPct: 0.3,
    pnlPctIsNet,
    positionCostPct: 0.1,
    sourceIds: ["okx-swap"],
    liveExchange: pnlPctIsNet,
    settings: DEFAULT_SIGNAL_INDICATION_SETTINGS,
    closedAt: 1_000,
  })

  test("a venue-net real result is not charged the PositionCost a second time", async () => {
    const connectionId = uniqueConnection("signal-net")
    await recordSignalPerformanceOutcome(input(connectionId, "real-1", true))
    const [sample] = await samples(connectionId)
    expect(sample.netMarketMovePct).toBeCloseTo(0.3, 12)
  })

  test("a paper result still pays its modelled PositionCost", async () => {
    const connectionId = uniqueConnection("signal-paper")
    await recordSignalPerformanceOutcome(input(connectionId, "paper-1", false))
    const [sample] = await samples(connectionId)
    expect(sample.netMarketMovePct).toBeLessThan(0.3)
  })
})

describe("Sets switched off by real losses leave the Live stage", () => {
  const row = (connectionId: string, n: number, setKey: string) => ({
    id: `p${n}`, connectionId, symbol: "BTCUSDT", direction: "long", setKey,
    executionMode: "live", executionIntent: "main", status: "closed", orderId: `venue${n}`,
    executedQuantity: 0.001, remainingQuantity: 0, realizedPnlComplete: true,
    realizedPnlSource: n % 2 === 0 ? "exchange_settlement" : "exchange_settlement_deferred",
    realizedPnL: -1, closedAt: 1_000 + n,
  })

  test("a Set with a negative full window is found, a healthy one is not", async () => {
    const connectionId = uniqueConnection("loss-gate")
    const losing = "BTCUSDT:direction:long#row_real#row_live"
    // The default window is 12; late (deferred) settlements count as well.
    for (let n = 0; n < 12; n++) await recordLiveConfigOutcome(row(connectionId, n, losing))
    const found = await findDeactivatedLiveSetKeys(connectionId, [
      { symbol: "BTCUSDT", direction: "long", setKey: losing, executionIntents: ["main", "preset"] },
      { symbol: "BTCUSDT", direction: "long", setKey: "BTCUSDT:move:long#row_real#row_live", executionIntents: ["main", "preset"] },
      { symbol: "BTCUSDT", direction: "short", setKey: losing, executionIntents: ["main"] },
    ])
    expect([...found]).toEqual([losing])
  })
})

describe("position context of a live connection", () => {
  test("recent wins and losses are the settled real closes, not pseudo results", async () => {
    const connectionId = uniqueConnection("context")
    const now = Date.now()
    const entry = (id: string, pnl: number | null, closedAgoMs: number, settled = true) => JSON.stringify({
      id, sym: "BTCUSDT", dir: "long", opened: now - closedAgoMs - 60_000, closed: now - closedAgoMs,
      status: "closed", qty: 1, entry: 100, notional: 100, lev: 1, sl: 0.6, tp: 1, pnl, fees: 0,
      settled, pnlSource: "exchange_settlement", reason: "", type: "direction", lane: "", variant: "default",
      intent: "main", slip: null, exit: 101, oid: `o-${id}`, coid: "", setKey: "BTCUSDT:direction:long",
    })
    const client = getRedisClient()
    await client.hset(ledgerEntriesKey(connectionId), {
      w1: entry("w1", 1.5, 60_000),
      w2: entry("w2", 0.5, 120_000),
      l1: entry("l1", -2, 180_000),
      pending: entry("pending", null, 30_000, false),
      old: entry("old", -5, 30 * 60 * 60 * 1000),
    })
    await client.hset(ledgerMetaKey(connectionId), { complete: "1", updatedAt: String(now) })
    clearResultLedgerCache(connectionId)
    const coordinator = new StrategyCoordinator(connectionId) as any
    coordinator.isLiveTradingEnabledForConnection = async () => true
    const context = await coordinator.getPositionContext()
    expect(context).toMatchObject({ liveTradingEnabled: true, lastWins: 2, lastLosses: 1, prevPosCount: 3, prevLosses: 1 })
  })
})

describe("real results per strategy Set", () => {
  test("the ledger keeps the exact executed Set next to its Base Set and groups by either", async () => {
    const { toLedgerEntry } = await import("@/lib/results/ledger")
    const { buildResultsBookResponse } = await import("@/lib/results/response")
    const row = (id: string, setKey: string, pnl: number) => ({
      id, symbol: "BTCUSDT", direction: "long", status: "closed", executedQuantity: 1, averageExecutionPrice: 100,
      createdAt: 1, closedAt: 2, realizedPnL: pnl, realizedPnlComplete: true, realizedPnlSource: "exchange_settlement",
      setKey, parentSetKey: "BTCUSDT:direction:long",
    })
    const a = toLedgerEntry("a", row("a", "BTCUSDT:direction:long#row_real#row_live", 2))
    const b = toLedgerEntry("b", row("b", "BTCUSDT:direction:long#block:2", -1))
    expect(a).toMatchObject({ setKey: "BTCUSDT:direction:long", exactSetKey: "BTCUSDT:direction:long#row_real#row_live" })
    const ledger = { connectionId: "c", entries: [a, b], funnel: {}, meta: { updatedAt: 1, keys: 2, remaining: 0, complete: true } }
    const bySet = buildResultsBookResponse(ledger, { group: "set" }, 10).groups as Record<string, any>
    expect(Object.keys(bySet).sort()).toEqual(["BTCUSDT:direction:long#block:2", "BTCUSDT:direction:long#row_real#row_live"])
    const byBase = buildResultsBookResponse(ledger, { group: "baseSet" }, 10).groups as Record<string, any>
    expect(Object.keys(byBase)).toEqual(["BTCUSDT:direction:long"])
  })
})

describe("profitable hours", () => {
  test("settled results are bucketed by the UTC hour of their close", async () => {
    const { computeResultBook } = await import("@/lib/results/ledger")
    const hour = 3_600_000
    const entry = (id: string, pnl: number | null, closed: number) => ({
      id, sym: "BTCUSDT", dir: "long", opened: closed - 60_000, closed, status: "closed", qty: 1, entry: 100,
      notional: 100, lev: 1, sl: 0.6, tp: 1, pnl, fees: 0, settled: pnl !== null, pnlSource: "", reason: "",
      type: "", lane: "", variant: "", intent: "main", slip: null, exit: 0, oid: id, coid: "", setKey: "",
    })
    const book = computeResultBook([
      entry("a", 1, 10 * hour + 5), entry("b", -0.4, 10 * hour + 50), // hour 10: +0.6
      entry("c", -1, 11 * hour + 1),                                    // hour 11: -1
      entry("d", 0.2, 13 * hour + 9), entry("e", 0.3, 13 * hour + 99),  // hour 13: +0.5
      entry("pending", null, 14 * hour),                               // unsettled: no hour
    ] as any)
    expect(book.hours).toEqual({ active: 3, profitable: 2, losing: 1, profitableShare: (2 / 3) * 100, closesPerActiveHour: 5 / 3 })
    expect(computeResultBook([]).hours).toEqual({ active: 0, profitable: 0, losing: 0, profitableShare: null, closesPerActiveHour: null })
  })
})

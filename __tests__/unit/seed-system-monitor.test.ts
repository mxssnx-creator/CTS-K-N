import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { NextRequest } from "next/server"
import { buildEnginePerformance, DRAWDOWN_LOOKBACK_DAYS } from "@/app/api/engine-metrics/engine-performance"
import {
  buildSeedPerformance,
  buildSeedStats,
  normalizeSeedLog,
  seedLogGroup,
  seedLogMatchesFilter,
} from "@/components/dashboard/seed-system-data"
import type { LedgerEntry, ResultLedger } from "@/lib/results/ledger"

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0)
const MINUTE = 60_000

function entry(id: string, pnl: number | null, closedMinutesAgo: number, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id, sym: "BTCUSDT", dir: "long", opened: NOW - (closedMinutesAgo + 10) * MINUTE, closed: NOW - closedMinutesAgo * MINUTE,
    status: "closed", qty: 1, entry: 100, notional: 100, lev: 10, sl: 0, tp: 0,
    pnl, fees: 0, settled: pnl !== null, pnlSource: "exchange", reason: "", type: "direction", lane: "", variant: "",
    intent: "main", slip: null, exit: 101, oid: "", coid: "", setKey: "",
    ...overrides,
  }
}

function ledger(entries: LedgerEntry[], complete = true): ResultLedger {
  return { connectionId: "conn-seed", entries, funnel: {}, meta: { updatedAt: NOW, keys: entries.length, remaining: 0, complete } }
}

describe("engine-metrics realized performance", () => {
  test("PF, win rate and drawdown come from settled ledger entries", () => {
    const performance = buildEnginePerformance(ledger([
      entry("a", 10, 120),
      entry("b", -4, 90),
      entry("c", -2, 60),
      entry("d", 8, 30),
      entry("pending", null, 20),
    ]), NOW)

    expect(performance.available).toBe(true)
    expect(performance.settledTrades).toBe(4)
    expect(performance.accountingPending).toBe(1)
    expect(performance.profitFactor).toBeCloseTo(18 / 6, 6)
    expect(performance.profitFactorInfinite).toBe(false)
    expect(performance.winRate).toBeCloseTo(50, 6)
    // Equity 10 → 6 → 4 → 12: deepest drop 6 USDT, under water from 90 to 30 minutes ago.
    expect(performance.maxDrawdownUsd).toBeCloseTo(6, 6)
    expect(performance.maxDrawdownMinutes).toBe(60)
    expect(performance.drawdownLookbackDays).toBe(DRAWDOWN_LOOKBACK_DAYS)
    expect(performance.reason).toBeNull()
  })

  test("no ledger and no settled trades give explicit reasons instead of zeros", () => {
    const missing = buildEnginePerformance(null, NOW)
    expect(missing).toMatchObject({ available: false, profitFactor: null, winRate: null, maxDrawdownUsd: null, maxDrawdownMinutes: null })
    expect(missing.reason).toMatch(/no results ledger/i)

    const unsettled = buildEnginePerformance(ledger([entry("p", null, 5)]), NOW)
    expect(unsettled).toMatchObject({ available: true, settledTrades: 0, profitFactor: null, winRate: null, maxDrawdownUsd: null })
    expect(unsettled.reason).toMatch(/no settled trades/i)
  })

  test("only winners mark the profit factor as unbounded", () => {
    const performance = buildEnginePerformance(ledger([entry("w1", 3, 10), entry("w2", 1, 5)]), NOW)
    expect(performance.profitFactor).toBeNull()
    expect(performance.profitFactorInfinite).toBe(true)
    expect(performance.maxDrawdownUsd).toBe(0)
  })

  test("GET requires a connection and answers with the performance block", async () => {
    const { GET } = await import("@/app/api/engine-metrics/route")
    const missing = await GET(new NextRequest("http://localhost/api/engine-metrics"))
    expect(missing.status).toBe(400)

    const response = await GET(new NextRequest(`http://localhost/api/engine-metrics?connectionId=seed-no-ledger-${process.pid}`))
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.performance).toMatchObject({ source: "results-ledger", available: false, profitFactor: null })
    expect(body).not.toHaveProperty("metrics")
  })
})

describe("Seed 2.0 dialog data", () => {
  test("SystemLogger categories map onto the dialog's log groups", () => {
    expect(seedLogGroup("trade_engine")).toBe("engine")
    expect(seedLogGroup("trade-engine")).toBe("engine")
    expect(seedLogGroup("positions")).toBe("engine")
    expect(seedLogGroup("market_data")).toBe("data")
    expect(seedLogGroup("redis")).toBe("data")
    expect(seedLogGroup("api")).toBe("overall")
    expect(seedLogGroup("connections")).toBe("overall")

    const error = normalizeSeedLog({ id: "1", level: "error", category: "api", message: "boom", metadata: { endpoint: "/x" } }, 0)
    const engine = normalizeSeedLog({ id: "2", level: "info", category: "trade_engine", message: "tick" }, 1)
    expect(error.details).toEqual({ endpoint: "/x" })
    expect(seedLogMatchesFilter(error, "errors")).toBe(true)
    expect(seedLogMatchesFilter(error, "overall")).toBe(true)
    expect(seedLogMatchesFilter(engine, "engine")).toBe(true)
    expect(seedLogMatchesFilter(engine, "errors")).toBe(false)
    expect(seedLogMatchesFilter(engine, "all")).toBe(true)
  })

  test("the Prehistoric tile reads processed historic symbols, not the active basket", () => {
    const stats = buildSeedStats(
      { trading: { livePositions: 2 }, system: { memoryUsed: 512 * 1024 * 1024, memoryTotal: 1024 * 1024 * 1024 } },
      { symbolsActive: 12, prehistoricData: { symbolsProcessed: 5 }, strategiesEvaluated: 40, counts: { strategyCycles: 9, indicationCycles: 10 } },
      buildSeedPerformance(null, null),
    )
    expect(stats.data.prehistoricSymbols).toBe(5)
    expect(stats.evaluationsSnapshot).toBe(40)
    expect(stats.system.memoryUsedMb).toBe(512)
    expect(stats.errors.total).toBeNull()
    expect(stats.performance.reason).toMatch(/select a connection/i)
  })

  test("the engine-metrics performance block is read from its real shape", () => {
    const performance = buildSeedPerformance("conn-seed", {
      performance: { available: true, complete: true, profitFactor: 1.8, winRate: 55, maxDrawdownUsd: 3.2, maxDrawdownMinutes: 42, settledTrades: 20, drawdownLookbackDays: 3, reason: null },
    })
    expect(performance).toMatchObject({ profitFactor: 1.8, winRate: 55, maxDrawdownUsd: 3.2, drawdownMinutes: 42, settledTrades: 20, reason: null })
    expect(buildSeedPerformance("conn-seed", null).reason).toMatch(/could not be loaded/i)
  })

  test("the dialog requests engine-metrics for the selected connection, in parallel, on a gated poll", () => {
    const dialog = readFileSync(resolve(process.cwd(), "components/dashboard/seed-system-dialog.tsx"), "utf8")
    expect(dialog).toContain("/api/engine-metrics?connectionId=${encodeURIComponent(connectionId)}")
    expect(dialog).toContain("await Promise.all([")
    expect(dialog).toContain("usePoll(fetchStats")
    const interval = Number(dialog.match(/const SEED_POLL_INTERVAL_MS = ([\d_]+)/)?.[1].replace(/_/g, ""))
    expect(interval).toBeGreaterThanOrEqual(5_000)
    expect(dialog).not.toContain('fetch("/api/engine-metrics"')
    expect(dialog).not.toContain("details: log.details")
    expect(dialog).not.toContain("functionalOverview.symbolsActive")
  })
})

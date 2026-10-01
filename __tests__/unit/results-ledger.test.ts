import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  advanceResultsLedger, classifyRow, clearResultLedgerCache, computeResultBook, groupResultBooks,
  ledgerEntriesKey, ledgerSkipKey, lifetimeSummaryFromLedger, readResultLedger, toLedgerEntry,
} from "@/lib/results/ledger"
import { simulatedBookForDisplay, emptyPositionBookStats } from "@/lib/position-book-stats"

const CONN = "bingx-x02"
let seq = 0
const real = (over: Record<string, any> = {}): Record<string, any> => ({
  status: "closed", executionMode: "live", orderId: `2100${++seq}`, symbol: "SOLUSDT", direction: "long",
  executedQuantity: "10", closedQuantity: "10", averageExecutionPrice: "100", entryPrice: "100", leverage: "50",
  stopLoss: "0.5", takeProfit: "0.333", realizedPnL: "0.05", realizedPnlComplete: "true", tradingFees: "0.01",
  createdAt: "1790000000000", closedAt: "1790000300000", closeReason: "take_profit", indicationType: "direction",
  system_tracking_id: `sys-${CONN}-a${seq}`, ...over,
})
const simulated = (over: Record<string, any> = {}) => real({ status: "simulated", orderId: `sim-${++seq}`, realizedPnL: "-3456315674", ...over })
const neverTraded = (over: Record<string, any> = {}) => ({ status: "closed", symbol: "ETHUSDT", executedQuantity: "0", closeReason: "placement_stuck_no_venue_handle", system_tracking_id: `sys-${CONN}-n${++seq}`, ...over })

/** An in-memory stand-in for the Redis commands the ledger uses. */
function fakeRedis(rows: Record<string, Record<string, any>>) {
  const hashes = new Map<string, Record<string, string>>(); const sets = new Map<string, Set<string>>(); const kv = new Map<string, string>()
  for (const [id, row] of Object.entries(rows)) hashes.set(`live_positions:${CONN}:${id}`, Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v)])))
  const getSet = (k: string) => sets.get(k) || sets.set(k, new Set()).get(k)!
  return {
    hashes, sets, kv,
    keys: async (pattern: string) => [...hashes.keys()].filter((k) => k.startsWith(pattern.replace("*", ""))),
    hgetall: async (k: string) => hashes.get(k) || null,
    hset: async (k: string, obj: Record<string, string>) => { hashes.set(k, { ...(hashes.get(k) || {}), ...obj }); return 1 },
    smembers: async (k: string) => [...getSet(k)],
    sadd: async (k: string, v: string) => { const s = getSet(k); const had = s.has(v); s.add(v); return had ? 0 : 1 },
    srem: async (k: string, v: string) => (getSet(k).delete(v) ? 1 : 0),
    hincrby: async (k: string, f: string, n: number) => { const h = hashes.get(k) || {}; h[f] = String(Number(h[f] || 0) + n); hashes.set(k, h); return Number(h[f]) },
    set: async (k: string, v: string, o?: { NX?: boolean }) => { if (o?.NX && kv.has(k)) return null; kv.set(k, v); return "OK" },
    del: async (k: string) => (kv.delete(k) ? 1 : 0),
  }
}

beforeEach(() => { seq = 0; clearResultLedgerCache() })

describe("what counts as a result", () => {
  test("a filled, real, own row is executed; the rest is classified by why it is not", () => {
    expect(classifyRow(real(), CONN)).toEqual({ kind: "executed" })
    expect(classifyRow(simulated(), CONN)).toEqual({ kind: "simulated" })
    expect(classifyRow(real({ system_tracking_id: "sys-bingx-x01-zz" }), CONN)).toEqual({ kind: "foreign" })
    expect(classifyRow(neverTraded(), CONN)).toEqual({ kind: "never_traded", reason: "closed/placement_stuck_no_venue_handle" })
    expect(classifyRow(neverTraded({ status: "rejected", closeReason: "", statusReason: "min notional" }), CONN)).toEqual({ kind: "never_traded", reason: "rejected/min notional" })
    expect(classifyRow({ status: "placed", executedQuantity: "0", system_tracking_id: `sys-${CONN}-p` }, CONN)).toEqual({ kind: "pending" })
  })
  test("an entry carries the settled pnl, and null while the accounting is pending", () => {
    const e = toLedgerEntry("a", real())
    expect(e).toMatchObject({ sym: "SOLUSDT", dir: "long", status: "closed", qty: 10, notional: 1000, lev: 50, sl: 0.5, pnl: 0.05, settled: true, reason: "take_profit", type: "direction" })
    const pending = toLedgerEntry("b", real({ realizedPnlComplete: "false", realizedPnL: "0" }))
    expect(pending).toMatchObject({ pnl: null, settled: false })
  })
})

describe("the result book is computed from filled rows only", () => {
  test("X01's measured result: 121 wins, 129 losses, 36 flat counted as such; PF and win rate from decided trades", () => {
    const entries = [
      ...Array.from({ length: 3 }, (_, i) => toLedgerEntry(`w${i}`, real({ realizedPnL: "0.10" }))),
      ...Array.from({ length: 2 }, (_, i) => toLedgerEntry(`l${i}`, real({ realizedPnL: "-0.15" }))),
      toLedgerEntry("f", real({ realizedPnL: "0" })),
      toLedgerEntry("p", real({ realizedPnlComplete: "false", realizedPnL: "0" })),
      toLedgerEntry("o", real({ status: "open", closedAt: "", realizedPnL: "", realizedPnlComplete: "" })),
    ]
    const b = computeResultBook(entries)
    expect(b).toMatchObject({ executed: 8, open: 1, closed: 7, settled: 6, accountingPending: 1, wins: 3, losses: 2, flat: 1 })
    expect(b.net).toBeCloseTo(0.3 - 0.3, 10)
    expect(b.grossProfit).toBeCloseTo(0.3); expect(b.grossLoss).toBeCloseTo(0.3)
    expect(b.profitFactor).toBeCloseTo(1); expect(b.winRate).toBeCloseTo(60); expect(b.expectancy).toBeCloseTo(0)
    expect(b.largestWin).toBeCloseTo(0.1); expect(b.largestLoss).toBeCloseTo(-0.15)
  })
  test("windows use the close time for closed rows", () => {
    const e = [toLedgerEntry("a", real({ closedAt: "1000", createdAt: "900" })), toLedgerEntry("b", real({ closedAt: "5000", createdAt: "4900" }))]
    expect(computeResultBook(e, { since: 3000 }).closed).toBe(1)
    expect(computeResultBook(e, { until: 3000 }).closed).toBe(1)
  })
  test("groups for the live-against-simulation evaluation", () => {
    const e = [toLedgerEntry("a", real({ indicationType: "direction", realizedPnL: "0.1" })), toLedgerEntry("b", real({ indicationType: "move", realizedPnL: "-0.1" }))]
    const g = groupResultBooks(e, (x) => x.type)
    expect(g.direction.net).toBeCloseTo(0.1); expect(g.move.net).toBeCloseTo(-0.1)
  })
})

describe("the ledger is built from the rows, incrementally and idempotently", () => {
  test("X02-like data: thousands of simulated and never-traded rows next to a few filled ones: only the filled ones are results", async () => {
    const rows: Record<string, any> = {}
    for (let i = 0; i < 400; i++) rows[`sim${i}`] = simulated()
    for (let i = 0; i < 300; i++) rows[`nt${i}`] = neverTraded()
    for (let i = 0; i < 12; i++) rows[`r${i}`] = real({ realizedPnL: i % 3 === 0 ? "-0.4" : "0.1" })
    rows.pend = real({ realizedPnlComplete: "false", realizedPnL: "0" })
    rows.foreign = real({ system_tracking_id: "sys-bingx-x01-q" })
    const redis = fakeRedis(rows)
    const run = await advanceResultsLedger(redis, CONN, { budgetMs: 5000 })
    expect(run).toMatchObject({ keys: 714, complete: true, remaining: 0, added: 13 })
    const ledger = (await readResultLedger(redis, CONN))!
    expect(ledger.entries).toHaveLength(13)
    expect(ledger.funnel.simulated).toBe(400)
    expect(ledger.funnel["never:closed/placement_stuck_no_venue_handle"]).toBe(300)
    expect(ledger.funnel.foreign).toBe(1)
    const book = computeResultBook(ledger.entries)
    expect(book).toMatchObject({ executed: 13, closed: 13, settled: 12, accountingPending: 1, wins: 8, losses: 4 })
    expect(book.net).toBeCloseTo(8 * 0.1 - 4 * 0.4, 9)
    expect(Math.abs(book.net)).toBeLessThan(10) // no -3.46 billion from the simulated rows
  })
  test("a second pass changes nothing and the funnel is not counted twice", async () => {
    const redis = fakeRedis({ a: real(), s: simulated(), n: neverTraded() })
    await advanceResultsLedger(redis, CONN)
    clearResultLedgerCache()
    const second = await advanceResultsLedger(redis, CONN)
    expect(second).toMatchObject({ added: 0, scanned: 0, complete: true })
    const ledger = (await readResultLedger(redis, CONN))!
    expect(ledger.entries).toHaveLength(1); expect(ledger.funnel.simulated).toBe(1)
  })
  test("a row whose accounting settles later is updated, not frozen at its close value (the lifetime summary's flaw)", async () => {
    const redis = fakeRedis({ a: real({ realizedPnlComplete: "false", realizedPnL: "0" }) })
    await advanceResultsLedger(redis, CONN); clearResultLedgerCache()
    expect(computeResultBook((await readResultLedger(redis, CONN))!.entries)).toMatchObject({ settled: 0, accountingPending: 1, net: 0 })
    redis.hashes.set(`live_positions:${CONN}:a`, { ...redis.hashes.get(`live_positions:${CONN}:a`)!, realizedPnlComplete: "true", realizedPnL: "-0.25" })
    const refreshed = await advanceResultsLedger(redis, CONN); clearResultLedgerCache()
    expect(refreshed.refreshed).toBe(1)
    expect(computeResultBook((await readResultLedger(redis, CONN))!.entries)).toMatchObject({ settled: 1, accountingPending: 0, losses: 1 })
    expect(redis.sets.get(`results:ledger:v2:${CONN}:open`)!.size).toBe(0) // final now: no longer re-read
  })
  test("the pass is bounded: it reports what remains and the next pass finishes", async () => {
    const rows: Record<string, any> = {}
    for (let i = 0; i < 50; i++) rows[`r${i}`] = real()
    const redis = fakeRedis(rows)
    const first = await advanceResultsLedger(redis, CONN, { maxRows: 20, chunk: 10 })
    expect(first).toMatchObject({ scanned: 20, remaining: 30, complete: false })
    clearResultLedgerCache()
    expect(((await readResultLedger(redis, CONN))!.meta.complete)).toBe(false)
    const rest = await advanceResultsLedger(redis, CONN, { maxRows: 100, chunk: 10 })
    expect(rest).toMatchObject({ scanned: 30, remaining: 0, complete: true })
  })
  test("one pass at a time per connection", async () => {
    const redis = fakeRedis({ a: real() })
    redis.kv.set(`results:ledger:v2:${CONN}:lock`, "1")
    expect(await advanceResultsLedger(redis, CONN)).toMatchObject({ skipped: "another pass is running", scanned: 0 })
  })
  test("a connection without rows is complete and empty", async () => {
    const redis = fakeRedis({})
    expect(await advanceResultsLedger(redis, CONN)).toMatchObject({ keys: 0, complete: true })
  })
})

describe("the lifetime summary shape the existing routes read", () => {
  test("real lane from the ledger, simulated rows counted but never valued, coverage complete only after a complete pass", async () => {
    const redis = fakeRedis({ a: real({ realizedPnL: "0.2" }), b: real({ realizedPnL: "-0.1" }), s1: simulated(), s2: simulated(), n: neverTraded({ status: "rejected", closeReason: "x" }) })
    await advanceResultsLedger(redis, CONN); clearResultLedgerCache()
    const s = lifetimeSummaryFromLedger((await readResultLedger(redis, CONN))!)
    expect(s.lanes.real).toMatchObject({ executedRows: 2, closedTrades: 2, settledClosedTrades: 2, accountingPending: 0, wins: 1, losses: 1, rejectedRows: 1 })
    expect(s.lanes.real.realizedPnl).toBeCloseTo(0.1)
    expect(s.lanes.simulated).toMatchObject({ executedRows: 2, realizedPnl: 0, grossProfit: 0, grossLoss: 0, wins: 0, losses: 0 })
    expect(s.coverage.complete).toBe(true)
  })
  test("the summary reads the ledger first, and the simulated book is delivered without valuation unless switched on", () => {
    const life = readFileSync(resolve(process.cwd(), "lib/live-position-lifetime-summary.ts"), "utf8")
    expect(life).toContain("if (ledger && ledger.meta.complete) return lifetimeSummaryFromLedger(ledger)")
    const book = { ...emptyPositionBookStats(), total: 1700, open: 702, closed: 998, settledClosed: 998, wins: 567, losses: 431, netPnl: -2171362107.19, grossLoss: 3e9, winRate: 56.8 }
    const shown = simulatedBookForDisplay(book, {})
    expect(shown).toMatchObject({ total: 1700, open: 702, closed: 998, wins: 0, losses: 0, netPnl: 0, grossLoss: 0, winRate: 0, settledClosed: 0 })
    expect(simulatedBookForDisplay(book, { CTS_SIMULATED_BOOK_VALUATION: "1" }).netPnl).toBe(-2171362107.19)
    expect(readFileSync(resolve(process.cwd(), "lib/live-execution-summary.ts"), "utf8")).toContain("simulated: simulatedBookForDisplay(computePositionBookStats(lanes.simulated")
    expect(readFileSync(resolve(process.cwd(), "components/stats/simulated-book-panel.tsx"), "utf8")).toContain("export const SIMULATED_RESULTS_VISIBLE = false")
  })
  test("the background run advances the ledger", () => {
    const cron = readFileSync(resolve(process.cwd(), "app/api/cron/close-accounting/route.ts"), "utf8")
    expect(cron).toContain("const ledgerRuns = await advanceLedgers(client, requested)")
    expect(cron).toContain("advanceResultsLedger(client, id, { budgetMs: 6_000 })")
  })
})

describe("ready means the first complete pass has run", () => {
  test("new rows after a complete pass are a lag, not a fall back to incomplete (the flip-flop of 2026-10-01)", async () => {
    const rows: Record<string, any> = { a: real(), b: real() }
    const redis = fakeRedis(rows)
    await advanceResultsLedger(redis, CONN); clearResultLedgerCache()
    expect(((await readResultLedger(redis, CONN))!.meta)).toMatchObject({ complete: true, remaining: 0 })
    for (let i = 0; i < 40; i++) redis.hashes.set(`live_positions:${CONN}:n${i}`, Object.fromEntries(Object.entries(real()).map(([k, v]) => [k, String(v)])))
    await advanceResultsLedger(redis, CONN, { maxRows: 5, chunk: 5 }); clearResultLedgerCache()
    const meta = (await readResultLedger(redis, CONN))!.meta
    expect(meta.remaining).toBeGreaterThan(0)
    expect(meta.complete).toBe(true) // still ready: the answer is at most a few rows behind
    const life = lifetimeSummaryFromLedger((await readResultLedger(redis, CONN))!)
    expect(life.coverage.complete).toBe(true)
  })
  test("a ledger that never completed a pass is not ready", async () => {
    const rows: Record<string, any> = {}
    for (let i = 0; i < 30; i++) rows[`r${i}`] = real()
    const redis = fakeRedis(rows)
    await advanceResultsLedger(redis, CONN, { maxRows: 10, chunk: 10 }); clearResultLedgerCache()
    expect(((await readResultLedger(redis, CONN))!.meta.complete)).toBe(false)
  })

  test("skip entries of rows that expired are dropped; entries of filled rows stay", async () => {
    const redis = fakeRedis({ a: real(), s1: simulated(), s2: simulated() })
    await advanceResultsLedger(redis, CONN); clearResultLedgerCache()
    expect(redis.sets.get(`results:ledger:v2:${CONN}:skip`)!.size).toBe(2)
    redis.hashes.delete(`live_positions:${CONN}:s1`)   // retention removed it
    redis.hashes.delete(`live_positions:${CONN}:a`)    // a filled row expired too
    await advanceResultsLedger(redis, CONN); clearResultLedgerCache()
    expect([...redis.sets.get(`results:ledger:v2:${CONN}:skip`)!]).toEqual(["s2"])
    const ledger = (await readResultLedger(redis, CONN))!
    expect(ledger.entries).toHaveLength(1)           // the result of the expired filled row is kept
    expect(ledger.funnel.simulated).toBe(2)          // the funnel keeps what it counted
  })
})

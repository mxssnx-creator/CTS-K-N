/**
 * Results ledger: the one place where "what did this connection earn" is decided.
 *
 * A RESULT is a position of this system that reached the venue and was filled:
 * source real (not simulated), executedQuantity > 0, own tracking id. Everything
 * else is NOT a result and never enters PnL, profit factor, win rate or a trade
 * count: simulated rows (paper), rows that never traded (rejected, error, closed
 * with no fill, "placement_stuck_no_venue_handle"), rows of another system on the
 * shared account. They are counted in the FUNNEL, separately.
 *
 * Why a ledger of its own (measured 2026-10-01):
 *  - routes read the 1,000 newest closed ids and a 73 h archive: X02 showed 2
 *    positions and 0 trades while it has 1,287 filled real rows, because its newest
 *    5,000 closed ids are simulated and never-traded rows; X01 lost everything older
 *    than three days;
 *  - the lifetime summary records a position when it CLOSES and never updates it when
 *    the accounting settles later (X02: settled 253 / pending 1,027 against 915 / 361
 *    in the rows; X01: realized -0.55 against -1.13) and re-records the same rows
 *    endlessly (1,189,421 prunes);
 *  - summing every row mixed in 10,491 simulated rows: net -14.5 billion.
 *
 * The ledger is built from the durable rows, incrementally and idempotently, and
 * stores only compact entries of filled real rows (X02: 1,287, X01: 313).
 */
import { clearLedgerSkipSetCache, ledgerSkipSetKey } from "@/lib/results/skip-set"
import { getLivePositionSource, isExecutedRealExchangePosition } from "@/lib/live-position-source"
import { resolveSettledRealizedPnl } from "@/lib/live-position-pnl"
import type { LivePositionLifetimeLane, LivePositionLifetimeSummary } from "@/lib/live-position-lifetime-summary"
import { LIVE_POSITION_LIFETIME_SUMMARY_VERSION } from "@/lib/live-position-lifetime-summary"

// v2: exit price, order ids, set key; fees are `tradingFees` alone (it already holds entry + close).
// v3: a cancelled / rejected / failed row counts as a trade only with its OWN executedQuantity > 0 (11 phantom rows of
//     X02 and X01 were counted, see classifyRow), and every terminal row is "closed", not "open".
export const RESULTS_LEDGER_VERSION = 3
const TERMINAL = new Set(["closed", "rejected", "cancelled", "canceled", "error", "failed"])

export const ledgerEntriesKey = (c: string) => `results:ledger:v${RESULTS_LEDGER_VERSION}:${c}:entries`
export const ledgerIdsKey = (c: string) => `results:ledger:v${RESULTS_LEDGER_VERSION}:${c}:ids`
export const ledgerOpenKey = (c: string) => `results:ledger:v${RESULTS_LEDGER_VERSION}:${c}:open`
export const ledgerSkipKey = (c: string) => ledgerSkipSetKey(c)
export const ledgerFunnelKey = (c: string) => `results:ledger:v${RESULTS_LEDGER_VERSION}:${c}:funnel`
export const ledgerMetaKey = (c: string) => `results:ledger:v${RESULTS_LEDGER_VERSION}:${c}:meta`
const ledgerLockKey = (c: string) => `results:ledger:v${RESULTS_LEDGER_VERSION}:${c}:lock`

export interface LedgerEntry {
  id: string
  sym: string
  dir: "long" | "short" | ""
  opened: number
  closed: number
  status: "open" | "closed"
  qty: number
  entry: number
  notional: number
  lev: number
  sl: number
  tp: number
  /** Settled realized pnl; null while the accounting is pending. */
  pnl: number | null
  fees: number
  settled: boolean
  pnlSource: string
  reason: string
  type: string
  lane: string
  variant: string
  intent: string
  slip: number | null
  exit: number
  oid: string
  coid: string
  setKey: string
}

export type RowClass =
  | { kind: "executed" }
  | { kind: "simulated" }
  | { kind: "foreign" }
  | { kind: "never_traded"; reason: string }
  | { kind: "pending" }

const num = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0 }
const text = (v: unknown): string => String(v ?? "").trim()

export function classifyRow(row: Record<string, any>, connectionId: string): RowClass {
  const tracking = text(row.system_tracking_id)
  if (tracking && !tracking.startsWith(`sys-${connectionId}-`)) return { kind: "foreign" }
  if (getLivePositionSource(row) === "simulated") return { kind: "simulated" }
  const status = text(row.status).toLowerCase()
  // isExecutedRealExchangePosition confirms a quantity from totalExecutedQuantity / fills too. A row that was
  // cancelled, rejected or failed without an executedQuantity of its own is a phantom (X02: status=cancelled,
  // statusReason=phantom_row_no_entry_order, executedQuantity=0, totalExecutedQuantity=2795 from the slot
  // accumulation): it never traded and must not be a result.
  const ownFill = num(row.executedQuantity) > 0 || num(row.filledQuantity) > 0
  const terminalWithoutOwnFill = TERMINAL.has(status) && status !== "closed" && !ownFill
  // A row that is still "open" without a fill of its own is not an open trade either (X02, 2026-10-02: a rolled-back
  // SOMIUSDT short, status open, executedQuantity 0, counted as the fourth open position against three on the venue).
  // It stays pending: once it closes or fills, the next pass decides.
  if (!TERMINAL.has(status) && !ownFill) return { kind: "pending" }
  if (!terminalWithoutOwnFill && isExecutedRealExchangePosition(row)) return { kind: "executed" }
  if (TERMINAL.has(status)) {
    const reason = text(row.closeReason || row.statusReason).slice(0, 48) || "-"
    return { kind: "never_traded", reason: `${status}/${reason}` }
  }
  return { kind: "pending" }
}

export function toLedgerEntry(id: string, row: Record<string, any>): LedgerEntry {
  const qty = num(row.executedQuantity)
  const entry = num(row.averageExecutionPrice) || num(row.entryPrice)
  const status = TERMINAL.has(text(row.status).toLowerCase()) ? "closed" : "open"
  const settledPnl = status === "closed" ? resolveSettledRealizedPnl(row) : undefined
  const direction = text(row.direction || row.side).toLowerCase()
  const slip = row.closeSlippagePct === undefined || row.closeSlippagePct === "" ? null : num(row.closeSlippagePct)
  return {
    id,
    sym: text(row.symbol).toUpperCase(),
    dir: direction === "long" || direction === "short" ? direction : "",
    opened: num(row.createdAt) || num(row.openedAt),
    closed: num(row.closedAt),
    status,
    qty,
    entry,
    notional: qty * entry,
    lev: num(row.leverage),
    // the stop in percent (stopLoss); assignedStopLoss carries the Set's configuration unit (40, 50, 10, ...)
    sl: num(row.stopLoss) > 0 && num(row.stopLoss) <= 25 ? num(row.stopLoss) : num(row.assignedStopLoss),
    tp: num(row.assignedTakeProfit) || num(row.takeProfit),
    pnl: settledPnl === undefined ? null : settledPnl,
    // tradingFees is the total (X02: 0.005 = entry 0.0025 + close 0.0025); entryTradingFee is only its entry part.
    fees: num(row.tradingFees) || num(row.entryTradingFee),
    settled: settledPnl !== undefined,
    pnlSource: text(row.realizedPnlSource),
    reason: text(row.closeReason),
    type: text(row.indicationType),
    lane: text(row.executionLane),
    variant: text(row.setVariant),
    intent: text(row.executionIntent),
    slip,
    exit: num(row.closePrice) || num(row.averageClosePrice) || num(row.exitPrice),
    oid: text(row.orderId),
    coid: text(row.closeOrderId),
    setKey: text(row.parentSetKey || row.setKey),
  }
}

// ───────────────────────────── incremental builder ─────────────────────────────
export interface LedgerAdvance {
  connectionId: string
  keys: number
  scanned: number
  added: number
  refreshed: number
  remaining: number
  complete: boolean
  skipped?: string
  durationMs: number
}

export async function advanceResultsLedger(
  client: any,
  connectionId: string,
  options: { budgetMs?: number; maxRows?: number; chunk?: number } = {},
): Promise<LedgerAdvance> {
  const started = Date.now()
  const budgetMs = options.budgetMs ?? 8_000
  const maxRows = options.maxRows ?? 3_000
  const chunk = Math.max(1, options.chunk ?? 60)
  const base: LedgerAdvance = { connectionId, keys: 0, scanned: 0, added: 0, refreshed: 0, remaining: 0, complete: false, durationMs: 0 }
  const done = (patch: Partial<LedgerAdvance>): LedgerAdvance => ({ ...base, ...patch, durationMs: Date.now() - started })

  const locked = await client.set(ledgerLockKey(connectionId), String(started), { NX: true, EX: 55 }).catch(() => null)
  if (!locked) return done({ skipped: "another pass is running" })
  try {
    const prefix = `live_positions:${connectionId}:`
    const keys: string[] = ((await client.keys(`${prefix}*`).catch(() => [])) || []).map(String)
    if (keys.length === 0) {
      await client.hset(ledgerMetaKey(connectionId), { updatedAt: String(Date.now()), keys: "0", complete: "1" }).catch(() => 0)
      return done({ complete: true })
    }
    const [idList, skipList, openList] = await Promise.all([
      client.smembers(ledgerIdsKey(connectionId)).catch(() => []),
      client.smembers(ledgerSkipKey(connectionId)).catch(() => []),
      client.smembers(ledgerOpenKey(connectionId)).catch(() => []),
    ])
    const known = new Set<string>([...(idList || []), ...(skipList || [])].map(String))
    // Skip entries of rows that no longer exist (retention removed them) are dropped, so the set cannot grow
    // without bound. The funnel counters keep what they counted. Entries of FILLED rows stay: the ledger is the
    // history once the row itself has expired.
    const liveIds = new Set<string>(keys.map((k) => k.slice(prefix.length)))
    let pruned = 0
    for (const id of skipList || []) {
      if (pruned >= 500) break
      if (!liveIds.has(String(id))) { await client.srem(ledgerSkipKey(connectionId), String(id)); known.delete(String(id)); pruned++ }
    }
    const refresh = new Set<string>((openList || []).map(String))
    const live = new Set<string>(keys.map((k) => k.slice(prefix.length)))
    // Rows to look at: executed rows that are not final yet, and every row never seen.
    const todo: string[] = []
    for (const id of refresh) if (live.has(id)) todo.push(id)
    for (const id of live) if (!known.has(id) && !refresh.has(id)) todo.push(id)
    let scanned = 0, added = 0, refreshed = 0
    for (let i = 0; i < todo.length && scanned < maxRows && Date.now() - started < budgetMs; i += chunk) {
      const slice = todo.slice(i, i + chunk)
      const rows = await Promise.all(slice.map((id) => client.hgetall(`${prefix}${id}`).catch(() => null)))
      for (let j = 0; j < slice.length; j++) {
        const id = slice[j]
        const row = rows[j]
        scanned++
        if (!row || !row.status) continue
        const klass = classifyRow(row, connectionId)
        if (klass.kind === "executed") {
          const entry = toLedgerEntry(id, row)
          await client.hset(ledgerEntriesKey(connectionId), { [id]: JSON.stringify(entry) })
          if (refresh.has(id)) refreshed++
          else { await client.sadd(ledgerIdsKey(connectionId), id); added++ }
          if (entry.status === "closed" && entry.settled) await client.srem(ledgerOpenKey(connectionId), id)
          else await client.sadd(ledgerOpenKey(connectionId), id)
        } else if (klass.kind === "pending") {
          // not final: looked at again next pass; if it was kept as an executed row, it is not one now
          if (refresh.has(id)) {
            await client.hdel(ledgerEntriesKey(connectionId), id)
            await client.srem(ledgerIdsKey(connectionId), id)
            await client.srem(ledgerOpenKey(connectionId), id)
          }
        } else {
          if (refresh.has(id)) {
            // it was kept as an executed row and no longer is one: take it out of the ledger
            await client.hdel(ledgerEntriesKey(connectionId), id)
            await client.srem(ledgerIdsKey(connectionId), id)
            await client.srem(ledgerOpenKey(connectionId), id)
          }
          const isNew = await client.sadd(ledgerSkipKey(connectionId), id)
          if (Number(isNew) > 0) {
            const field = klass.kind === "never_traded" ? `never:${klass.reason}` : klass.kind
            await client.hincrby(ledgerFunnelKey(connectionId), field, 1)
          }
        }
      }
    }
    const remaining = Math.max(0, todo.length - scanned)
    await client.hset(ledgerMetaKey(connectionId), {
      updatedAt: String(Date.now()),
      keys: String(keys.length),
      remaining: String(remaining),
      complete: remaining === 0 ? "1" : "0",
      ...(remaining === 0 ? { lastCompletePassAt: String(Date.now()) } : {}),
    }).catch(() => 0)
    return done({ keys: keys.length, scanned, added, refreshed, remaining, complete: remaining === 0 })
  } finally {
    clearLedgerSkipSetCache(connectionId) // readers skip rows the pass has just classified as final non-results
    await client.del(ledgerLockKey(connectionId)).catch(() => 0)
  }
}

// ──────────────────────────────── reading ────────────────────────────────
export interface ResultLedger {
  connectionId: string
  entries: LedgerEntry[]
  funnel: Record<string, number>
  meta: { updatedAt: number; keys: number; remaining: number; complete: boolean }
}

const cache = new Map<string, { at: number; value: ResultLedger }>()
const CACHE_MS = 10_000

export function clearResultLedgerCache(connectionId?: string): void {
  if (connectionId) cache.delete(connectionId)
  else cache.clear()
}

export async function readResultLedger(client: any, connectionId: string): Promise<ResultLedger | null> {
  const hit = cache.get(connectionId)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value
  const [raw, funnelRaw, metaRaw] = await Promise.all([
    client.hgetall(ledgerEntriesKey(connectionId)).catch(() => ({})),
    client.hgetall(ledgerFunnelKey(connectionId)).catch(() => ({})),
    client.hgetall(ledgerMetaKey(connectionId)).catch(() => ({})),
  ])
  if (!metaRaw || Object.keys(metaRaw).length === 0) return null
  const entries: LedgerEntry[] = []
  for (const value of Object.values(raw || {})) {
    try { entries.push(JSON.parse(String(value))) } catch { /* a damaged entry is rebuilt by the next pass */ }
  }
  const funnel: Record<string, number> = {}
  for (const [field, count] of Object.entries(funnelRaw || {})) funnel[field] = num(count)
  const value: ResultLedger = {
    connectionId,
    entries,
    funnel,
    // Ready = the first complete pass has run. After that, new rows only cause a small lag (`remaining`):
    // the previous rule (complete only while nothing is left) flipped to "incomplete" whenever a row
    // appeared, and every reader fell back to the old, wrong figures until the next pass finished.
    meta: { updatedAt: num(metaRaw.updatedAt), keys: num(metaRaw.keys), remaining: num(metaRaw.remaining), complete: metaRaw.complete === "1" || num(metaRaw.lastCompletePassAt) > 0 },
  }
  cache.set(connectionId, { at: Date.now(), value })
  return value
}

// ───────────────────────────────── the book ─────────────────────────────────
export interface ResultBook {
  executed: number
  open: number
  closed: number
  settled: number
  accountingPending: number
  wins: number
  losses: number
  flat: number
  grossProfit: number
  grossLoss: number
  net: number
  fees: number
  profitFactor: number | null
  winRate: number | null
  avgWin: number | null
  avgLoss: number | null
  largestWin: number | null
  largestLoss: number | null
  expectancy: number | null
  volumeUsd: number
  long: { trades: number; net: number }
  short: { trades: number; net: number }
  under60s: number
  under5m: number
}

export function computeResultBook(entries: readonly LedgerEntry[], window: { since?: number; until?: number } = {}): ResultBook {
  const inWindow = (e: LedgerEntry) => {
    if (window.since === undefined && window.until === undefined) return true
    const at = e.status === "closed" ? e.closed : e.opened
    return (window.since === undefined || at >= window.since) && (window.until === undefined || at <= window.until)
  }
  const rows = entries.filter(inWindow)
  const closed = rows.filter((e) => e.status === "closed")
  const settled = closed.filter((e) => e.settled && e.pnl !== null)
  let gp = 0, gl = 0, wins = 0, losses = 0, flat = 0, net = 0, fees = 0
  let best: number | null = null, worst: number | null = null
  const longB = { trades: 0, net: 0 }, shortB = { trades: 0, net: 0 }
  let u60 = 0, u5 = 0
  for (const e of settled) {
    const p = e.pnl as number
    net += p; fees += e.fees
    if (p > 0) { wins++; gp += p } else if (p < 0) { losses++; gl -= p } else flat++
    best = best === null ? p : Math.max(best, p)
    worst = worst === null ? p : Math.min(worst, p)
    const bucket = e.dir === "short" ? shortB : longB
    bucket.trades++; bucket.net += p
    if (e.closed > 0 && e.opened > 0) { const d = e.closed - e.opened; if (d < 60_000) u60++; if (d < 300_000) u5++ }
  }
  const decisive = wins + losses
  return {
    executed: rows.length,
    open: rows.length - closed.length,
    closed: closed.length,
    settled: settled.length,
    accountingPending: closed.length - settled.length,
    wins, losses, flat,
    grossProfit: gp, grossLoss: gl, net, fees,
    profitFactor: gl > 0 ? gp / gl : null,
    winRate: decisive > 0 ? (wins / decisive) * 100 : null,
    avgWin: wins > 0 ? gp / wins : null,
    avgLoss: losses > 0 ? -(gl / losses) : null,
    largestWin: best !== null && best > 0 ? best : null,
    largestLoss: worst !== null && worst < 0 ? worst : null,
    expectancy: settled.length > 0 ? net / settled.length : null,
    volumeUsd: closed.reduce((s, e) => s + e.notional, 0),
    long: longB, short: shortB, under60s: u60, under5m: u5,
  }
}

/** Book per group (type, lane, variant, symbol ...) for the live-against-simulation evaluation. */
export function groupResultBooks(entries: readonly LedgerEntry[], key: (e: LedgerEntry) => string): Record<string, ResultBook> {
  const groups = new Map<string, LedgerEntry[]>()
  for (const e of entries) { const k = key(e) || "-"; (groups.get(k) || groups.set(k, []).get(k)!).push(e) }
  return Object.fromEntries([...groups].map(([k, v]) => [k, computeResultBook(v)]))
}

// ───────────────────── adapter: the existing lifetime summary shape ─────────────────────
function emptyLane(): LivePositionLifetimeLane {
  return {
    terminalRows: 0, executedRows: 0, closedTrades: 0, settledClosedTrades: 0, accountingPending: 0,
    rejectedRows: 0, errorRows: 0, cancelledRows: 0, realizedPnl: 0, grossProfit: 0, grossLoss: 0,
    wins: 0, losses: 0, breakEven: 0, lifetimeVolumeUsd: 0, realizedRoiTotal: 0, realizedRoiCount: 0,
    longTrades: 0, shortTrades: 0, longRealizedPnl: 0, shortRealizedPnl: 0, under60Seconds: 0, under5Minutes: 0,
    closeOrderIdPresent: 0, closeOrderIdMissing: 0, entryAccountingComplete: 0, entryAccountingPending: 0,
  }
}

export function lifetimeSummaryFromLedger(ledger: ResultLedger): LivePositionLifetimeSummary {
  const book = computeResultBook(ledger.entries)
  const funnelBy = (status: string) => Object.entries(ledger.funnel).filter(([k]) => k.startsWith(`never:${status}/`)).reduce((s, [, c]) => s + c, 0)
  const neverTraded = Object.entries(ledger.funnel).filter(([k]) => k.startsWith("never:")).reduce((s, [, c]) => s + c, 0)
  const real = emptyLane()
  real.executedRows = book.executed
  real.closedTrades = book.closed
  real.settledClosedTrades = book.settled
  real.accountingPending = book.accountingPending
  real.terminalRows = book.closed + neverTraded
  real.rejectedRows = funnelBy("rejected")
  real.errorRows = funnelBy("error") + funnelBy("failed")
  real.cancelledRows = funnelBy("cancelled") + funnelBy("canceled")
  real.realizedPnl = book.net
  real.grossProfit = book.grossProfit
  real.grossLoss = book.grossLoss
  real.wins = book.wins; real.losses = book.losses; real.breakEven = book.flat
  real.lifetimeVolumeUsd = book.volumeUsd
  real.longTrades = book.long.trades; real.shortTrades = book.short.trades
  real.longRealizedPnl = book.long.net; real.shortRealizedPnl = book.short.net
  real.under60Seconds = book.under60s; real.under5Minutes = book.under5m
  // Simulated rows are counted, never valued: their pnl is not a result of this system.
  const simulated = emptyLane()
  simulated.executedRows = ledger.funnel.simulated || 0
  const all = emptyLane()
  for (const key of Object.keys(all) as Array<keyof LivePositionLifetimeLane>) all[key] = real[key] + simulated[key]
  const now = Date.now()
  return {
    schemaVersion: LIVE_POSITION_LIFETIME_SUMMARY_VERSION,
    connectionId: ledger.connectionId,
    generatedAt: now,
    updatedAt: ledger.meta.updatedAt,
    lanes: { all, real, simulated, unknown: emptyLane() },
    coverage: {
      terminalIndexRows: ledger.meta.keys,
      uniqueTerminalIndexRows: ledger.meta.keys,
      indexedContributions: ledger.entries.length,
      prunedContributions: 0,
      contributionWindowLimit: Math.max(10_000, ledger.entries.length),
      ignoredHistoricReplays: 0,
      missingPositionSnapshots: 0,
      complete: ledger.meta.complete,
    },
  }
}

// ───────────────────────────── trade history from the ledger ─────────────────────────────
export interface LedgerHistoryRow {
  id: string
  symbol: string
  direction: "long" | "short"
  entryPrice: number
  exitPrice: number
  quantity: number
  volumeUsd: number
  grossPnl: number
  fees: number
  realizedPnl: number
  pnlPct: number
  openedAt: number
  closedAt: number
  holdMinutes: number
  source: "local"
  attribution: "cts"
  environment: "exchange"
  executionMode: "live"
  executionIntent?: "main" | "preset" | "signal"
  orderId?: string
  closeOrderId?: string
  positionId: string
  setKey?: string
  setVariant?: string
  indicationType?: string
  leverage?: number
  closeReason?: string
  accountingPending?: boolean
}

/** A ledger entry as a row of the trade history table. pnlPct is the pnl in percent of the notional. */
export function ledgerEntryToHistoryRow(e: LedgerEntry): LedgerHistoryRow {
  const pnl = e.pnl ?? 0
  const intent = e.intent === "main" || e.intent === "preset" || e.intent === "signal" ? e.intent : undefined
  return {
    id: e.id,
    symbol: e.sym,
    direction: e.dir === "short" ? "short" : "long",
    entryPrice: e.entry,
    exitPrice: e.exit,
    quantity: e.qty,
    volumeUsd: e.notional,
    grossPnl: pnl + e.fees,
    fees: e.fees,
    realizedPnl: pnl,
    pnlPct: e.notional > 0 ? (pnl / e.notional) * 100 : 0,
    openedAt: e.opened,
    closedAt: e.closed,
    holdMinutes: e.closed > 0 && e.opened > 0 ? Math.max(0, (e.closed - e.opened) / 60_000) : 0,
    source: "local",
    attribution: "cts",
    environment: "exchange",
    executionMode: "live",
    ...(intent ? { executionIntent: intent } : {}),
    ...(e.oid ? { orderId: e.oid } : {}),
    ...(e.coid ? { closeOrderId: e.coid } : {}),
    positionId: e.id,
    ...(e.setKey ? { setKey: e.setKey } : {}),
    ...(e.variant ? { setVariant: e.variant } : {}),
    ...(e.type ? { indicationType: e.type } : {}),
    ...(e.lev ? { leverage: e.lev } : {}),
    ...(e.reason ? { closeReason: e.reason } : {}),
    ...(e.settled ? {} : { accountingPending: true }),
  }
}

/**
 * The complete trade history of a connection: every closed filled real row, newest first. Settled rows
 * enter the summary; rows whose accounting is pending are listed, marked, and never counted.
 */
export function tradeHistoryFromLedger(ledger: ResultLedger): { rows: LedgerHistoryRow[]; settled: LedgerHistoryRow[]; pending: number } {
  const closed = ledger.entries.filter((e) => e.status === "closed").sort((a, b) => b.closed - a.closed)
  const rows = closed.map(ledgerEntryToHistoryRow)
  return { rows, settled: rows.filter((r) => !r.accountingPending), pending: rows.length - rows.filter((r) => !r.accountingPending).length }
}

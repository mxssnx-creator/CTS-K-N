/**
 * Forward measurement for Signal — the one indication type the prehistoric
 * replay cannot measure (its sources are other venues' realtime candles).
 *
 * The Base gate needs measured closes per (symbol × type × direction) before
 * a Set may pass, and only Base-valid Sets open the pseudo positions that
 * produce closes. Signal therefore deadlocked: in the 2026-10-07 verification
 * run 162 of 165 Base Sets per symbol were Signal Sets "awaiting history"
 * forever. This module grades realtime Signal entries on the venue's real
 * one-minute bars WITHOUT trading — the same rules as the type measurement:
 *
 *  - entry at the price the signal was taken at (the realtime close);
 *  - protection = the coordinator's Signal protection for the row's own risk
 *    (deriveProtectionFromSignalRisk), i.e. what a Signal Set would place;
 *  - exits on later bars: a bar touching stop and target is a stop, a bar
 *    opening beyond a level exits at its open, 4 h maximum hold at a close;
 *  - net = gross move − the real round trip (simulatedCloseCostPercent);
 *  - one open measurement per (direction × signal source), like one pseudo
 *    position per rule in the replay.
 *
 * Closes go into pos_ring:{conn}:{symbol}:signal:{direction}, the bucket the
 * Base gate reads for Signal Sets.
 */
import { getRedisClient } from "@/lib/redis-db"
import { posRingKey, recordPosClosedBatch } from "@/lib/pos-history"
import { simulatedCloseCostPercent } from "@/lib/trading-round-trip-cost"
import { normalizeSignalRisk } from "@/lib/signal-indication"
import { addRollingTypeCloses } from "@/lib/trade-engine/type-measurement-rolling"

const MINUTE_MS = 60_000
export const SIGNAL_FORWARD_MAX_HOLD_MS = 4 * 60 * MINUTE_MS
/**
 * A pending entry's cursor trails the newest bar by this lag, so a minute the
 * exchange returned late (or missed from one batch) is still checked on a
 * later pass. Re-checking a bar is harmless: an entry without a touch stays
 * without one, and a touched entry closes and leaves the pending set.
 */
export const SIGNAL_FORWARD_REPLAY_LAG_MS = 120 * MINUTE_MS
const PENDING_TTL_SECONDS = 2 * 24 * 60 * 60
const BOOKED_TTL_SECONDS = 7 * 24 * 60 * 60
const LOCK_TTL_MS = 30_000
/** Bound on concurrently open measurements per symbol (sources × directions). */
export const SIGNAL_FORWARD_MAX_OPEN_PER_SYMBOL = 64

export const signalForwardPendingKey = (connectionId: string, symbol: string) =>
  `signal_forward:${connectionId}:${symbol}`
export const signalForwardLockKey = (connectionId: string, symbol: string) =>
  `signal_forward_lock:${connectionId}:${symbol}`
/** Per row: the `generatedAt` of the provider snapshot that last opened it. */
export const signalForwardObservedKey = (connectionId: string, symbol: string) =>
  `signal_forward_observed:${connectionId}:${symbol}`

export interface SignalForwardEntry {
  direction: "long" | "short"
  sourceId: string
  entryTime: number
  entryPrice: number
  takeProfitPct: number
  stopLossPct: number
  positionCostPct: number
  /** Bars up to (excluding) this minute have been checked. */
  checkedUntilMs: number
}

export interface SignalForwardBar { timestamp: number; open: number; high: number; low: number; close: number }

export interface SignalForwardClose {
  direction: "long" | "short"
  entryTime: number
  exitTime: number
  entryPrice: number
  exitPrice: number
  grossPct: number
  netPct: number
  positionCostPct: number
  holdMinutes: number
  reason: "take_profit" | "stop_loss" | "max_hold"
}

export interface SignalForwardAdvance {
  close: SignalForwardClose | null
  entry: SignalForwardEntry
  /** False when the bars do not reach back to the first minute that still needs a check. */
  covered: boolean
}

function settle(entry: SignalForwardEntry, exitTime: number, exitPrice: number, reason: SignalForwardClose["reason"]): SignalForwardClose {
  const long = entry.direction === "long"
  const grossPct = ((exitPrice - entry.entryPrice) / entry.entryPrice) * 100 * (long ? 1 : -1)
  return {
    direction: entry.direction,
    entryTime: entry.entryTime,
    exitTime,
    entryPrice: entry.entryPrice,
    exitPrice,
    grossPct,
    netPct: grossPct - simulatedCloseCostPercent(entry.positionCostPct),
    positionCostPct: entry.positionCostPct,
    holdMinutes: Math.max(1, Math.round((exitTime - entry.entryTime) / MINUTE_MS)),
    reason,
  }
}

/**
 * Advance one pending measurement over `bars` (any order). Returns the close,
 * or the entry with its cursor advanced. Pure.
 *
 * Rules: the entry minute never decides the entry; a bar opening beyond a
 * level exits at its open; a bar touching both levels is a stop; the 4-hour
 * cap exits at the cap time when the first bar after it opens beyond the cap
 * (exit price = that bar's open), and at a bar's close when the cap falls
 * inside the bar.
 */
export function advanceSignalForwardEntry(
  entry: SignalForwardEntry,
  bars: readonly SignalForwardBar[],
): SignalForwardAdvance {
  const long = entry.direction === "long"
  const stop = entry.entryPrice * (1 + (long ? -1 : 1) * entry.stopLossPct / 100)
  const target = entry.entryPrice * (1 + (long ? 1 : -1) * entry.takeProfitPct / 100)
  const entryMinuteMs = Math.floor(entry.entryTime / MINUTE_MS) * MINUTE_MS
  const firstBarMs = Math.max(entry.checkedUntilMs, entryMinuteMs + MINUTE_MS)
  const capMs = entry.entryTime + SIGNAL_FORWARD_MAX_HOLD_MS
  const ordered = [...bars].sort((a, b) => a.timestamp - b.timestamp)
  // The window must reach back to the first minute that still needs a check;
  // a window that starts later (a capped loader) would silently skip minutes.
  if (!ordered.some((bar) => bar.timestamp <= firstBarMs)) return { close: null, entry, covered: false }
  let lastEnd = Number.NaN
  for (const bar of ordered) {
    if (bar.timestamp < firstBarMs) continue
    if (bar.timestamp >= capMs) return { close: settle(entry, capMs, bar.open, "max_hold"), entry, covered: true }
    const barEnd = bar.timestamp + MINUTE_MS
    if (long ? bar.open <= stop : bar.open >= stop) return { close: settle(entry, bar.timestamp, bar.open, "stop_loss"), entry, covered: true }
    if (long ? bar.open >= target : bar.open <= target) return { close: settle(entry, bar.timestamp, bar.open, "take_profit"), entry, covered: true }
    if (long ? bar.low <= stop : bar.high >= stop) return { close: settle(entry, barEnd, stop, "stop_loss"), entry, covered: true }
    if (long ? bar.high >= target : bar.low <= target) return { close: settle(entry, barEnd, target, "take_profit"), entry, covered: true }
    if (barEnd >= capMs) return { close: settle(entry, barEnd, bar.close, "max_hold"), entry, covered: true }
    lastEnd = barEnd
  }
  const checkedUntilMs = Number.isFinite(lastEnd)
    ? Math.max(entry.checkedUntilMs, lastEnd - SIGNAL_FORWARD_REPLAY_LAG_MS)
    : entry.checkedUntilMs
  return { close: null, entry: { ...entry, checkedUntilMs }, covered: true }
}

/** A short-lived per-symbol lock: one writer at a time for a symbol's pending rows. */
async function acquireSignalForwardLock(client: any, connectionId: string, symbol: string): Promise<string | null> {
  const token = `${process.pid}:${Date.now()}:${Math.random()}`
  const claim = await client.set(signalForwardLockKey(connectionId, symbol), token, { NX: true, PX: LOCK_TTL_MS }).catch(() => null)
  return claim === "OK" || claim === true ? token : null
}

async function releaseSignalForwardLock(client: any, connectionId: string, symbol: string, token: string): Promise<void> {
  const key = signalForwardLockKey(connectionId, symbol)
  const current = await client.get(key).catch(() => null)
  if (current === token) await client.del(key).catch(() => 0)
}

/**
 * Note new realtime Signal entries for measurement: the first row per
 * (direction × source) without an open measurement, and only from a provider
 * snapshot that has not opened one already. A stopped-out entry is therefore
 * not re-opened on every later tick by the same evaluation, which would count
 * one observation as several independent closes. Never trades.
 */
export async function noteSignalForwardEntries(input: {
  connectionId: string
  symbol: string
  indications: readonly any[]
  price: number
  positionCostPct: number
  nowMs?: number
}): Promise<number> {
  const price = Number(input.price)
  if (!(price > 0) || input.indications.length === 0) return 0
  const { deriveProtectionFromSignalRisk } = await import("@/lib/strategy-coordinator")
  const client = getRedisClient() as any
  const key = signalForwardPendingKey(input.connectionId, input.symbol)
  const observedKey = signalForwardObservedKey(input.connectionId, input.symbol)
  const token = await acquireSignalForwardLock(client, input.connectionId, input.symbol)
  // Another writer holds the symbol: this tick's rows are noted on the next one.
  if (!token) return 0
  let noted = 0
  try {
    const open = Number(await client.hlen(key))
    // An unreadable count admits nothing: the cap cannot be checked.
    if (!Number.isFinite(open) || open < 0) return 0
    const nowMs = input.nowMs ?? Date.now()
    const seen = new Set<string>()
    for (const indication of input.indications) {
      if (open + noted >= SIGNAL_FORWARD_MAX_OPEN_PER_SYMBOL) break
      if (String(indication?.type || "").toLowerCase() !== "signal") continue
      const direction = indication?.direction === "short" ? "short" : indication?.direction === "long" ? "long" : null
      if (!direction) continue
      const risk = normalizeSignalRisk(indication?.metadata?.signal)
      const protection = risk ? deriveProtectionFromSignalRisk(risk) : null
      if (!protection) continue
      const sourceId = String(indication?.metadata?.signal?.sourceId || risk?.sourceIds?.[0] || "consensus")
      const field = `${direction}|${sourceId}`
      if (seen.has(field)) continue
      seen.add(field)
      // An unreadable row is never overwritten: a failed read would reset an open measurement's clock.
      let existing: unknown
      let observed: unknown
      try {
        existing = await client.hget(key, field)
        observed = await client.hget(observedKey, field)
      } catch {
        continue
      }
      if (existing) continue
      const generatedAt = Number(indication?.metadata?.signal?.generatedAt) || 0
      if (generatedAt > 0 && Number(observed) === generatedAt) continue
      const entry: SignalForwardEntry = {
        direction,
        sourceId,
        entryTime: nowMs,
        entryPrice: price,
        takeProfitPct: protection.takeProfitPct,
        stopLossPct: protection.stopLossPct,
        positionCostPct: input.positionCostPct,
        checkedUntilMs: 0,
      }
      await client.hset(key, field, JSON.stringify(entry))
      if (generatedAt > 0) await client.hset(observedKey, field, String(generatedAt))
      noted++
    }
    return noted
  } finally {
    await client.expire(key, PENDING_TTL_SECONDS).catch(() => 0)
    await client.expire(observedKey, BOOKED_TTL_SECONDS).catch(() => 0)
    await releaseSignalForwardLock(client, input.connectionId, input.symbol, token)
  }
}

/**
 * Resolve the open Signal measurements of one symbol over completed bars and
 * book their closes into the Base gate's Signal buckets and the realtime
 * rolling counters. A close is booked at most once: the writer whose delete
 * removes the pending row books it, and a per-symbol lock keeps two writers
 * from evaluating the same rows at once. The delete precedes the booking, so
 * a booking that fails after the delete loses that close; it is logged, never
 * booked twice.
 */
export async function resolveSignalForwardMeasurements(input: {
  connectionId: string
  symbol: string
  bars: readonly SignalForwardBar[]
}): Promise<SignalForwardClose[]> {
  if (input.bars.length === 0) return []
  const client = getRedisClient() as any
  const key = signalForwardPendingKey(input.connectionId, input.symbol)
  const token = await acquireSignalForwardLock(client, input.connectionId, input.symbol)
  if (!token) return []
  try {
    const pending = (await client.hgetall(key).catch(() => null)) as Record<string, string> | null
    if (!pending || Object.keys(pending).length === 0) return []
    const newestEndMs = Math.max(...input.bars.map((bar) => bar.timestamp)) + MINUTE_MS
    const closes: SignalForwardClose[] = []
    let expired = 0
    for (const [field, raw] of Object.entries(pending)) {
      let entry: SignalForwardEntry
      try {
        entry = JSON.parse(raw)
      } catch {
        await client.hdel(key, field).catch(() => 0)
        continue
      }
      const advanced = advanceSignalForwardEntry(entry, input.bars)
      if (advanced.close) {
        const removed = Number(await client.hdel(key, field).catch(() => 0))
        if (removed === 1) closes.push(advanced.close)
        continue
      }
      if (!advanced.covered && newestEndMs - (entry.entryTime + SIGNAL_FORWARD_MAX_HOLD_MS) > SIGNAL_FORWARD_REPLAY_LAG_MS) {
        // Well past its cap and the bars never reached its first minute: it can
        // no longer be graded honestly, so it is dropped unbooked and counted.
        await client.hdel(key, field).catch(() => 0)
        expired++
        continue
      }
      if (advanced.entry.checkedUntilMs !== entry.checkedUntilMs) {
        await client.hset(key, field, JSON.stringify(advanced.entry))
      }
    }
    if (expired > 0) console.warn(`[v0] [SignalForward] ${input.symbol}: ${expired} pending measurement(s) expired unbooked (no bars reached their first minute)`)
    if (closes.length > 0) {
      const ordered = [...closes].sort((a, b) => a.exitTime - b.exitTime)
      const pipeline = client.multi()
      recordPosClosedBatch({
        connectionId: input.connectionId,
        pipeline,
        entries: ordered.map((close) => ({
          symbol: input.symbol,
          indicationType: "signal",
          direction: close.direction,
          pnl: close.netPct,
          pnlPct: close.netPct,
          positionCostPct: close.positionCostPct,
          drawdownMinutes: close.holdMinutes,
          entryPrice: close.entryPrice,
        })),
      })
      addRollingTypeCloses(
        pipeline,
        input.connectionId,
        input.symbol,
        ordered.map((close) => ({ type: "signal", direction: close.direction, netPct: close.netPct, positionCostPct: close.positionCostPct })),
        BOOKED_TTL_SECONDS,
      )
      try {
        await pipeline.exec()
      } catch (error) {
        console.warn(`[v0] [SignalForward] ${input.symbol}: ${closes.length} close(s) removed but not booked: ${error instanceof Error ? error.message : String(error)}`)
        return []
      }
    }
    return closes
  } finally {
    await releaseSignalForwardLock(client, input.connectionId, input.symbol, token)
  }
}

/** Earliest minute any pending Signal row still needs (null when none pending). */
export async function readSignalForwardEarliestCursor(connectionId: string, symbol: string): Promise<number | null> {
  const client = getRedisClient() as any
  const pending = (await client.hgetall(signalForwardPendingKey(connectionId, symbol)).catch(() => null)) as Record<string, string> | null
  if (!pending) return null
  let earliest: number | null = null
  for (const raw of Object.values(pending)) {
    try {
      const entry = JSON.parse(raw) as SignalForwardEntry
      const entryMinute = Math.floor(entry.entryTime / MINUTE_MS) * MINUTE_MS + MINUTE_MS
      const needed = Math.max(Number(entry.checkedUntilMs) || 0, entryMinute)
      earliest = earliest === null ? needed : Math.min(earliest, needed)
    } catch {
      // An unreadable row is removed by the next resolve; it does not move the window.
    }
  }
  return earliest
}

export interface SignalForwardSymbolSummary {
  /** Realtime Signal entries still waiting for their exit (not yet closes). */
  open: number
  /** Measured Signal closes the Base gate reads, per direction (ring length, capped by the ring). */
  closedLong: number
  closedShort: number
}

export interface SignalForwardSummary {
  symbols: number
  open: number
  closedLong: number
  closedShort: number
  bySymbol: Record<string, SignalForwardSymbolSummary>
}

/** Symbols read per summary call; a bound on Redis round-trips for the stats endpoint. */
export const SIGNAL_FORWARD_SUMMARY_MAX_SYMBOLS = 64

/**
 * Read-only status of Signal forward measurement for the stats endpoint:
 * how many realtime Signal entries are being graded and how many measured
 * Signal closes the Base gate already has per direction. Never writes.
 */
export async function readSignalForwardSummary(connectionId: string, symbols: readonly string[]): Promise<SignalForwardSummary> {
  const client = getRedisClient() as any
  const list = [...new Set(symbols.map((s) => String(s || "").trim()).filter(Boolean))].slice(0, SIGNAL_FORWARD_SUMMARY_MAX_SYMBOLS)
  const bySymbol: Record<string, SignalForwardSymbolSummary> = {}
  for (const symbol of list) {
    const [open, long, short] = await Promise.all([
      client.hlen(signalForwardPendingKey(connectionId, symbol)).catch(() => 0),
      client.llen(posRingKey(connectionId, symbol, "signal", "long")).catch(() => 0),
      client.llen(posRingKey(connectionId, symbol, "signal", "short")).catch(() => 0),
    ])
    bySymbol[symbol] = {
      open: Math.max(0, Number(open) || 0),
      closedLong: Math.max(0, Number(long) || 0),
      closedShort: Math.max(0, Number(short) || 0),
    }
  }
  const values = Object.values(bySymbol)
  return {
    symbols: list.length,
    open: values.reduce((sum, row) => sum + row.open, 0),
    closedLong: values.reduce((sum, row) => sum + row.closedLong, 0),
    closedShort: values.reduce((sum, row) => sum + row.closedShort, 0),
    bySymbol,
  }
}

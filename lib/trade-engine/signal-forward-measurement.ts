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
import { recordPosClosedBatch } from "@/lib/pos-history"
import { simulatedCloseCostPercent } from "@/lib/trading-round-trip-cost"
import { normalizeSignalRisk } from "@/lib/signal-indication"

const MINUTE_MS = 60_000
export const SIGNAL_FORWARD_MAX_HOLD_MS = 4 * 60 * MINUTE_MS
const PENDING_TTL_SECONDS = 2 * 24 * 60 * 60
/** Bound on concurrently open measurements per symbol (sources × directions). */
export const SIGNAL_FORWARD_MAX_OPEN_PER_SYMBOL = 64

export const signalForwardPendingKey = (connectionId: string, symbol: string) =>
  `signal_forward:${connectionId}:${symbol}`

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

/**
 * Advance one pending measurement over `bars` (oldest first). Returns the
 * close, or the entry with its new `checkedUntilMs` when still open. Pure.
 */
export function advanceSignalForwardEntry(
  entry: SignalForwardEntry,
  bars: readonly SignalForwardBar[],
): { close: SignalForwardClose | null; entry: SignalForwardEntry } {
  const long = entry.direction === "long"
  const stop = entry.entryPrice * (1 + (long ? -1 : 1) * entry.stopLossPct / 100)
  const target = entry.entryPrice * (1 + (long ? 1 : -1) * entry.takeProfitPct / 100)
  // The first bar that may decide is the first one starting after the entry.
  const firstBarMs = Math.max(entry.checkedUntilMs, Math.floor(entry.entryTime / MINUTE_MS) * MINUTE_MS + MINUTE_MS)
  let checkedUntilMs = entry.checkedUntilMs
  const settle = (bar: SignalForwardBar, exitTime: number, exitPrice: number, reason: SignalForwardClose["reason"]) => {
    const grossPct = ((exitPrice - entry.entryPrice) / entry.entryPrice) * 100 * (long ? 1 : -1)
    return {
      close: {
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
      },
      entry: { ...entry, checkedUntilMs: bar.timestamp + MINUTE_MS },
    }
  }
  for (const bar of bars) {
    if (bar.timestamp < firstBarMs) continue
    const barEnd = bar.timestamp + MINUTE_MS
    if (long ? bar.open <= stop : bar.open >= stop) return settle(bar, bar.timestamp, bar.open, "stop_loss")
    if (long ? bar.open >= target : bar.open <= target) return settle(bar, bar.timestamp, bar.open, "take_profit")
    if (long ? bar.low <= stop : bar.high >= stop) return settle(bar, barEnd, stop, "stop_loss")
    if (long ? bar.high >= target : bar.low <= target) return settle(bar, barEnd, target, "take_profit")
    if (barEnd - entry.entryTime >= SIGNAL_FORWARD_MAX_HOLD_MS) return settle(bar, barEnd, bar.close, "max_hold")
    checkedUntilMs = barEnd
  }
  return { close: null, entry: { ...entry, checkedUntilMs } }
}

/**
 * Note new realtime Signal entries for measurement: the first row per
 * (direction × source) without an open measurement. Never trades.
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
  const open = Number(await client.hlen(key).catch(() => 0)) || 0
  if (open >= SIGNAL_FORWARD_MAX_OPEN_PER_SYMBOL) return 0
  const nowMs = input.nowMs ?? Date.now()
  let noted = 0
  const seen = new Set<string>()
  for (const indication of input.indications) {
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
    // Realtime processing is single-flight per symbol, so check-then-set
    // cannot race another writer of the same field.
    const existing = await client.hget(key, field).catch(() => null)
    if (existing) continue
    await client.hset(key, field, JSON.stringify(entry))
    noted++
    if (open + noted >= SIGNAL_FORWARD_MAX_OPEN_PER_SYMBOL) break
  }
  if (noted > 0) await client.expire(key, PENDING_TTL_SECONDS).catch(() => 0)
  return noted
}

/**
 * Resolve the open Signal measurements of one symbol over completed bars and
 * book their closes into the Base gate's Signal buckets.
 */
export async function resolveSignalForwardMeasurements(input: {
  connectionId: string
  symbol: string
  bars: readonly SignalForwardBar[]
}): Promise<SignalForwardClose[]> {
  const client = getRedisClient() as any
  const key = signalForwardPendingKey(input.connectionId, input.symbol)
  const pending = (await client.hgetall(key).catch(() => null)) as Record<string, string> | null
  if (!pending || Object.keys(pending).length === 0 || input.bars.length === 0) return []
  const closes: SignalForwardClose[] = []
  const pipeline = client.multi()
  for (const [field, raw] of Object.entries(pending)) {
    let entry: SignalForwardEntry
    try { entry = JSON.parse(raw) } catch { pipeline.hdel(key, field); continue }
    const advanced = advanceSignalForwardEntry(entry, input.bars)
    if (advanced.close) {
      closes.push(advanced.close)
      pipeline.hdel(key, field)
    } else if (advanced.entry.checkedUntilMs !== entry.checkedUntilMs) {
      pipeline.hset(key, field, JSON.stringify(advanced.entry))
    }
  }
  if (closes.length > 0) {
    recordPosClosedBatch({
      connectionId: input.connectionId,
      pipeline,
      entries: [...closes].sort((a, b) => a.exitTime - b.exitTime).map((close) => ({
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
  }
  await pipeline.exec()
  return closes
}

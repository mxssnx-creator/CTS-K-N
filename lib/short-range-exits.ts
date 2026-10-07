/**
 * Exit evaluation for short-range research on real one-minute bars.
 *
 * The per-type measurement (lib/trade-engine/prehistoric-type-replay.ts)
 * decides entries and exits in one pass with one protection per row. To
 * compare many protection configurations on the same entries, the entries
 * are captured once (every signal the strategies emitted, with its time and
 * price) and this module replays the exits for one configuration:
 *
 *  - one open position per (type, direction, rule) at a time, as in the
 *    replay — a signal while its key is open is not a new entry;
 *  - the bar after the entry is the first that can exit it;
 *  - a bar that opens beyond a level exits at its open; a bar touching both
 *    the stop and the target counts as a stop;
 *  - optional trailing replaces the fixed target: it arms once the favourable
 *    move reaches `trailingStartPct` and then trails the best price by
 *    `trailingStopRatio` of the move; a bar closing beyond the trail exits
 *    at its close (its intrabar path is unknown, so the later price is used);
 *  - after `maxHoldMs` the position closes at the bar close.
 *
 * Without trailing the closes equal the replay's for the same protection.
 */
import type { ReplayCandle, ReplayCloseReason } from "@/lib/trade-engine/prehistoric-type-replay"

const MINUTE_MS = 60_000

export interface ResearchSignal {
  type: string
  direction: "long" | "short"
  rule: string
  /** Close time of the decision bar: the entry time. */
  entryTime: number
  entryPrice: number
  profitFactor: number
}

export interface ExitConfig {
  takeProfitPct: number
  stopLossPct: number
  /** Favourable move (percent) that arms trailing; null = fixed target. */
  trailingStartPct?: number | null
  /** Share of the favourable move given back before the trail exits (0..1). */
  trailingStopRatio?: number
  maxHoldMs: number
}

export type ResearchCloseReason = ReplayCloseReason | "trailing_stop"

export interface ResearchClose {
  type: string
  direction: "long" | "short"
  rule: string
  entryTime: number
  exitTime: number
  entryPrice: number
  exitPrice: number
  /** Signed market move in percent, before costs. */
  grossPct: number
  reason: ResearchCloseReason
}

interface OpenEntry {
  key: string
  signal: ResearchSignal
  stopPrice: number
  targetPrice: number
  bestPrice: number
  trailing: boolean
}

export function simulateExits(
  bars: readonly ReplayCandle[],
  signals: readonly ResearchSignal[],
  config: ExitConfig,
): ResearchClose[] {
  const closes: ResearchClose[] = []
  const open = new Map<string, OpenEntry>()
  const trailingStart = Number(config.trailingStartPct) > 0 ? Number(config.trailingStartPct) : null
  const giveBack = Math.min(1, Math.max(0, Number(config.trailingStopRatio) || 0))
  const maxHoldMs = Math.max(MINUTE_MS, Number(config.maxHoldMs) || 4 * 60 * MINUTE_MS)
  const ordered = [...signals].sort((a, b) => a.entryTime - b.entryTime)
  let next = 0

  const settle = (entry: OpenEntry, exitTime: number, exitPrice: number, reason: ResearchCloseReason) => {
    const side = entry.signal.direction === "long" ? 1 : -1
    closes.push({
      type: entry.signal.type,
      direction: entry.signal.direction,
      rule: entry.signal.rule,
      entryTime: entry.signal.entryTime,
      exitTime,
      entryPrice: entry.signal.entryPrice,
      exitPrice,
      grossPct: ((exitPrice - entry.signal.entryPrice) / entry.signal.entryPrice) * 100 * side,
      reason,
    })
    open.delete(entry.key)
  }

  for (const bar of bars) {
    const barEnd = bar.timestamp + MINUTE_MS
    for (const entry of [...open.values()]) {
      if (bar.timestamp < entry.signal.entryTime) continue
      const long = entry.signal.direction === "long"
      const stop = entry.stopPrice
      if (long ? bar.open <= stop : bar.open >= stop) { settle(entry, bar.timestamp, bar.open, entry.trailing ? "trailing_stop" : "stop_loss"); continue }
      if (!trailingStart && (long ? bar.open >= entry.targetPrice : bar.open <= entry.targetPrice)) { settle(entry, bar.timestamp, bar.open, "take_profit"); continue }
      if (long ? bar.low <= stop : bar.high >= stop) { settle(entry, barEnd, stop, entry.trailing ? "trailing_stop" : "stop_loss"); continue }
      if (!trailingStart) {
        if (long ? bar.high >= entry.targetPrice : bar.low <= entry.targetPrice) { settle(entry, barEnd, entry.targetPrice, "take_profit"); continue }
      } else {
        entry.bestPrice = long ? Math.max(entry.bestPrice, bar.high) : Math.min(entry.bestPrice, bar.low)
        const movePct = ((entry.bestPrice - entry.signal.entryPrice) / entry.signal.entryPrice) * 100 * (long ? 1 : -1)
        if (movePct >= trailingStart) {
          entry.trailing = true
          const trail = entry.signal.entryPrice + (entry.bestPrice - entry.signal.entryPrice) * (1 - giveBack)
          if (long ? trail > entry.stopPrice : trail < entry.stopPrice) entry.stopPrice = trail
          if (long ? bar.close <= entry.stopPrice : bar.close >= entry.stopPrice) { settle(entry, barEnd, bar.close, "trailing_stop"); continue }
        }
      }
      if (barEnd - entry.signal.entryTime >= maxHoldMs) settle(entry, barEnd, bar.close, "max_hold")
    }
    // Entries decided at this bar's close.
    while (next < ordered.length && ordered[next].entryTime <= barEnd) {
      const signal = ordered[next++]
      if (signal.entryTime !== barEnd) continue
      const key = `${signal.type}|${signal.direction}|${signal.rule}`
      if (open.has(key)) continue
      const long = signal.direction === "long"
      open.set(key, {
        key,
        signal,
        stopPrice: signal.entryPrice * (1 + (long ? -1 : 1) * config.stopLossPct / 100),
        targetPrice: signal.entryPrice * (1 + (long ? 1 : -1) * config.takeProfitPct / 100),
        bestPrice: signal.entryPrice,
        trailing: false,
      })
    }
  }
  return closes
}

export interface ResearchBook {
  trades: number
  wins: number
  losses: number
  netPct: number
  profitFactor: number | null
  /** Largest peak-to-trough fall of the cumulative net, in percent points. */
  maxDrawdownPct: number
  activeHours: number
  profitableHours: number
}

/** Net = gross minus the round-trip cost per trade; PF and drawdown on the net. */
export function bookResearchCloses(closes: readonly ResearchClose[], costPct: number): ResearchBook {
  let gp = 0, gl = 0, wins = 0, losses = 0, equity = 0, peak = 0, maxDrawdown = 0
  const byHour = new Map<number, number>()
  const ordered = [...closes].sort((a, b) => a.exitTime - b.exitTime)
  for (const close of ordered) {
    const net = close.grossPct - costPct
    if (net > 0) { wins++; gp += net } else if (net < 0) { losses++; gl -= net }
    equity += net
    peak = Math.max(peak, equity)
    maxDrawdown = Math.max(maxDrawdown, peak - equity)
    const hour = Math.floor(close.exitTime / 3_600_000)
    byHour.set(hour, (byHour.get(hour) || 0) + net)
  }
  return {
    trades: ordered.length,
    wins,
    losses,
    netPct: equity,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? Number.POSITIVE_INFINITY : null,
    maxDrawdownPct: maxDrawdown,
    activeHours: byHour.size,
    profitableHours: [...byHour.values()].filter((value) => value > 0).length,
  }
}

/** Range class of a target distance in PositionCost multiples (report classes). */
export function rangeClass(takeProfitPct: number, positionCostPct: number): "micro" | "minimum" | "short" | "general" | "long" {
  const multiple = takeProfitPct / (positionCostPct > 0 ? positionCostPct : 0.1)
  if (multiple < 2) return "micro"
  if (multiple < 3) return "minimum"
  if (multiple < 6) return "short"
  if (multiple <= 12) return "general"
  return "long"
}

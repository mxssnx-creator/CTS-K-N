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
  /** The row's own protection (the engine derives it per row); default = the configuration's. */
  takeProfitPct?: number
  stopLossPct?: number
}

const signalTakeProfitPct = (signal: ResearchSignal, config: ExitConfig) =>
  Number(signal.takeProfitPct) > 0 ? Number(signal.takeProfitPct) : config.takeProfitPct
const signalStopLossPct = (signal: ResearchSignal, config: ExitConfig) =>
  Number(signal.stopLossPct) > 0 ? Number(signal.stopLossPct) : config.stopLossPct

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
        stopPrice: signal.entryPrice * (1 + (long ? -1 : 1) * signalStopLossPct(signal, config) / 100),
        targetPrice: signal.entryPrice * (1 + (long ? 1 : -1) * signalTakeProfitPct(signal, config) / 100),
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

// ───────────────────────── maker (post-only) execution ─────────────────────────

export interface MakerExecution {
  /** Limit distance from the decision close, percent, on the favourable side (long: below). */
  entryOffsetPct: number
  /** Minutes the post-only entry rests before it is cancelled. */
  fillWindowMinutes: number
}

export type ExitLeg = "maker" | "taker"

export interface MakerResearchClose extends ResearchClose {
  fillTime: number
  exitLeg: ExitLeg
}

export interface MakerResult {
  closes: MakerResearchClose[]
  /** Entries placed (one per free key). */
  placed: number
  /** Entries cancelled unfilled after the window. */
  missed: number
}

/**
 * Post-only execution on real one-minute bars, conservative by construction:
 *
 *  - the entry rests at the decision close ∓ `entryOffsetPct` and fills only
 *    when a later bar trades THROUGH it (long: low < limit) — a touch is not
 *    a fill, which stands in for the unknown queue position; unfilled after
 *    `fillWindowMinutes` it is cancelled and nothing is booked;
 *  - on the fill bar only the stop can trigger (its order inside the bar is
 *    unknown, so the adverse case is assumed);
 *  - the take profit is a resting reduce-only limit (maker), filled only on a
 *    trade-through of the target; a gap through it fills at the target;
 *  - stop loss, trailing stop and max hold are market exits (taker);
 *  - a bar touching both the stop and the target is a stop.
 *
 * While an entry rests or a position is open, further signals of the same
 * (type, direction, rule) are not new entries.
 */
export function simulateMakerExits(
  bars: readonly ReplayCandle[],
  signals: readonly ResearchSignal[],
  config: ExitConfig,
  maker: MakerExecution,
): MakerResult {
  const closes: MakerResearchClose[] = []
  const trailingStart = Number(config.trailingStartPct) > 0 ? Number(config.trailingStartPct) : null
  const giveBack = Math.min(1, Math.max(0, Number(config.trailingStopRatio) || 0))
  const maxHoldMs = Math.max(MINUTE_MS, Number(config.maxHoldMs) || 4 * 60 * MINUTE_MS)
  const windowMs = Math.max(1, Math.round(maker.fillWindowMinutes)) * MINUTE_MS
  const offset = Math.max(0, Number(maker.entryOffsetPct) || 0)
  const ordered = [...signals].sort((a, b) => a.entryTime - b.entryTime)
  interface Resting { key: string; signal: ResearchSignal; limit: number; expiresAt: number }
  interface Filled { key: string; signal: ResearchSignal; entryPrice: number; fillTime: number; stopPrice: number; targetPrice: number; bestPrice: number; trailing: boolean }
  const resting = new Map<string, Resting>()
  const open = new Map<string, Filled>()
  let placed = 0, missed = 0, next = 0

  const settle = (entry: Filled, exitTime: number, exitPrice: number, reason: ResearchCloseReason, exitLeg: ExitLeg) => {
    const side = entry.signal.direction === "long" ? 1 : -1
    closes.push({
      type: entry.signal.type,
      direction: entry.signal.direction,
      rule: entry.signal.rule,
      entryTime: entry.signal.entryTime,
      fillTime: entry.fillTime,
      exitTime,
      entryPrice: entry.entryPrice,
      exitPrice,
      grossPct: ((exitPrice - entry.entryPrice) / entry.entryPrice) * 100 * side,
      reason,
      exitLeg,
    })
    open.delete(entry.key)
  }

  for (const bar of bars) {
    const barEnd = bar.timestamp + MINUTE_MS
    // 1. Open positions (filled on an earlier bar).
    for (const entry of [...open.values()]) {
      if (bar.timestamp < entry.fillTime) continue
      const long = entry.signal.direction === "long"
      const stop = entry.stopPrice
      const stopReason: ResearchCloseReason = entry.trailing ? "trailing_stop" : "stop_loss"
      if (long ? bar.open <= stop : bar.open >= stop) { settle(entry, bar.timestamp, bar.open, stopReason, "taker"); continue }
      if (!trailingStart && (long ? bar.open > entry.targetPrice : bar.open < entry.targetPrice)) { settle(entry, bar.timestamp, entry.targetPrice, "take_profit", "maker"); continue }
      if (long ? bar.low <= stop : bar.high >= stop) { settle(entry, barEnd, stop, stopReason, "taker"); continue }
      if (!trailingStart) {
        if (long ? bar.high > entry.targetPrice : bar.low < entry.targetPrice) { settle(entry, barEnd, entry.targetPrice, "take_profit", "maker"); continue }
      } else {
        entry.bestPrice = long ? Math.max(entry.bestPrice, bar.high) : Math.min(entry.bestPrice, bar.low)
        const movePct = ((entry.bestPrice - entry.entryPrice) / entry.entryPrice) * 100 * (long ? 1 : -1)
        if (movePct >= trailingStart) {
          entry.trailing = true
          const trail = entry.entryPrice + (entry.bestPrice - entry.entryPrice) * (1 - giveBack)
          if (long ? trail > entry.stopPrice : trail < entry.stopPrice) entry.stopPrice = trail
          if (long ? bar.close <= entry.stopPrice : bar.close >= entry.stopPrice) { settle(entry, barEnd, bar.close, "trailing_stop", "taker"); continue }
        }
      }
      if (barEnd - entry.fillTime >= maxHoldMs) settle(entry, barEnd, bar.close, "max_hold", "taker")
    }
    // 2. Resting entries: fill on a trade-through, else expire.
    for (const order of [...resting.values()]) {
      if (bar.timestamp < order.signal.entryTime) continue
      if (bar.timestamp >= order.expiresAt) { resting.delete(order.key); missed++; continue }
      const long = order.signal.direction === "long"
      if (!(long ? bar.low < order.limit : bar.high > order.limit)) continue
      resting.delete(order.key)
      // A gap through the limit fills at the open, which is better for the maker.
      const entryPrice = long ? Math.min(order.limit, bar.open) : Math.max(order.limit, bar.open)
      const filled: Filled = {
        key: order.key,
        signal: order.signal,
        entryPrice,
        fillTime: bar.timestamp,
        stopPrice: entryPrice * (1 + (long ? -1 : 1) * signalStopLossPct(order.signal, config) / 100),
        targetPrice: entryPrice * (1 + (long ? 1 : -1) * signalTakeProfitPct(order.signal, config) / 100),
        bestPrice: entryPrice,
        trailing: false,
      }
      open.set(order.key, filled)
      // Fill bar: only the adverse exit is assumed possible.
      if (long ? bar.low <= filled.stopPrice : bar.high >= filled.stopPrice) settle(filled, barEnd, filled.stopPrice, "stop_loss", "taker")
      else filled.fillTime = barEnd
    }
    // 3. Entries decided at this bar's close.
    while (next < ordered.length && ordered[next].entryTime <= barEnd) {
      const signal = ordered[next++]
      if (signal.entryTime !== barEnd) continue
      const key = `${signal.type}|${signal.direction}|${signal.rule}`
      if (open.has(key) || resting.has(key)) continue
      const long = signal.direction === "long"
      resting.set(key, {
        key,
        signal,
        limit: signal.entryPrice * (1 + (long ? -1 : 1) * offset / 100),
        expiresAt: barEnd + windowMs,
      })
      placed++
    }
  }
  missed += resting.size
  return { closes, placed, missed }
}

export interface LegCosts {
  /** Percent per maker leg. */
  makerPct: number
  /** Percent per taker leg, fee plus slippage. */
  takerPct: number
}

/** Round-trip cost of one maker-entry close: maker entry plus its exit leg. */
export function makerRoundTripPct(close: Pick<MakerResearchClose, "exitLeg">, costs: LegCosts): number {
  return costs.makerPct + (close.exitLeg === "maker" ? costs.makerPct : costs.takerPct)
}

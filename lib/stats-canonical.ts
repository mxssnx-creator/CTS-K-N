/**
 * The one definition of every headline trade statistic (operator decision
 * 2026-10-14). Every route and panel that shows a win rate, a profit factor
 * or a percentage computes it here, so two panels can never disagree on the
 * same number:
 *
 *  - win rate = wins / (wins + losses) in percent; break-evens are excluded;
 *    null when there is no decided trade (never a fabricated 0 %);
 *  - profit factor = gross profit / gross loss on venue-net USD; with profit
 *    and no loss it is reported as `infinite` (value null), never as a 999
 *    sentinel that averages and sorts as a real number;
 *  - percentages are finite and clamped to 0–100; null on an empty total.
 */

export interface ProfitFactorValue {
  /** null when undefined (no trades) or infinite (profit, no loss) */
  value: number | null
  infinite: boolean
}

function finite(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

/** wins / (wins + losses) × 100, one decimal; null without a decided trade. */
export function winRatePct(wins: unknown, losses: unknown): number | null {
  const w = Math.max(0, finite(wins))
  const l = Math.max(0, finite(losses))
  return w + l > 0 ? round((w / (w + l)) * 100, 1) : null
}

/** gross profit / gross loss (both as positive amounts), three decimals. */
export function profitFactor(grossProfit: unknown, grossLoss: unknown): ProfitFactorValue {
  const profit = Math.max(0, finite(grossProfit))
  const loss = Math.abs(finite(grossLoss))
  if (loss > 0) return { value: round(profit / loss, 3), infinite: false }
  if (profit > 0) return { value: null, infinite: true }
  return { value: null, infinite: false }
}

/** The profit factor of signed results (venue-net PnL per closed trade). */
export function profitFactorOf(results: readonly unknown[]): ProfitFactorValue {
  let profit = 0
  let loss = 0
  for (const raw of results) {
    const value = finite(raw)
    if (value > 0) profit += value
    else if (value < 0) loss -= value
  }
  return profitFactor(profit, loss)
}

/** part / total × 100, finite and clamped to 0–100, one decimal; null on an empty total. */
export function pct(part: unknown, total: unknown): number | null {
  const t = finite(total)
  if (!(t > 0)) return null
  return round(Math.min(100, Math.max(0, (finite(part) / t) * 100)), 1)
}

/** A percentage already computed elsewhere, made finite and clamped (null when not a number). */
export function clampPct(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return round(Math.min(100, Math.max(0, parsed)), 1)
}

/**
 * Records a value that must not be negative instead of hiding it. Returns the
 * value clamped at 0 for display; the violation list is surfaced as
 * dataIntegrity.violations so a broken counter is visible, not silent.
 */
export function nonNegative(value: unknown, field: string, violations: string[]): number {
  const parsed = finite(value)
  if (parsed < 0) {
    violations.push(`${field}=${parsed} is negative`)
    return 0
  }
  return parsed
}

/**
 * A counter shown across polls must never go backwards within a run: a
 * source that resets (restart, key rotation) or a fallback chain that falls
 * through to a smaller source would make the dashboard jump down. The
 * high-water mark is kept per scope in process and reset when the run
 * (engine start) changes.
 */
const HIGH_WATER = new Map<string, { run: string; value: number }>()
const HIGH_WATER_LIMIT = 4_096

export function monotonic(scope: string, run: string, value: unknown): number {
  const current = Math.max(0, finite(value))
  const previous = HIGH_WATER.get(scope)
  const next = previous && previous.run === run ? Math.max(previous.value, current) : current
  HIGH_WATER.delete(scope)
  HIGH_WATER.set(scope, { run, value: next })
  if (HIGH_WATER.size > HIGH_WATER_LIMIT) {
    const oldest = HIGH_WATER.keys().next().value
    if (oldest !== undefined) HIGH_WATER.delete(oldest)
  }
  return next
}

/** Test helper. */
export function resetMonotonicForTests(): void {
  HIGH_WATER.clear()
}

/** Signed venue-net result of a closed row (realizedPnL → realized_pnl → pnl). */
export function closedRowPnl(row: Record<string, any> | null | undefined): number {
  return finite(row?.realizedPnL ?? row?.realized_pnl ?? row?.pnl)
}

/** Win rate and profit factor of the newest `limit` closed rows (rows newest first). */
export function closedWindowStats(rows: readonly Record<string, any>[], limit?: number) {
  const window = typeof limit === "number" ? rows.slice(0, Math.max(0, Math.floor(limit))) : rows
  let wins = 0
  let losses = 0
  const results: number[] = []
  for (const row of window) {
    const pnl = closedRowPnl(row)
    results.push(pnl)
    if (pnl > 0) wins++
    else if (pnl < 0) losses++
  }
  return { trades: window.length, wins, losses, winRate: winRatePct(wins, losses), profitFactor: profitFactorOf(results) }
}

type AnyRecord = Record<string, any>

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** Numeric leaves that can never be negative (counts, volumes, durations). */
const NON_NEGATIVE_KEY = /(count|Count|Cycles|cycles|open|Open|closed|Closed|created|Created|total|Total|placed|Placed|filled|Filled|volume|Volume|symbols|Symbols|Sets|sets|evaluated|passed|failed|wins|losses|entries|Entries|Ms)$/
const SIGNED_KEY = /(pnl|Pnl|PnL|roi|Roi|ROI|delta|Delta|R$|Price|price|drift|Drift|offset|Offset|change|Change)/

function collectNegativeCounters(value: unknown, path: string, out: string[], depth = 0): void {
  if (depth > 6 || out.length > 40) return
  if (Array.isArray(value)) return
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key
    if (typeof child === "number") {
      if (child < 0 && NON_NEGATIVE_KEY.test(key) && !SIGNED_KEY.test(key)) out.push(`${childPath}=${child} is negative`)
    } else if (isRecord(child)) {
      collectNegativeCounters(child, childPath, out, depth + 1)
    }
  }
}

/**
 * One value per statistic across the progression stats payload (operator
 * decision 2026-10-14): the live execution summary is the single source of
 * open positions, wins/losses, realized PnL, win rate and profit factor, and
 * every other block that shows one of those numbers is set from it. The
 * former per-block computations (created − closed counters, the newest 200
 * rows, break-evens counted as non-wins, R-multiple PF with a 999 sentinel)
 * disagreed with each other. The R-multiple PF stays available as
 * `avgProfitFactorR` for Set ranking. Mutates and returns the payload.
 */
export function canonicalizeProgressionStats<T extends AnyRecord>(body: T, extraViolations: string[] = []): T {
  const violations: string[] = [...extraViolations]
  const exec: AnyRecord = isRecord(body.liveExecution) ? body.liveExecution : {}
  const openLive = isRecord(body.openPositions) && isRecord(body.openPositions.live) ? body.openPositions.live : null

  const wins = Math.max(0, finite(exec.wins))
  const losses = Math.max(0, finite(exec.losses))
  const breakEven = Math.max(0, finite(exec.breakEven))
  const realizedPnl = finite(exec.realizedPnl)
  const grossProfit = finite(exec.avgWin) * wins
  const grossLoss = Math.abs(finite(exec.avgLoss)) * losses
  const winRate = winRatePct(wins, losses)
  const pf = profitFactor(grossProfit, grossLoss)
  const open = openLive ? Math.max(0, finite(openLive.open)) : Math.max(0, finite(exec.openPositions))
  const pending = Math.max(0, finite(exec.openPositions) - open)

  const canonical = {
    openPositions: open,
    pendingEntries: pending,
    wins,
    losses,
    breakEven,
    decidedTrades: wins + losses,
    realizedPnl: round(realizedPnl, 8),
    winRate,
    profitFactor: pf.value,
    profitFactorInfinite: pf.infinite,
    definition: "venue-net; win rate = wins / (wins + losses), break-evens excluded; PF = gross profit / gross loss (USD)",
  }

  if (isRecord(body.liveExecution)) {
    Object.assign(body.liveExecution, {
      openPositions: open,
      pendingEntries: pending,
      winRate,
      profitFactor: pf.value,
      profitFactorInfinite: pf.infinite,
    })
  }

  const liveTier = isRecord(body.performanceTiers) && isRecord(body.performanceTiers.live) ? body.performanceTiers.live : null
  if (liveTier) {
    Object.assign(liveTier, {
      totalRunning: open,
      totalPnl: round(realizedPnl, 2),
      winRate,
      avgProfitFactor: pf.value,
      avgProfitFactorInfinite: pf.infinite,
    })
  }

  const detailLive = isRecord(body.strategyDetail) && isRecord(body.strategyDetail.live) ? body.strategyDetail.live : null
  if (detailLive) {
    Object.assign(detailLive, {
      avgProfitFactorR: detailLive.avgProfitFactorR ?? detailLive.avgProfitFactor,
      avgProfitFactor: pf.value,
      avgProfitFactorInfinite: pf.infinite,
      winRate,
      totalPnl: round(realizedPnl, 2),
      openPositions: open,
      setsRunningNow: open,
      setsWithOpenPositions: open,
      passRatio: clampPct(detailLive.passRatio),
      evalPct: clampPct(detailLive.evalPct),
    })
  }

  const realtimePositions = isRecord(body.realtime) && isRecord(body.realtime.positions) ? body.realtime.positions : null
  if (realtimePositions) {
    realtimePositions.open = open
    if (isRecord(realtimePositions.winRate)) realtimePositions.winRate.all = winRate
    if (isRecord(realtimePositions.profitFactor)) {
      realtimePositions.profitFactor.all = pf.value
      realtimePositions.profitFactor.allInfinite = pf.infinite
    }
  }
  if (isRecord(body.realtime) && "successRate" in body.realtime) body.realtime.successRate = clampPct(body.realtime.successRate)
  if ("cycleSuccessRate" in body) (body as AnyRecord).cycleSuccessRate = clampPct((body as AnyRecord).cycleSuccessRate)

  collectNegativeCounters(body, "", violations)
  ;(body as AnyRecord).canonicalStats = canonical
  const integrity: AnyRecord = isRecord((body as AnyRecord).dataIntegrity) ? (body as AnyRecord).dataIntegrity : {}
  integrity.violations = [...new Set(violations)]
  integrity.consistent = integrity.violations.length === 0
  ;(body as AnyRecord).dataIntegrity = integrity
  return body
}

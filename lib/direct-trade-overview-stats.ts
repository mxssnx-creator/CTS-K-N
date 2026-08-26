/**
 * Canonical 48-hour Direct-Trade overview metrics.
 *
 * Direct-Trade keeps simulated and exchange positions in one durable list.
 * This projection deliberately separates those environments before applying
 * one mutually-exclusive strategy classification. Open positions never enter
 * realised PF or equity-curve DDT.
 */

export const DIRECT_TRADE_OVERVIEW_WINDOW_HOURS = 48
export const DIRECT_TRADE_OVERVIEW_WINDOW_MS =
  DIRECT_TRADE_OVERVIEW_WINDOW_HOURS * 60 * 60 * 1000

export type DirectTradeOverviewMode = "simulated" | "exchange"
export type DirectTradeOverviewCategory = "general" | "trailing" | "block" | "dca"
export type DirectTradeOverviewPnlBasis = "usdt" | "percent"

export interface DirectTradeOverviewRow {
  category: DirectTradeOverviewCategory
  open: number
  closed: number
  /** Closed exchange rows still waiting for authoritative venue settlement. */
  accountingPending: number
  /** Gross profit divided by absolute gross loss across all rows in the bucket. */
  profitFactor: number | null
  profitFactorInfinite: boolean
  pnlBasis: DirectTradeOverviewPnlBasis
  grossProfit: number
  grossLoss: number
  netPnl: number
  averagePositionPnl: number
  /** Sum of completed and current equity-curve drawdown episode durations. */
  overallDrawdownTimeMin: number
  /** Longest single equity-curve drawdown episode in the selected window. */
  maxDrawdownEpisodeMin: number
  /** Duration of the unfinished drawdown at window end, otherwise zero. */
  currentDrawdownTimeMin: number
}

export interface DirectTradeOverviewEnvironment {
  mode: DirectTradeOverviewMode
  rows: DirectTradeOverviewRow[]
}

export interface DirectTradeOverview48h {
  windowHours: typeof DIRECT_TRADE_OVERVIEW_WINDOW_HOURS
  windowFrom: string
  windowTo: string
  environments: DirectTradeOverviewEnvironment[]
}

type UnknownPosition = Record<string, unknown>

const CATEGORY_ORDER: DirectTradeOverviewCategory[] = [
  "general",
  "trailing",
  "block",
  "dca",
]

function finite(value: unknown): number | null {
  if (value === undefined || value === null || typeof value === "boolean") return null
  if (typeof value === "string" && value.trim() === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function firstFinite(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = finite(value)
    if (parsed !== null) return parsed
  }
  return null
}

function timestamp(value: unknown): number | null {
  if (value instanceof Date) {
    const parsed = value.getTime()
    return Number.isFinite(parsed) ? parsed : null
  }
  if (typeof value === "number" || (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) return null
    // Accept both Unix seconds and JavaScript milliseconds for legacy rows.
    return parsed < 10_000_000_000 ? parsed * 1000 : parsed
  }
  if (typeof value !== "string" || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function closedAt(position: UnknownPosition): number | null {
  return timestamp(
    position.closedAt ??
    position.closed_at ??
    position.exitTime ??
    position.exit_time ??
    position.updatedAt,
  )
}

function overviewMode(position: UnknownPosition): DirectTradeOverviewMode {
  const explicit = String(
    position.mode ?? position.executionMode ?? position.execution_mode ?? "",
  ).trim().toLowerCase()
  if (explicit === "live" || explicit === "exchange" || explicit === "real") {
    return "exchange"
  }
  return "simulated"
}

function hasDcaLeg(position: UnknownPosition): boolean {
  return Array.isArray(position.dcaLegs) && position.dcaLegs.length > 0
}

function hasBlockLeg(position: UnknownPosition): boolean {
  const legs = Array.isArray(position.positionLegs)
    ? position.positionLegs
    : Array.isArray(position.blockLegs)
      ? position.blockLegs
      : []
  return legs.some((leg) => {
    if (!leg || typeof leg !== "object") return false
    return Number((leg as UnknownPosition).blockCount) > 0
  })
}

export function directTradeOverviewCategory(
  position: UnknownPosition,
): DirectTradeOverviewCategory {
  const strategyType = String(
    position.strategyType ?? position.strategy_type ?? "",
  ).trim().toLowerCase()

  // Priority makes the four overview rows mutually exclusive. A DCA position
  // also stores compatibility position legs, but it must never leak into Block.
  if (strategyType === "dca" || hasDcaLeg(position) || position.dcaProfile) {
    return "dca"
  }
  if (
    Number(position.blockCount) > 0 ||
    Number(position.blockAddedCount) > 0 ||
    hasBlockLeg(position)
  ) {
    return "block"
  }
  const trailingMode = String(position.trailingMode ?? position.trailing_mode ?? "")
    .trim()
    .toLowerCase()
  if (
    position.trailing === true ||
    position.trailingEnabled === true ||
    strategyType === "trailing_fixed" ||
    strategyType === "trailing_auto" ||
    (strategyType === "combination" && trailingMode !== "" && trailingMode !== "none")
  ) {
    return "trailing"
  }
  return "general"
}

export function resolveDirectTradeSettledExchangePnlUsdt(
  position: UnknownPosition,
): number | null {
  // Direct-Trade live accounting is deliberately stricter than the generic
  // legacy live-position projection: only an explicit completed settlement is
  // allowed into money-denominated PF/PnL statistics.
  if (position.pnlAccountingComplete !== true) return null
  return firstFinite(
    position.realizedPnlUsdt,
    position.realizedPnLUsdt,
    position.realized_pnl_usdt,
  )
}

function canonicalUsdtPnl(position: UnknownPosition): number | null {
  if (overviewMode(position) === "exchange") {
    return resolveDirectTradeSettledExchangePnlUsdt(position)
  }
  const explicit = firstFinite(
    position.realizedPnlUsdt,
    position.realizedPnLUsdt,
    position.realized_pnl_usdt,
  )
  if (explicit !== null) return explicit

  const pnlPercent = firstFinite(position.pnl, position.pnlPercent)
  const baseNotional = firstFinite(
    position.baseEntryNotionalUsdt,
    position.initialEntryNotionalUsdt,
  )
  if (pnlPercent !== null && baseNotional !== null && baseNotional > 0) {
    return baseNotional * pnlPercent / 100
  }
  return null
}

function percentPnl(position: UnknownPosition): number {
  return firstFinite(position.pnl, position.pnlPercent) ?? 0
}

function calculateDrawdownDurations(
  chronological: Array<{ at: number; pnl: number }>,
  now: number,
): Pick<
  DirectTradeOverviewRow,
  "overallDrawdownTimeMin" | "maxDrawdownEpisodeMin" | "currentDrawdownTimeMin"
> {
  let equity = 0
  let peak = 0
  let drawdownStartedAt: number | null = null
  let overallMs = 0
  let maximumMs = 0

  for (const event of chronological) {
    equity += event.pnl
    if (equity >= peak) {
      peak = equity
      if (drawdownStartedAt !== null) {
        const duration = Math.max(0, event.at - drawdownStartedAt)
        overallMs += duration
        maximumMs = Math.max(maximumMs, duration)
        drawdownStartedAt = null
      }
    } else if (drawdownStartedAt === null) {
      drawdownStartedAt = event.at
    }
  }

  const currentMs = drawdownStartedAt === null
    ? 0
    : Math.max(0, now - drawdownStartedAt)
  overallMs += currentMs
  maximumMs = Math.max(maximumMs, currentMs)

  return {
    overallDrawdownTimeMin: Number((overallMs / 60_000).toFixed(1)),
    maxDrawdownEpisodeMin: Number((maximumMs / 60_000).toFixed(1)),
    currentDrawdownTimeMin: Number((currentMs / 60_000).toFixed(1)),
  }
}

function buildRow(
  mode: DirectTradeOverviewMode,
  category: DirectTradeOverviewCategory,
  openPositions: UnknownPosition[],
  closedPositions: UnknownPosition[],
  now: number,
): DirectTradeOverviewRow {
  const accountedClosedPositions = mode === "exchange"
    ? closedPositions.filter((position) => canonicalUsdtPnl(position) !== null)
    : closedPositions
  // Never mix currency and percentage values in one PF. Exchange rows always
  // use actual USDT settlement and unresolved rows remain visibly pending.
  const useUsdt = mode === "exchange" || (accountedClosedPositions.length > 0 &&
    accountedClosedPositions.every((position) => canonicalUsdtPnl(position) !== null))
  const value = (position: UnknownPosition) => useUsdt
    ? canonicalUsdtPnl(position) ?? 0
    : percentPnl(position)
  const chronological = accountedClosedPositions
    .map((position) => ({ at: closedAt(position), pnl: value(position) }))
    .filter((event): event is { at: number; pnl: number } => event.at !== null)
    .sort((left, right) => left.at - right.at)

  const grossProfit = chronological.reduce(
    (sum, event) => sum + (event.pnl > 0 ? event.pnl : 0),
    0,
  )
  const grossLoss = Math.abs(chronological.reduce(
    (sum, event) => sum + (event.pnl < 0 ? event.pnl : 0),
    0,
  ))
  const netPnl = grossProfit - grossLoss
  const profitFactorInfinite = grossLoss === 0 && grossProfit > 0
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null

  return {
    category,
    open: openPositions.length,
    closed: chronological.length,
    accountingPending: closedPositions.length - accountedClosedPositions.length,
    profitFactor: profitFactor === null ? null : Number(profitFactor.toFixed(3)),
    profitFactorInfinite,
    pnlBasis: useUsdt ? "usdt" : "percent",
    grossProfit: Number(grossProfit.toFixed(8)),
    grossLoss: Number(grossLoss.toFixed(8)),
    netPnl: Number(netPnl.toFixed(8)),
    averagePositionPnl: chronological.length > 0
      ? Number((netPnl / chronological.length).toFixed(8))
      : 0,
    ...calculateDrawdownDurations(chronological, now),
  }
}

export function buildDirectTradeOverview48h(
  rawPositions: unknown,
  now = Date.now(),
): DirectTradeOverview48h {
  const positions = Array.isArray(rawPositions)
    ? rawPositions.filter(
        (position): position is UnknownPosition =>
          Boolean(position) && typeof position === "object" && !Array.isArray(position),
      )
    : []
  const since = now - DIRECT_TRADE_OVERVIEW_WINDOW_MS

  const environments = (["simulated", "exchange"] as DirectTradeOverviewMode[])
    .map((mode) => {
      const modePositions = positions.filter((position) => overviewMode(position) === mode)
      const openPositions = modePositions.filter((position) => {
        const status = String(position.status || "").toLowerCase()
        // `opening` is a durable, actively reconciled exchange strategy. Keep
        // it visible in Open instead of briefly hiding real exposure from the
        // overview while its venue acknowledgement becomes authoritative.
        return status === "open" || status === "opening"
      })
      const closedPositions = modePositions.filter((position) => {
        if (String(position.status || "").toLowerCase() !== "closed") return false
        const at = closedAt(position)
        return at !== null && at >= since && at <= now
      })

      return {
        mode,
        rows: CATEGORY_ORDER.map((category) => buildRow(
          mode,
          category,
          openPositions.filter(
            (position) => directTradeOverviewCategory(position) === category,
          ),
          closedPositions.filter(
            (position) => directTradeOverviewCategory(position) === category,
          ),
          now,
        )),
      }
    })

  return {
    windowHours: DIRECT_TRADE_OVERVIEW_WINDOW_HOURS,
    windowFrom: new Date(since).toISOString(),
    windowTo: new Date(now).toISOString(),
    environments,
  }
}

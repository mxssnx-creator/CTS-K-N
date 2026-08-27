import {
  DIRECT_TRADE_ENTRY_TACTICS,
  type DirectTradeEntryTactic,
} from "@/lib/direct-trade-coordination"
import { resolveDirectTradeSettledExchangePnlUsdt } from "@/lib/direct-trade-overview-stats"

type CalculationAxisBucket = {
  evaluated?: number
  valid?: number
  disabled?: number
  totalPnl?: number
  averagePnlPerSet?: number
  profitFactor?: number | null
  profitFactorInfinite?: boolean
}

export interface DirectTradeIndicationTypeStatsRow {
  indicationType: DirectTradeEntryTactic
  liveEntryEnabled: boolean
  openPositions: number
  closedPositions: number
  accountingPending: number
  wins: number
  losses: number
  breakeven: number
  netPnlPercent: number
  netExchangePnlUsdt: number | null
  positionCostPercent: number
  profitFactor: number | null
  profitFactorInfinite: boolean
  profitFactorCoordinate: number | null
  internalEvaluated: number
  internalValid: number
  internalDisabled: number
  internalTotalPnl: number
  internalAveragePnlPerSet: number
  internalProfitFactor: number | null
  internalProfitFactorInfinite: boolean
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function finiteOrNull(value: unknown): number | null {
  if (value === undefined || value === null || typeof value === "boolean") return null
  if (typeof value === "string" && value.trim() === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function rounded(value: number, digits = 8): number {
  return Number(value.toFixed(digits))
}

export function directTradePositionIndicationType(position: any): DirectTradeEntryTactic | null {
  const explicit = String(position?.entryTactic || position?.indicationType || "").trim().toLowerCase()
  if (DIRECT_TRADE_ENTRY_TACTICS.includes(explicit as DirectTradeEntryTactic)) {
    return explicit as DirectTradeEntryTactic
  }
  const identity = String(position?.configKey || position?.setKey || position?.entrySignalKey || "")
  const match = identity.match(/(?:^|\|)entry:(momentum|mean_reversion|breakout|relative)(?:\||$)/)
  return match?.[1] as DirectTradeEntryTactic | undefined || null
}

function realizedPositionCostPercent(position: any): number {
  const base = Math.max(0, finite(position?.positionCostPercent, 0.1))
  const multiplier = Math.max(
    1,
    finite(position?.blockRealizedVolumeMultiplier, 1),
    finite(position?.dcaRealizedVolumeMultiplier, 1),
  )
  return base * multiplier
}

export function buildDirectTradeIndicationTypeStats(input: {
  positions: any[]
  calculation?: { byEntryTactic?: Record<string, CalculationAxisBucket> } | null
  selectedMode: "live" | "simulated"
  enabledIndicationTypes?: readonly DirectTradeEntryTactic[]
}): DirectTradeIndicationTypeStatsRow[] {
  const positions = Array.isArray(input.positions) ? input.positions : []
  const enabled = new Set(input.enabledIndicationTypes || [])

  return DIRECT_TRADE_ENTRY_TACTICS.map((indicationType) => {
    const typed = positions.filter((position) => {
      const rawMode = String(position?.mode ?? position?.executionMode ?? "").trim().toLowerCase()
      const mode = ["live", "exchange", "real"].includes(rawMode) ? "live" : "simulated"
      return mode === input.selectedMode && directTradePositionIndicationType(position) === indicationType
    })
    const openPositions = typed.filter((position) => (
      ["open", "opening"].includes(String(position?.status || "").trim().toLowerCase())
    )).length
    const closed = typed.filter((position) => String(position?.status || "").trim().toLowerCase() === "closed")
    const accounted = closed.filter((position) => {
      if (finiteOrNull(position?.pnl) === null) return false
      return input.selectedMode !== "live"
        || resolveDirectTradeSettledExchangePnlUsdt(position) !== null
    })
    const accountingPending = closed.length - accounted.length
    const resultValue = (position: any) => input.selectedMode === "live"
      ? resolveDirectTradeSettledExchangePnlUsdt(position) ?? 0
      : finiteOrNull(position?.pnl) ?? 0
    const wins = accounted.filter((position) => resultValue(position) > 1e-12).length
    const losses = accounted.filter((position) => resultValue(position) < -1e-12).length
    const breakeven = accounted.length - wins - losses
    const grossProfit = accounted.reduce(
      (sum, position) => sum + Math.max(0, resultValue(position)),
      0,
    )
    const grossLoss = Math.abs(accounted.reduce(
      (sum, position) => sum + Math.min(0, resultValue(position)),
      0,
    ))
    const profitFactorInfinite = grossLoss === 0 && grossProfit > 0
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null
    const netPnlPercent = accounted.reduce((sum, position) => sum + finite(position?.pnl), 0)
    const positionCostPercent = accounted.reduce(
      (sum, position) => sum + realizedPositionCostPercent(position),
      0,
    )
    const profitFactorCoordinate = accounted.length > 0 && positionCostPercent > 0
      ? 1 + 0.1 * (netPnlPercent / positionCostPercent)
      : null
    const bucket = input.calculation?.byEntryTactic?.[indicationType] || {}

    return {
      indicationType,
      liveEntryEnabled: enabled.has(indicationType),
      openPositions,
      closedPositions: accounted.length,
      accountingPending,
      wins,
      losses,
      breakeven,
      netPnlPercent: rounded(netPnlPercent),
      netExchangePnlUsdt: input.selectedMode === "live"
        ? rounded(accounted.reduce(
            (sum, position) => sum + (resolveDirectTradeSettledExchangePnlUsdt(position) ?? 0),
            0,
          ))
        : null,
      positionCostPercent: rounded(positionCostPercent),
      profitFactor: profitFactor == null ? null : rounded(profitFactor),
      profitFactorInfinite,
      profitFactorCoordinate: profitFactorCoordinate == null ? null : rounded(profitFactorCoordinate),
      internalEvaluated: Math.max(0, Math.floor(finite(bucket.evaluated))),
      internalValid: Math.max(0, Math.floor(finite(bucket.valid))),
      internalDisabled: Math.max(0, Math.floor(finite(bucket.disabled))),
      internalTotalPnl: rounded(finite(bucket.totalPnl)),
      internalAveragePnlPerSet: rounded(finite(bucket.averagePnlPerSet)),
      internalProfitFactor: Number.isFinite(Number(bucket.profitFactor))
        ? rounded(Number(bucket.profitFactor))
        : null,
      internalProfitFactorInfinite: bucket.profitFactorInfinite === true,
    }
  })
}

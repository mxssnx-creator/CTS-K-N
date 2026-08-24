import type { TrailingProfile } from "@/lib/signal-trailing"
import {
  MAX_STOP_LOSS_TO_TAKE_PROFIT_RATIO,
  normalizeProtectionPercentages,
} from "@/lib/trade-protection-contract"

export const SIGNAL_TAKE_PROFIT_MIN_PCT = 1
export const SIGNAL_TAKE_PROFIT_MAX_PCT = 5
export const SIGNAL_TAKE_PROFIT_STEP_PCT = 0.5
export const SIGNAL_STOP_LOSS_TO_TP_MIN_RATIO = 0.5
export const SIGNAL_STOP_LOSS_TO_TP_MAX_RATIO = MAX_STOP_LOSS_TO_TAKE_PROFIT_RATIO
export const SIGNAL_STOP_LOSS_TO_TP_STEP_RATIO = 0.5
export const SIGNAL_TRAILING_STOP_MIN_PCT = 0.8
export const SIGNAL_TRAILING_STOP_MAX_PCT = 2.4
export const SIGNAL_TRAILING_STOP_STEP_PCT = 0.4

export interface SignalTradeConfiguration {
  id: string
  takeProfitPct: number
  stopLossToTakeProfitRatio: number
  stopLossPct: number
  trailingStopPct: number | null
  trailing: boolean
}

function inclusiveRange(min: number, max: number, step: number): number[] {
  const values: number[] = []
  for (let value = min; value <= max + Number.EPSILON; value += step) {
    values.push(Number(value.toFixed(8)))
  }
  return values
}

export const SIGNAL_TAKE_PROFIT_VALUES = Object.freeze(inclusiveRange(
  SIGNAL_TAKE_PROFIT_MIN_PCT,
  SIGNAL_TAKE_PROFIT_MAX_PCT,
  SIGNAL_TAKE_PROFIT_STEP_PCT,
))
export const SIGNAL_STOP_LOSS_TO_TP_VALUES = Object.freeze(inclusiveRange(
  SIGNAL_STOP_LOSS_TO_TP_MIN_RATIO,
  SIGNAL_STOP_LOSS_TO_TP_MAX_RATIO,
  SIGNAL_STOP_LOSS_TO_TP_STEP_RATIO,
))
export const SIGNAL_TRAILING_STOP_VALUES = Object.freeze(inclusiveRange(
  SIGNAL_TRAILING_STOP_MIN_PCT,
  SIGNAL_TRAILING_STOP_MAX_PCT,
  SIGNAL_TRAILING_STOP_STEP_PCT,
))

function token(value: number): string {
  return value.toFixed(2).replace(".", "_")
}

/**
 * Full Signal matrix: every TP × SL relation gets one standard Set and one
 * independent Set for every configured trailing-stop distance.
 */
export function buildSignalTradeConfigurations(input?: {
  takeProfitValues?: readonly number[]
  stopLossToTakeProfitValues?: readonly number[]
  trailingStopValues?: readonly number[]
  trailingEnabled?: boolean
  trailingOnly?: boolean
}): SignalTradeConfiguration[] {
  const takeProfits = input?.takeProfitValues || SIGNAL_TAKE_PROFIT_VALUES
  const stopLossRatios = Array.from(new Set(
    (input?.stopLossToTakeProfitValues || SIGNAL_STOP_LOSS_TO_TP_VALUES)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => Math.min(SIGNAL_STOP_LOSS_TO_TP_MAX_RATIO, value)),
  ))
  const trailingStops = input?.trailingStopValues || SIGNAL_TRAILING_STOP_VALUES
  const trailingEnabled = input?.trailingEnabled !== false
  const trailingOnly = input?.trailingOnly === true
  const result: SignalTradeConfiguration[] = []
  for (const takeProfitPct of takeProfits) {
    for (const stopLossToTakeProfitRatio of stopLossRatios) {
      const protection = normalizeProtectionPercentages({
        takeProfitPct,
        stopLossPct: takeProfitPct * stopLossToTakeProfitRatio,
        minimumTakeProfitPct: SIGNAL_TAKE_PROFIT_MIN_PCT,
        minimumStopLossPct: 0.01,
        maxStopLossToTakeProfitRatio: SIGNAL_STOP_LOSS_TO_TP_MAX_RATIO,
      })
      const effectiveTakeProfitPct = Number(protection.takeProfitPct.toFixed(8))
      const effectiveStopLossPct = Number(protection.stopLossPct.toFixed(8))
      const effectiveStopLossToTakeProfitRatio = Number(
        protection.stopLossToTakeProfitRatio.toFixed(8),
      )
      if (!trailingOnly) {
        result.push({
          id: `tp${token(effectiveTakeProfitPct)}:slr${token(effectiveStopLossToTakeProfitRatio)}:standard`,
          takeProfitPct: effectiveTakeProfitPct,
          stopLossToTakeProfitRatio: effectiveStopLossToTakeProfitRatio,
          stopLossPct: effectiveStopLossPct,
          trailingStopPct: null,
          trailing: false,
        })
      }
      if (trailingEnabled) {
        for (const trailingStopPct of trailingStops) {
          result.push({
            id:
              `tp${token(effectiveTakeProfitPct)}:slr${token(effectiveStopLossToTakeProfitRatio)}` +
              `:trail${token(trailingStopPct)}`,
            takeProfitPct: effectiveTakeProfitPct,
            stopLossToTakeProfitRatio: effectiveStopLossToTakeProfitRatio,
            stopLossPct: effectiveStopLossPct,
            trailingStopPct,
            trailing: true,
          })
        }
      }
    }
  }
  return result
}

export function signalConfigurationTrailingProfile(
  config: SignalTradeConfiguration,
  input?: {
    startPct?: number
    positiveMoveRatio?: number
    updateStopRangeRatio?: number
  },
): TrailingProfile | undefined {
  if (!config.trailing || !(Number(config.trailingStopPct) > 0)) return undefined
  const minStopRatio = Number(config.trailingStopPct) / 100
  const updateStopRangeRatio = Math.max(
    0.1,
    Math.min(1, Number(input?.updateStopRangeRatio) || 0.5),
  )
  return {
    mode: "signal_dynamic",
    startRatio: Math.max(0, Number(input?.startPct) || 0) / 100,
    stopRatio: minStopRatio,
    stepRatio: minStopRatio * updateStopRangeRatio,
    minStopRatio,
    positiveMoveRatio: Math.max(
      0.05,
      Math.min(1, Number(input?.positiveMoveRatio) || 0.4),
    ),
    updateStopRangeRatio,
  }
}

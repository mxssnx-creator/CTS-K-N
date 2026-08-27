/**
 * Canonical execution policy for the main-trade strategy families.
 *
 * Evaluation is intentionally separate from execution: a disabled family is
 * still materialised and validated by the stage pipeline, but its candidate
 * is not sent to the physical dispatcher. Retired one-family persistence
 * fields must never participate in this policy.
 */

export type StrategyExecutionFamily = "normal" | "trailing" | "block" | "dca" | "axis" | "signal"

export interface StrategyExecutionPolicy {
  normalEnabled: boolean
  trailingEnabled: boolean
  blockEnabled: boolean
  dcaEnabled: boolean
}

export const DEFAULT_STRATEGY_EXECUTION_POLICY: StrategyExecutionPolicy = {
  normalEnabled: true,
  trailingEnabled: true,
  blockEnabled: true,
  dcaEnabled: false,
}

function bool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 1 || value === "1" || value === "true" || value === "on") return true
  if (value === false || value === 0 || value === "0" || value === "false" || value === "off") return false
  return fallback
}

export function normalizeStrategyExecutionPolicy(
  raw: Partial<Record<string, unknown>> | null | undefined,
): StrategyExecutionPolicy {
  const source = raw || {}
  return {
    normalEnabled: bool(
      source.normalEnabled ?? source.normal_enabled ?? source.strategyNormalEnabled,
      DEFAULT_STRATEGY_EXECUTION_POLICY.normalEnabled,
    ),
    trailingEnabled: bool(
      source.trailingEnabled ?? source.variantTrailingEnabled ?? source.strategyBaseTrailingEnabled,
      DEFAULT_STRATEGY_EXECUTION_POLICY.trailingEnabled,
    ),
    blockEnabled: bool(
      source.blockEnabled ?? source.variantBlockEnabled ?? source.blockAdjustment,
      DEFAULT_STRATEGY_EXECUTION_POLICY.blockEnabled,
    ),
    dcaEnabled: bool(
      source.dcaEnabled ?? source.variantDcaEnabled,
      DEFAULT_STRATEGY_EXECUTION_POLICY.dcaEnabled,
    ),
  }
}

function isSignalSet(set: any): boolean {
  return String(set?.indicationType || "").toLowerCase() === "signal" ||
    Boolean(set?.signalRisk?.sourceId || set?.signalRisk?.sourceIds?.length)
}

export function classifyStrategyExecutionFamily(set: any): StrategyExecutionFamily {
  // Signals own their source/lane admission and are deliberately kept out of
  // the main Normal/variant switch.  Check this before axis metadata because a
  // signal row may carry a projected axis for reporting.
  if (isSignalSet(set)) return "signal"
  if (set?.axisWindows?.direction && Number(set?.posCountsVolumeRatio || 0) > 0) return "axis"
  if (set?.variant === "block") return "block"
  if (set?.variant === "dca") return "dca"
  if (set?.variant === "trailing" || set?.trailingProfile) return "trailing"
  return "normal"
}

export function hasAnyStrategyExecutionVariantEnabled(
  policy: StrategyExecutionPolicy,
): boolean {
  return policy.normalEnabled || policy.trailingEnabled || policy.blockEnabled || policy.dcaEnabled
}

export function isStrategyExecutionFamilyEnabled(
  family: StrategyExecutionFamily,
  policy: StrategyExecutionPolicy,
): boolean {
  if (family === "signal" || family === "axis") return true
  if (family === "normal") return policy.normalEnabled
  if (family === "trailing") return policy.trailingEnabled
  if (family === "block") return policy.blockEnabled
  return policy.dcaEnabled
}

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
  /**
   * Execute only Block adjustment rows from the Main family. Calculation and
   * reporting of Normal/Trailing/Pos-Count/DCA rows remains exhaustive.
   * Signal lanes keep their independent admission policy.
   */
  blockOnlyEnabled: boolean
  /**
   * "Block Active" — whether ordinary, unadjusted Row-Live rows may become
   * active real/live orders and positions.
   *
   * Disabled by default: only rows carrying an actual adjustment (a Block
   * count add-on, a DCA step add-on) are dispatched, while the ordinary rows
   * keep being calculated, evaluated and reported exhaustively. Enabling it
   * restores the previous behaviour where the unadjusted Row-Live rows are
   * dispatched too, subject to the per-family flags below.
   *
   * This never affects calculation, statistics or existing exposure — it is
   * an admission gate for NEW unadjusted orders only.
   */
  blockActiveEnabled: boolean
  normalEnabled: boolean
  trailingEnabled: boolean
  blockEnabled: boolean
  dcaEnabled: boolean
}

export const DEFAULT_STRATEGY_EXECUTION_POLICY: StrategyExecutionPolicy = {
  blockOnlyEnabled: true,
  blockActiveEnabled: false,
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
    blockOnlyEnabled: bool(
      source.blockOnlyEnabled ?? source.block_only_enabled ?? source.strategyBlockOnlyEnabled
        ?? source.blockOnly ?? source.variantBlockOnly,
      DEFAULT_STRATEGY_EXECUTION_POLICY.blockOnlyEnabled,
    ),
    blockActiveEnabled: bool(
      source.blockActiveEnabled ?? source.block_active_enabled ?? source.strategyBlockActiveEnabled
        ?? source.blockActive ?? source.dcaActiveEnabled,
      DEFAULT_STRATEGY_EXECUTION_POLICY.blockActiveEnabled,
    ),
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
  if (policy.blockOnlyEnabled) return policy.blockEnabled
  if (!policy.blockActiveEnabled) return policy.blockEnabled || policy.dcaEnabled
  return policy.normalEnabled || policy.trailingEnabled || policy.blockEnabled || policy.dcaEnabled
}

export function isStrategyExecutionFamilyEnabled(
  family: StrategyExecutionFamily,
  policy: StrategyExecutionPolicy,
): boolean {
  if (family === "signal") return true
  if (policy.blockOnlyEnabled) return family === "block" && policy.blockEnabled
  // Block Active gates the ordinary, unadjusted Row-Live families. Adjusted
  // rows (block counts, DCA steps) and the independent Signal lane are
  // unaffected, and every family is still calculated and reported.
  if (family === "axis") return policy.blockActiveEnabled
  if (family === "normal") return policy.blockActiveEnabled && policy.normalEnabled
  if (family === "trailing") return policy.blockActiveEnabled && policy.trailingEnabled
  if (family === "block") return policy.blockEnabled
  return policy.dcaEnabled
}

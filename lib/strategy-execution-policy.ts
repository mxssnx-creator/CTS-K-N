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
   * Independent per-family execution switches. All four are enabled by
   * default. A disabled family is still calculated, evaluated and reported
   * exhaustively — it is simply not handed to the physical dispatcher, so no
   * new active real/live order or position is opened from it.
   *
   * Disabling `normalEnabled` therefore does NOT stop Normal processing: the
   * Normal rows remain the internal base every relative lane is measured
   * against (Axis windows, Block counts, DCA steps all keep resolving against
   * them). They only stop becoming active orders themselves.
   *
   * The independent Signal lane keeps its own admission policy and is not
   * governed by these switches.
   */
  normalEnabled: boolean
  axisEnabled: boolean
  blockEnabled: boolean
  dcaEnabled: boolean
  /** Trailing follows the Normal switch it decorates. */
  trailingEnabled: boolean
}

export const DEFAULT_STRATEGY_EXECUTION_POLICY: StrategyExecutionPolicy = {
  normalEnabled: true,
  axisEnabled: true,
  blockEnabled: true,
  dcaEnabled: true,
  trailingEnabled: true,
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
      source.normalEnabled ?? source.normal_enabled ?? source.strategyNormalEnabled
        ?? source.variantNormalEnabled,
      DEFAULT_STRATEGY_EXECUTION_POLICY.normalEnabled,
    ),
    axisEnabled: bool(
      source.axisEnabled ?? source.axis_enabled ?? source.strategyAxisEnabled
        ?? source.variantAxisEnabled,
      DEFAULT_STRATEGY_EXECUTION_POLICY.axisEnabled,
    ),
    blockEnabled: bool(
      source.blockEnabled ?? source.block_enabled ?? source.strategyBlockEnabled
        ?? source.variantBlockEnabled,
      DEFAULT_STRATEGY_EXECUTION_POLICY.blockEnabled,
    ),
    dcaEnabled: bool(
      source.dcaEnabled ?? source.dca_enabled ?? source.strategyDcaEnabled
        ?? source.variantDcaEnabled,
      DEFAULT_STRATEGY_EXECUTION_POLICY.dcaEnabled,
    ),
    trailingEnabled: bool(
      source.trailingEnabled ?? source.trailing_enabled ?? source.strategyTrailingEnabled
        ?? source.variantTrailingEnabled,
      DEFAULT_STRATEGY_EXECUTION_POLICY.trailingEnabled,
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
  return policy.normalEnabled || policy.axisEnabled || policy.blockEnabled || policy.dcaEnabled
}

export function isStrategyExecutionFamilyEnabled(
  family: StrategyExecutionFamily,
  policy: StrategyExecutionPolicy,
): boolean {
  // The Signal lane is independent of the Normal/Axis/Block/DCA switches.
  if (family === "signal") return true
  if (family === "normal") return policy.normalEnabled
  if (family === "axis") return policy.axisEnabled
  if (family === "block") return policy.blockEnabled
  if (family === "trailing") return policy.normalEnabled && policy.trailingEnabled
  return policy.dcaEnabled
}


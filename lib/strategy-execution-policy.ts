/**
 * Canonical execution policy for the main-trade strategy families.
 *
 * Evaluation is intentionally separate from execution: a disabled family is
 * still materialised and validated by the stage pipeline, but its candidate
 * is not sent to the physical dispatcher. Retired one-family persistence
 * fields must never participate in this policy.
 */

export type StrategyExecutionFamily = "normal" | "trailing" | "block" | "dca" | "axis" | "signal"

export type StrategyProcessingByRange = Record<string, { normal?: boolean; trailing?: boolean }>
export const STRATEGY_PROCESSING_RANGES = ["main", "preset", "signals", "direct"] as const

export function normalizeStrategyProcessingByRange(raw: unknown): StrategyProcessingByRange {
  if (typeof raw === "string") { try { raw = JSON.parse(raw) } catch { return {} } }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: StrategyProcessingByRange = {}
  for (const [range, value] of Object.entries(raw)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(range) || !value || typeof value !== "object" || Array.isArray(value)) continue
    const own: { normal?: boolean; trailing?: boolean } = {}
    for (const key of ["normal", "trailing"] as const) if (typeof (value as any)[key] === "boolean") own[key] = (value as any)[key]
    out[range] = own
  }
  return out
}

export function strategyProcessingRange(row: any): string {
  const explicit = row?.strategyRange ?? row?.strategy_range ?? row?.coordinationRange ?? row?.coordination_range
  if (typeof explicit === "string" && explicit.trim()) return explicit.toLowerCase()
  if (isSignalSet(row) || String(row?.trailingMode ?? row?.trailing_mode) === "signal_dynamic") return "signals"
  const kind = String(row?.indicationType ?? row?.indication_type ?? "").toLowerCase()
  if (kind.includes("direct")) return "direct"
  if (kind.includes("preset") || String(row?.setKey ?? row?.strategy_set_key ?? "").startsWith("preset:")) return "preset"
  return "main"
}

export function strategyExecutionPolicyFor(row: any, policy: StrategyExecutionPolicy): StrategyExecutionPolicy {
  const own = policy.processingByRange?.[strategyProcessingRange(row)]
  return { ...policy, normalEnabled: policy.normalEnabled && own?.normal !== false,
    trailingEnabled: policy.trailingEnabled && own?.trailing !== false }
}

export interface StrategyExecutionPolicy {
  processingByRange?: StrategyProcessingByRange
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
  /**
   * Global main-strategy Trailing switch. When off, plain Trailing Base rows
   * are not dispatched and every other main family (Axis/Block/DCA) runs
   * with fixed TP/SL only: trailing profiles are stripped at dispatch and
   * the realtime trailing machine stops ratcheting/activating on their
   * open positions. Plain Trailing rows additionally require Normal, since
   * they are the trailed form of the Normal base. Signal is independent.
   */
  trailingEnabled: boolean
}

export const DEFAULT_STRATEGY_EXECUTION_POLICY: StrategyExecutionPolicy = {
  normalEnabled: true,
  axisEnabled: true,
  blockEnabled: true,
  // DCA is off unless the operator switches it on (operator default, 2026-09-29).
  dcaEnabled: false,
  trailingEnabled: true,
}

function bool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 1 || value === "1" || value === "true" || value === "on") return true
  if (value === false || value === 0 || value === "0" || value === "false" || value === "off") return false
  return fallback
}

/**
 * Single resolver for the main Trailing switch, shared by the execution
 * policy, the coordinator's `variants.trailing` and its BASE trailing master.
 * Precedence: explicit policy keys, then `variantTrailingEnabled` (the
 * dialog's primary key), then `strategyBaseTrailingEnabled`, then legacy
 * `variant_trailing`. Redis string booleans ("false"/"0"/"off") disable.
 */
export function resolveTrailingSwitchRaw(source: Partial<Record<string, unknown>> | null | undefined): unknown {
  const s = source || {}
  return s.trailingEnabled ?? s.trailing_enabled ?? s.strategyTrailingEnabled
    ?? s.variantTrailingEnabled ?? s.strategyBaseTrailingEnabled ?? s.variant_trailing
}

export function resolveTrailingSwitch(
  source: Partial<Record<string, unknown>> | null | undefined,
  fallback = true,
): boolean {
  return bool(resolveTrailingSwitchRaw(source), fallback)
}

export function normalizeStrategyExecutionPolicy(
  raw: Partial<Record<string, unknown>> | null | undefined,
): StrategyExecutionPolicy {
  const source = raw || {}
  return {
    ...(Object.keys(normalizeStrategyProcessingByRange(source.strategyProcessingByRange ?? source.processingByRange)).length
      ? { processingByRange: normalizeStrategyProcessingByRange(source.strategyProcessingByRange ?? source.processingByRange) } : {}),
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
    trailingEnabled: resolveTrailingSwitch(
      source,
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
  if (set?.axisWindows?.direction && Number(set?.posCountsVolumeRatio || 0) > 0 || set?.combinedPosCounts || /#(?:poscounts|axis):/.test(String(set?.setKey ?? set?.strategySetKey ?? ""))) return "axis"
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


/**
 * Whether automatic trailing may be used for a main-strategy row/position.
 * The Signal lane owns its own trailing policy and is never suppressed here.
 */
export function isMainTrailingAllowed(
  row: { indicationType?: unknown; signalRisk?: any; trailingMode?: unknown } | null | undefined,
  policy: Pick<StrategyExecutionPolicy, "trailingEnabled" | "processingByRange">,
): boolean {
  const full = { ...DEFAULT_STRATEGY_EXECUTION_POLICY, ...policy } as StrategyExecutionPolicy
  return strategyExecutionPolicyFor(row, full).trailingEnabled
}

/**
 * Apply the global Trailing switch to one dispatch candidate. With Trailing
 * off, an Axis/Block/DCA row derived from a trailing Base keeps its family
 * (and therefore still executes) but loses its trailing profile, so it runs
 * with fixed TP/SL only. Rows are returned unchanged when trailing is
 * allowed; the input object is never mutated.
 */
export function applyTrailingExecutionPolicy<T extends Record<string, any>>(
  set: T,
  policy: Pick<StrategyExecutionPolicy, "trailingEnabled" | "processingByRange">,
): T {
  if (!set || !set.trailingProfile || isMainTrailingAllowed(set, policy)) return set
  const { trailingProfile: _dropped, ...rest } = set
  return rest as T
}

/** One admission decision for every exact family and range, including Signal. */
export function isStrategySetExecutionEnabled(row: any, overall: StrategyExecutionPolicy): boolean {
  const policy = strategyExecutionPolicyFor(row, overall)
  const family = classifyStrategyExecutionFamily(row)
  const trailing = Boolean(row?.trailingProfile || row?.variant === "trailing" || String(row?.trailingMode ?? row?.trailing_mode) === "signal_dynamic")
  if (trailing && !policy.trailingEnabled) return false
  if (family === "signal") {
    if (row?.variant === "block") return policy.blockEnabled
    if (row?.variant === "dca") return policy.dcaEnabled
    return policy.normalEnabled
  }
  return isStrategyExecutionFamilyEnabled(family, policy)
}

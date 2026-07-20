/** Canonical Main-stage position-count axis contract shared by API, UI and engine. */
export const STRATEGY_AXIS_SPECS = {
  prev:  { min: 4, max: 12, step: 2, defaultValue: 12 },
  last:  { min: 1, max: 4,  step: 1, defaultValue: 4 },
  cont:  { min: 1, max: 8,  step: 1, defaultValue: 8 },
  pause: { min: 1, max: 8,  step: 1, defaultValue: 8 },
} as const

export type StrategyAxisKey = keyof typeof STRATEGY_AXIS_SPECS
export type StrategyAxisState = { enabled: boolean; maxWindow: number }
export type StrategyAxes = Record<StrategyAxisKey, StrategyAxisState>

function storedBoolean(value: unknown, fallback: boolean): boolean {
  if (value === true || value === "true" || value === 1 || value === "1") return true
  if (value === false || value === "false" || value === 0 || value === "0") return false
  return fallback
}

/**
 * Clamp a maximum-window setting to a value the engine can actually emit.
 * We snap downward because this is a ceiling: normalising a requested maximum
 * must never silently generate a larger window than the operator selected.
 */
export function normalizeStrategyAxisMaxWindow(
  axis: StrategyAxisKey,
  value: unknown,
  fallback = STRATEGY_AXIS_SPECS[axis].defaultValue,
): number {
  const spec = STRATEGY_AXIS_SPECS[axis]
  const parsed = Number(value)
  const safeFallback = Number.isFinite(Number(fallback)) ? Number(fallback) : spec.defaultValue
  const clamped = Math.max(spec.min, Math.min(spec.max, Number.isFinite(parsed) ? Math.floor(parsed) : safeFallback))
  return spec.min + Math.floor((clamped - spec.min) / spec.step) * spec.step
}

/**
 * Rehydrate the nested coordination matrix from either nested settings or the
 * flattened Redis hash fields used by the hot path. This prevents API, UI and
 * engine from disagreeing after migrations or a settings hot reload.
 */
export function normalizeStrategyAxes(
  nested: Partial<Record<StrategyAxisKey, Partial<StrategyAxisState>>> | null | undefined,
  flat: Record<string, unknown> = {},
): StrategyAxes {
  const out = {} as StrategyAxes
  for (const axis of Object.keys(STRATEGY_AXIS_SPECS) as StrategyAxisKey[]) {
    const cap = axis.charAt(0).toUpperCase() + axis.slice(1)
    const state = nested?.[axis]
    const flatFlag = flat[`axis${cap}Enabled`]
    // An explicit flat enable/disable flag (sent at the top level, as a boolean
    // or the legacy string "true"/"false" via `coordinationSettings.axis{Cap}Enabled`)
    // MUST win over the nested `axes.{cap}.enabled` value inherited from
    // previously stored settings. Otherwise an operator toggle that only sends
    // the flat flag would be silently ignored because the stored nested
    // `enabled: true` is "defined" and shadows it.
    const enabled = flatFlag !== undefined
      ? storedBoolean(flatFlag, true)
      : typeof state?.enabled === "boolean"
        ? state.enabled
        : true
    out[axis] = {
      enabled,
      maxWindow: normalizeStrategyAxisMaxWindow(
        axis,
        state?.maxWindow ?? flat[`axis${cap}MaxWindow`],
      ),
    }
  }
  return out
}

export const STRATEGY_INDICATION_TYPES = [
  "direction",
  "move",
  "active",
  "active_advanced",
  "special",
  "optimal",
  "common",
  "signal",
  "trend",
  "auto",
] as const

export type StrategyIndicationType = typeof STRATEGY_INDICATION_TYPES[number]
export type StrategyIndicationVariant = "trailing" | "block"
export type StrategyIndicationVariantPolicy = Record<
  StrategyIndicationType,
  Record<StrategyIndicationVariant, boolean>
>

const titlePart = (value: string): string => value
  .split("_")
  .map((part) => part ? part[0].toUpperCase() + part.slice(1) : "")
  .join("")

export function strategyIndicationVariantSettingKey(
  indicationType: StrategyIndicationType,
  variant: StrategyIndicationVariant,
): string {
  return `strategy${titlePart(indicationType)}${titlePart(variant)}Enabled`
}

export function defaultStrategyIndicationVariantPolicy(): StrategyIndicationVariantPolicy {
  return Object.fromEntries(STRATEGY_INDICATION_TYPES.map((type) => [
    type,
    { trailing: true, block: true },
  ])) as StrategyIndicationVariantPolicy
}

export function defaultStrategyIndicationVariantSettings(): Record<string, boolean> {
  const defaults: Record<string, boolean> = {}
  for (const indicationType of STRATEGY_INDICATION_TYPES) {
    for (const variant of ["trailing", "block"] as const) {
      defaults[strategyIndicationVariantSettingKey(indicationType, variant)] = true
    }
  }
  return defaults
}

function storedBoolean(value: unknown, fallback: boolean): boolean {
  if (value === true || value === "true" || value === 1 || value === "1") return true
  if (value === false || value === "false" || value === 0 || value === "0") return false
  return fallback
}

/** Normalize the flat Settings representation and an optional nested map. */
export function normalizeStrategyIndicationVariantPolicy(
  settings?: Record<string, unknown> | null,
): StrategyIndicationVariantPolicy {
  const source = settings || {}
  const nested = source.strategyIndicationVariants &&
    typeof source.strategyIndicationVariants === "object" &&
    !Array.isArray(source.strategyIndicationVariants)
      ? source.strategyIndicationVariants as Record<string, unknown>
      : {}
  const policy = defaultStrategyIndicationVariantPolicy()
  for (const indicationType of STRATEGY_INDICATION_TYPES) {
    const row = nested[indicationType] && typeof nested[indicationType] === "object"
      ? nested[indicationType] as Record<string, unknown>
      : {}
    for (const variant of ["trailing", "block"] as const) {
      policy[indicationType][variant] = storedBoolean(
        source[strategyIndicationVariantSettingKey(indicationType, variant)] ?? row[variant],
        true,
      )
    }
  }
  return policy
}

/** Unknown/custom indication families inherit the secure operator default: on. */
export function strategyIndicationVariantEnabled(
  policy: StrategyIndicationVariantPolicy,
  indicationType: unknown,
  variant: StrategyIndicationVariant,
): boolean {
  const normalized = String(indicationType || "").trim().toLowerCase() as StrategyIndicationType
  return policy[normalized]?.[variant] !== false
}

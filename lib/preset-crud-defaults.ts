import { COMMON_INDICATOR_TYPES } from "@/lib/common-indicator-config"
import { MAIN_TRADE_BASE_PF_RATIO_DEFAULT } from "@/lib/main-trade-profit-factor"

export const PRESET_DEFAULT_INDICATION_TYPES = [
  "direction",
  "move",
  "active",
  "trend",
  "optimal",
  "auto",
  ...COMMON_INDICATOR_TYPES,
  "signal",
] as const

export const PRESET_INDICATION_GROUPS = [
  {
    label: "Default",
    types: ["direction", "move", "active"],
  },
  {
    label: "Additional",
    types: ["trend", "optimal", "auto"],
  },
  {
    label: "Common",
    types: [...COMMON_INDICATOR_TYPES, "signal"],
  },
] as const

export const PRESET_DEFAULT_INDICATION_RANGES = Object.freeze(
  Array.from({ length: 29 }, (_, index) => index + 2),
)

export const PRESET_DEFAULT_STRATEGY_TYPES = [
  "base",
  "main",
  "real",
  "live",
] as const

export const PRESET_DEFAULT_MIN_PF_RATIO = MAIN_TRADE_BASE_PF_RATIO_DEFAULT

export function presetStringList(
  value: unknown,
  fallback: readonly string[],
): string[] {
  let source = value
  if (typeof source === "string") {
    const serialized = source
    try {
      source = JSON.parse(serialized)
    } catch {
      source = serialized.split(/[\s,|]+/)
    }
  }
  const normalized = Array.isArray(source)
    ? source.map(String).map((item) => item.trim()).filter(Boolean)
    : []
  return normalized.length > 0 ? [...new Set(normalized)] : [...fallback]
}

export function presetNumberList(
  value: unknown,
  fallback: readonly number[],
): number[] {
  let source = value
  if (typeof source === "string") {
    const serialized = source
    try {
      source = JSON.parse(serialized)
    } catch {
      source = serialized.split(/[\s,|]+/)
    }
  }
  const normalized = Array.isArray(source)
    ? source.map(Number).filter(Number.isFinite)
    : []
  return normalized.length > 0 ? [...new Set(normalized)] : [...fallback]
}

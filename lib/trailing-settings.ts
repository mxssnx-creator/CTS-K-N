import { normalizeTrailingGapSelection, type TrailingGapBasis } from "@/lib/trailing-activation"

export const TRAILING_START_RATIOS = [0.3, 0.6, 0.9, 1.2, 1.5] as const
export const TRAILING_STOP_RATIOS = [0.1, 0.2, 0.3, 0.4, 0.5] as const
export const PRICE_TRAILING_STOP_RATIOS = Array.from({ length: 25 }, (_, i) => (i + 2) / 1000)

export function trailingProfileTag(start: number, stop: number, basis?: TrailingGapBasis): string {
  const stopTag = PRICE_TRAILING_STOP_RATIOS.includes(stop)
    ? `p${Math.round(stop * 1000)}`
    : String(Math.round(stop * 100))
  return `t${Math.round(start * 100)}-${stopTag}${basis === "entry" ? "-entry" : ""}`
}

export function trailingVariantKey(start: number, stop: number): string {
  return `${Number(start).toFixed(1)}:${Number(stop).toFixed(PRICE_TRAILING_STOP_RATIOS.includes(stop) ? 3 : 1)}`
}

export const ALL_TRAILING_VARIANTS: string[] = TRAILING_START_RATIOS.flatMap(
  (start) => TRAILING_STOP_RATIOS.map((stop) => trailingVariantKey(start, stop)),
)
export const ALL_PRICE_TRAILING_VARIANTS: string[] = TRAILING_START_RATIOS.flatMap(
  start => PRICE_TRAILING_STOP_RATIOS.map(stop => trailingVariantKey(start, stop)),
)
const VALID_TRAILING_VARIANTS = [...ALL_TRAILING_VARIANTS, ...ALL_PRICE_TRAILING_VARIANTS]

// High-performance default: one representative profile at every supported
// start/stop band. Operators can still enable any or all of the full 5×5
// matrix; fresh multi-symbol engines no longer fan out 25 profiles by default.
export const DEFAULT_TRAILING_VARIANTS: string[] = TRAILING_START_RATIOS.map(
  (start, index) => trailingVariantKey(start, TRAILING_STOP_RATIOS[index]),
)

export function parseStoredBoolean(value: unknown, fallback: boolean): boolean {
  if (value === true || value === "true" || value === 1 || value === "1") return true
  if (value === false || value === "false" || value === 0 || value === "0") return false
  return fallback
}

function parseTokens(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== "string" || !raw.trim()) return []
  const trimmed = raw.trim()
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed)
      return Array.isArray(parsed) ? parsed : []
    } catch { return [] }
  }
  return trimmed.split(/[\s,|]+/).filter(Boolean)
}

export function normalizeTrailingVariants(raw: unknown): string[] {
  const supported = new Set(VALID_TRAILING_VARIANTS)
  const selected = new Set<string>()
  for (const token of parseTokens(raw)) {
    if (typeof token !== "string") continue
    const [startRaw, stopRaw] = token.split(":")
    const start = Number(startRaw)
    const stop = Number(stopRaw)
    if (!Number.isFinite(start) || !Number.isFinite(stop)) continue
    const key = trailingVariantKey(start, stop)
    if (supported.has(key)) selected.add(key)
  }
  return VALID_TRAILING_VARIANTS.filter((key) => selected.has(key))
}

export interface TrailingProfile {
  startRatio: number
  stopRatio: number
  stepRatio: number
  tag: string
  minStep: number
  gapBasis?: TrailingGapBasis
  exactPriceGap?: true
}

export function buildTrailingProfiles(
  raw: unknown,
  minimumStep = DEFAULT_TRAILING_MIN_STEP,
  baseMinimumStep = DEFAULT_BASE_MIN_STEP,
  selection?: unknown,
): TrailingProfile[] {
  const minStep = normalizeTrailingMinStep(minimumStep, baseMinimumStep)
  const basis = normalizeTrailingGapSelection(selection)
  const bases: TrailingGapBasis[] = basis === "both" ? ["peak", "entry"] : [basis]
  return normalizeTrailingVariants(raw).flatMap((token) => {
    const [startRatio, stopRatio] = token.split(":").map(Number)
    const exact = PRICE_TRAILING_STOP_RATIOS.includes(stopRatio)
    return bases.map(gapBasis => ({
      startRatio,
      stopRatio,
      stepRatio: stopRatio / 2,
      tag: trailingProfileTag(startRatio, stopRatio, gapBasis),
      minStep,
      ...(gapBasis === "entry" ? { gapBasis } : {}),
      ...(exact ? { exactPriceGap: true as const } : {}),
    }))
  })
}
import { DEFAULT_BASE_MIN_STEP, DEFAULT_TRAILING_MIN_STEP, normalizeTrailingMinStep } from "@/lib/constants"

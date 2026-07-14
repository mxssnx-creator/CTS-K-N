export const TRAILING_START_RATIOS = [0.3, 0.6, 0.9, 1.2, 1.5] as const
export const TRAILING_STOP_RATIOS = [0.1, 0.2, 0.3, 0.4, 0.5] as const

export function trailingVariantKey(start: number, stop: number): string {
  return `${Number(start).toFixed(1)}:${Number(stop).toFixed(1)}`
}

export const DEFAULT_TRAILING_VARIANTS: string[] = TRAILING_START_RATIOS.flatMap(
  (start) => TRAILING_STOP_RATIOS.map((stop) => trailingVariantKey(start, stop)),
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
  const supported = new Set(DEFAULT_TRAILING_VARIANTS)
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
  return DEFAULT_TRAILING_VARIANTS.filter((key) => selected.has(key))
}

export interface TrailingProfile {
  startRatio: number
  stopRatio: number
  stepRatio: number
  tag: string
  minStep: number
}

export function buildTrailingProfiles(raw: unknown, minimumStep = 6): TrailingProfile[] {
  const minStep = Math.max(2, Math.min(30, Math.round(Number(minimumStep) || 6)))
  return normalizeTrailingVariants(raw).map((token) => {
    const [startRatio, stopRatio] = token.split(":").map(Number)
    return {
      startRatio,
      stopRatio,
      stepRatio: stopRatio / 2,
      tag: `t${Math.round(startRatio * 100)}-${Math.round(stopRatio * 100)}`,
      minStep,
    }
  })
}

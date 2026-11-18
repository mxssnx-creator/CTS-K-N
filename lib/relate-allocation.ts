export interface RelateSettings {
  enabled: boolean
  steps: number
  ratio: number
  lastN: number
  minTrades: number
  minPF: number
  maxMultiplier: number
}

export interface RelateOutcomeWindow {
  count: number
  recentPnlPcts: number[]
  outcomeSource?: "exchange" | "simulation"
}

export function normalizeRelateSettings(input?: unknown): RelateSettings {
  if (typeof input === "string") {
    try { input = JSON.parse(input) } catch { input = undefined }
  }
  const raw = input && typeof input === "object" ? input as Partial<RelateSettings> : {}
  const number = (value: number | undefined, fallback: number, min: number, max: number) =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
  const lastN = Math.floor(number(raw.lastN, 250, 60, 250))
  return {
    enabled: raw.enabled === true,
    steps: Math.floor(number(raw.steps, 12, 2, 15)),
    ratio: Math.round(5 * number(raw.ratio, .2, .2, 6)) / 5,
    lastN,
    minTrades: Math.floor(number(raw.minTrades, 60, 60, lastN)),
    minPF: number(raw.minPF, 1.1, 1.01, 10),
    maxMultiplier: number(raw.maxMultiplier, 2, 1, 8),
  }
}

/** Exact Set evidence only. Venue allocation requires settled exchange results. */
export function relateAllocation(settings: RelateSettings, window: RelateOutcomeWindow | undefined,
  sl: number, tp: number, venue: boolean): number {
  if (!settings.enabled || !window || (venue && window.outcomeSource !== "exchange") ||
      !(Number.isFinite(sl + tp) && sl > 0 && tp > 0 && sl <= .5 * tp) ||
      window.count !== window.recentPnlPcts.length || window.count < settings.minTrades) return 1
  const count = Math.min(window.count, settings.lastN)
  let gain = 0, loss = 0, wins = 0
  for (let i = 0; i < count; i++) {
    const result = window.recentPnlPcts[i]
    if (!Number.isFinite(result)) return 1
    if (result > 0) {
      gain += result
      if (i === wins && wins < settings.steps) wins++
    } else loss -= result
  }
  if (!wins || !Number.isFinite(gain + loss) || (loss > 0 && gain / loss < settings.minPF)) return 1
  return Math.min(settings.maxMultiplier, 1 + wins * settings.ratio)
}

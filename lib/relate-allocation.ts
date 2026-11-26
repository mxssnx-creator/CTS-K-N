import { normalizeRelateFactors, relateLossLevel, weightedRelateAllocation,
  type RelateScope, type RelateSource, type RelateVolumeFactors } from "@/shared/cts-relate/policy"

export interface RelateSettings {
  enabled: boolean
  steps: number
  ratio: number
  lastN: number
  minTrades: number
  minPF: number
  maxMultiplier: number
  activeStep: number
  scope: RelateScope
  volumeFactors: RelateVolumeFactors
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
  const steps = Math.floor(number(raw.steps, 12, 2, 15))
  return {
    enabled: raw.enabled === true,
    steps,
    activeStep: Math.floor(number(raw.activeStep, 0, 0, Math.min(6, steps))),
    ratio: Math.round(5 * number(raw.ratio, .2, .2, 6)) / 5,
    lastN,
    minTrades: Math.floor(number(raw.minTrades, 60, 60, lastN)),
    minPF: number(raw.minPF, 1.1, 1.01, 10),
    maxMultiplier: number(raw.maxMultiplier, 2, 1, 8),
    scope: raw.scope === "overall" ? "overall" : "set",
    volumeFactors: normalizeRelateFactors(raw.volumeFactors),
  }
}

/** Venue raises require the exact Set's own settled exchange results. */
export function relateAllocation(settings: RelateSettings, window: RelateOutcomeWindow | undefined,
  sl: number, tp: number, venue: boolean, levelOf: (source: RelateSource) => number | null = () => null): number {
  if (!settings.enabled || !window || (venue && window.outcomeSource !== "exchange") ||
      !(Number.isFinite(sl + tp) && sl > 0 && tp > 0 && sl <= .5 * tp + 1e-12) ||
      window.count !== window.recentPnlPcts.length || window.count < settings.minTrades) return 1
  return weightedRelateAllocation(relateLossLevel(window.recentPnlPcts, settings), settings,
    settings.scope, settings.volumeFactors, levelOf)
}

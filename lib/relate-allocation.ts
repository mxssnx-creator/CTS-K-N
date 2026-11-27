import { normalizeRelateFactors, RELATE_SOURCES, relateLossLevel, relateMultiplier, weightedRelateAllocation,
  type RelateScope, type RelateSource, type RelateVolumeFactors } from "@/shared/cts-relate/policy"
import { consecutiveLosses, DEFAULT_RELATE_RECOVERY_DRAWDOWN, DEFAULT_RELATE_RECOVERY_TRADES,
  recoveryQualified, type RelateTrial } from "@/shared/cts-relate/recovery"

export interface RelateSettings {
  enabled: boolean
  steps: number
  ratio: number
  lastN: number
  minTrades: number
  minPF: number
  recoveryMinTrades: number
  recoveryMaxDrawdown: number
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
    recoveryMinTrades: Math.floor(number(raw.recoveryMinTrades, DEFAULT_RELATE_RECOVERY_TRADES, 6, lastN)),
    recoveryMaxDrawdown: number(raw.recoveryMaxDrawdown, DEFAULT_RELATE_RECOVERY_DRAWDOWN, 0, 1),
    maxMultiplier: number(raw.maxMultiplier, 2, 1, 8),
    scope: raw.scope === "overall" ? "overall" : "set",
    volumeFactors: normalizeRelateFactors(raw.volumeFactors),
  }
}

export interface RelateCloseWindow {
  recent: (number | undefined)[]
  trials: RelateTrial[]
}

export type RelateTrialStamps = Record<string, { step: number; size: number }>

/** Keep recording each relation's own next step while its additional exposure is withheld. */
export function planRelate(settings: RelateSettings, keys: Record<RelateSource, string> | undefined,
  windows: ReadonlyMap<string, RelateCloseWindow> | undefined, before: number, sl: number, tp: number):
  { multiplier: number; trials?: RelateTrialStamps } {
  if (!settings.enabled || !keys || !(sl > 0 && tp > 0 && Number.isFinite(sl + tp) && sl <= .5 * tp + 1e-12))
    return { multiplier: 1 }
  const sources = settings.scope === "overall" ? RELATE_SOURCES : ["config"] as const
  const weight = sources.reduce((sum, source) => sum + (settings.volumeFactors[source] ?? 1), 0)
  const denominator = settings.scope === "overall" ? Math.max(Number.EPSILON, weight) : Math.max(1, weight)
  const levels = new Map<RelateSource, number>()
  const trials: RelateTrialStamps = {}
  for (const source of sources) {
    const window = windows?.get(keys[source])
    const factor = settings.volumeFactors[source] ?? 1
    if (!window || (source !== "config" && factor === 0)) continue
    const step = consecutiveLosses(window.recent, settings.steps)
    if (!step) continue
    const share = factor > 0 ? factor / denominator : 1
    trials[keys[source]] = { step, size: 1 + (relateMultiplier(step, settings) - 1) * share }
    if (step >= settings.activeStep && relateLossLevel(window.recent, settings) === step &&
        recoveryQualified(window.trials, step, before, 0, settings.recoveryMinTrades, settings.minPF, settings.recoveryMaxDrawdown))
      levels.set(source, step)
  }
  return { trials, multiplier: weightedRelateAllocation(levels.get("config") ?? null, settings,
    settings.scope, settings.volumeFactors, source => levels.get(source) ?? null) }
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

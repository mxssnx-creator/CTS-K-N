import { normalizeBaseMinStep, normalizeTrailingMinStep } from "./constants"

function document(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try { return document(JSON.parse(raw)) } catch { return {} }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
}

function first(...values: unknown[]): unknown {
  return values.find(value => value !== undefined && value !== null &&
    !(typeof value === "string" && value.trim() === ""))
}

/** One settings contract for profile generation, API persistence and the UI. */
export function resolveMinimumStepSettings(raw: unknown): {
  minStep: number
  trailingMinStep: number
} {
  const settings = document(raw)
  const coordination = document(settings.coordination_settings ?? settings.coordinationSettings)
  const minStep = normalizeBaseMinStep(first(
    settings.minStep, settings.min_step, coordination.minStep, coordination.min_step,
  ))
  return {
    minStep,
    trailingMinStep: normalizeTrailingMinStep(first(
      settings.trailingMinStep, settings.trailing_min_step,
      coordination.trailingMinStep, coordination.trailing_min_step,
    ), minStep),
  }
}

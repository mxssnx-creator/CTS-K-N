export const INDICATION_PROFILE_TYPES = ["direction", "move", "active", "optimal", "auto"] as const
export type IndicationProfileType = (typeof INDICATION_PROFILE_TYPES)[number]

export interface IndicationProfileParams {
  enabled: boolean
  range: number
  timeout: number
  interval: number
}

export type IndicationChannelProfile = Record<IndicationProfileType, IndicationProfileParams>

export const DEFAULT_MAIN_INDICATION_PROFILE: IndicationChannelProfile = {
  direction: { enabled: true,  range: 5,  timeout: 30, interval: 1 },
  move:      { enabled: true,  range: 10, timeout: 30, interval: 1 },
  active:    { enabled: true,  range: 15, timeout: 60, interval: 5 },
  optimal:   { enabled: false, range: 20, timeout: 60, interval: 5 },
  auto:      { enabled: false, range: 25, timeout: 90, interval: 15 },
}

export const DEFAULT_PRESET_INDICATION_PROFILE: IndicationChannelProfile = {
  direction: { enabled: true,  range: 8,  timeout: 45, interval: 1 },
  move:      { enabled: true,  range: 12, timeout: 45, interval: 1 },
  active:    { enabled: false, range: 20, timeout: 90, interval: 5 },
  optimal:   { enabled: true,  range: 25, timeout: 90, interval: 5 },
  auto:      { enabled: false, range: 30, timeout: 120, interval: 15 },
}

function bool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === "true" || value === 1 || value === "1") return true
  if (value === false || value === "false" || value === 0 || value === "0") return false
  return fallback
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}

export function normalizeIndicationProfile(
  raw: unknown,
  fallback: IndicationChannelProfile,
): IndicationChannelProfile {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  const out = {} as IndicationChannelProfile
  for (const type of INDICATION_PROFILE_TYPES) {
    const value = source[type]
    const item = value && typeof value === "object" ? value as Record<string, unknown> : {}
    out[type] = {
      enabled: bool(item.enabled, fallback[type].enabled),
      range: bounded(item.range, fallback[type].range, 1, 500),
      timeout: bounded(item.timeout, fallback[type].timeout, 1, 3_600),
      interval: bounded(item.interval, fallback[type].interval, 0.1, 3_600),
    }
  }
  return out
}

export function readStoredIndicationProfile(
  stored: Record<string, unknown> | null | undefined,
  suffix: "" | "_preset",
  fallback: IndicationChannelProfile,
): IndicationChannelProfile {
  const nested = {} as Record<string, unknown>
  for (const type of INDICATION_PROFILE_TYPES) {
    const enabledKey = suffix === "" ? type : `${type}_preset`
    nested[type] = {
      enabled: stored?.[enabledKey],
      range: stored?.[`${type}${suffix}_range`],
      timeout: stored?.[`${type}${suffix}_timeout`],
      interval: stored?.[`${type}${suffix}_interval`],
    }
  }
  return normalizeIndicationProfile(nested, fallback)
}

export function indicationProfilesToFlat(
  main: IndicationChannelProfile,
  preset: IndicationChannelProfile,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [profile, suffix] of [[main, ""], [preset, "_preset"]] as const) {
    for (const type of INDICATION_PROFILE_TYPES) {
      const enabledKey = suffix === "" ? type : `${type}_preset`
      out[enabledKey] = String(profile[type].enabled)
      out[`${type}${suffix}_range`] = String(profile[type].range)
      out[`${type}${suffix}_timeout`] = String(profile[type].timeout)
      out[`${type}${suffix}_interval`] = String(profile[type].interval)
    }
  }
  return out
}

export function normalizeIndicationChannels(raw: unknown): {
  main: IndicationChannelProfile
  preset: IndicationChannelProfile
} {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  return {
    main: normalizeIndicationProfile(source.main, DEFAULT_MAIN_INDICATION_PROFILE),
    preset: normalizeIndicationProfile(source.preset, DEFAULT_PRESET_INDICATION_PROFILE),
  }
}

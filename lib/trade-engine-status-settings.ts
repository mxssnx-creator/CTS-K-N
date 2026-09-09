/**
 * Project the operator's canonical stage thresholds into the read-only
 * engine-status payload. Runtime hashes intentionally retain historical
 * fields across a restart, while `connection_settings:{id}` is the durable
 * source written by the settings coordinator. Returning an empty object for
 * missing/invalid values keeps legacy installations unchanged.
 */
export function canonicalStageSettingsOverlay(
  settings: Record<string, unknown> | null | undefined,
): Record<string, string> {
  if (!settings || typeof settings !== "object") return {}

  const result: Record<string, string> = {}
  const stages = ["base", "main", "real", "live"] as const
  for (const stage of stages) {
    const canonicalKey = `${stage}ProfitFactor`
    const aliases = [
      canonicalKey,
      `${stage}_min_profit_factor`,
      `${stage}MinProfitFactor`,
    ]
    let value: unknown
    for (const key of aliases) {
      if (settings[key] !== undefined && settings[key] !== null && settings[key] !== "") {
        value = settings[key]
        break
      }
    }

    // Some older settings envelopes only retained the nested strategy graph.
    if (value === undefined && typeof settings.strategies === "string") {
      try {
        const parsed = JSON.parse(settings.strategies) as Record<string, any>
        value = parsed?.main?.[stage]?.min_profit_factor
      } catch {
        // Ignore malformed legacy JSON; flat settings remain authoritative.
      }
    } else if (value === undefined && settings.strategies && typeof settings.strategies === "object") {
      const parsed = settings.strategies as Record<string, any>
      value = parsed?.main?.[stage]?.min_profit_factor
    }

    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric <= 0) continue
    const normalized = String(numeric)
    result[canonicalKey] = normalized
    // Keep the aliases coherent for consumers that still read snake_case.
    result[`${stage}_min_profit_factor`] = normalized
  }

  const settingsVersion = settings.settings_version ?? settings.settingsVersion
  if (settingsVersion !== undefined && settingsVersion !== null && String(settingsVersion).trim() !== "") {
    result.settings_version = String(settingsVersion)
  }
  return result
}

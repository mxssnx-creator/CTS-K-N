/**
 * Pure mapping for the System Detail Panel. Every figure is taken from a
 * field that a running-engine writer feeds:
 *   - `progressionState` — GET /api/connections/progression/{id}/logs
 *     (progression counters via ProgressionStateManager, Set totals,
 *     per-type indication counters, historic hash/set, schema version);
 *   - `stats` — GET /api/connections/progression/{id}/stats (open positions).
 * A figure whose source did not answer is null so the panel renders "—"
 * instead of a fabricated 0.
 */

type Json = Record<string, any> | null | undefined

export interface SystemDetailFigures {
  engine: {
    totalCycles: number | null
    lastCycleMs: number | null
    successRate: number | null
  }
  historic: {
    symbols: number | null
    candles: number | null
    intervals: number | null
  }
  realtime: {
    realtimeCycles: number | null
    indicationCycles: number | null
    strategyCycles: number | null
  }
  indications: {
    direction: number | null
    move: number | null
    active: number | null
    optimal: number | null
    auto: number | null
    trend: number | null
    total: number | null
  }
  strategies: {
    base: number | null
    main: number | null
    real: number | null
  }
  positions: {
    pseudo: number | null
    real: number | null
    live: number | null
  }
  database: {
    entries: number | null
    sizeMb: number | null
    schemaVersion: number | null
  }
}

function count(source: Json, field: string): number | null {
  if (!source) return null
  const value = source[field]
  if (value === undefined || value === null || value === "") return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.max(0, numeric) : null
}

/** A duration/rate that only exists once a sample was recorded. */
function sampled(value: number | null): number | null {
  return value !== null && value > 0 ? value : null
}

export function buildSystemDetailFigures(progressionState: Json, stats: Json): SystemDetailFigures {
  const totalCycles = count(progressionState, "cyclesCompleted")
  const indicationTypes = ["direction", "move", "active", "optimal", "auto", "trend"] as const
  const typeField: Record<(typeof indicationTypes)[number], string> = {
    direction: "indicationEvaluatedDirection",
    move: "indicationEvaluatedMove",
    active: "indicationEvaluatedActive",
    optimal: "indicationEvaluatedOptimal",
    auto: "indicationEvaluatedAuto",
    trend: "indicationEvaluatedTrend",
  }
  const indications = Object.fromEntries(
    indicationTypes.map((type) => [type, count(progressionState, typeField[type])]),
  ) as Record<(typeof indicationTypes)[number], number | null>
  const shownIndications = indicationTypes.map((type) => indications[type])
  const openPositions = stats?.openPositions

  return {
    engine: {
      totalCycles,
      lastCycleMs: sampled(count(progressionState, "cycleTimeMs")),
      successRate: totalCycles !== null && totalCycles > 0 ? count(progressionState, "cycleSuccessRate") : null,
    },
    historic: {
      symbols: count(progressionState, "prehistoricSymbolsProcessedCount"),
      candles: count(progressionState, "prehistoricCandlesProcessed"),
      intervals: count(progressionState, "intervalsProcessed"),
    },
    realtime: {
      realtimeCycles: count(progressionState, "realtimeCycleCount"),
      indicationCycles: count(progressionState, "indicationCycleCount"),
      strategyCycles: count(progressionState, "strategyCycleCount"),
    },
    indications: {
      ...indications,
      total: shownIndications.some((value) => value === null)
        ? null
        : shownIndications.reduce<number>((sum, value) => sum + (value ?? 0), 0),
    },
    strategies: {
      base: count(progressionState, "setsBaseCount"),
      main: count(progressionState, "setsMainCount"),
      real: count(progressionState, "setsRealCount"),
    },
    // Pseudo (evaluation), validated Real and Live exchange positions are
    // distinct populations: never summed, and Main owns no position store.
    positions: {
      pseudo: count(openPositions?.pseudo, "open"),
      real: count(openPositions?.real, "open"),
      live: count(openPositions?.live, "open"),
    },
    database: {
      entries: count(progressionState, "redisDbEntries"),
      sizeMb: count(progressionState, "redisDbSizeMb"),
      schemaVersion: count(progressionState, "schemaVersion"),
    },
  }
}

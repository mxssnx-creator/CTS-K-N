import { firstFiniteMetric, firstPositiveMetric } from "@/lib/dashboard-metrics"

type Json = Record<string, any> | null | undefined

/**
 * Figures of the Connection Detailed Log dialog, read from
 * GET /api/connections/progression/{id} (`state`, `metrics`, `monitoring`)
 * and GET /api/connections/progression/{id}/stats. null means the source has
 * no value (yet) and renders as "—".
 */
export interface ConnectionLogMetrics {
  cyclesCompleted: number | null
  cycleSuccessRate: number | null
  lastCycleTimeMs: number | null
  indicationsTotal: number | null
  strategiesEvaluated: number | null
  prehistoricCandles: number | null
  symbolsLoaded: number | null
  historicIntervals: number | null
  processCpuPercent: number | null
  processMemoryPercent: number | null
  // Active-now snapshot (per cycle, not cumulative). These are written every
  // cycle, so a 0 from them is authoritative.
  activeIndicationsTotal: number
  activeStrategiesTotal: number
  activeIndDirection: number
  activeIndMove: number
  activeIndActive: number
  activeIndOptimal: number
  activeStratBase: number
  activeStratMain: number
  activeStratReal: number
}

function presentNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

export function buildConnectionLogMetrics(progression: Json, stats: Json): ConnectionLogMetrics {
  const state = progression?.state
  const metrics = progression?.metrics
  const ac = stats?.activeCounts
  const ap = stats?.activeProgressing
  const activeIndDirection = firstFiniteMetric(ac?.indications?.direction, ap?.indications?.direction?.sets)
  const activeIndMove = firstFiniteMetric(ac?.indications?.move, ap?.indications?.move?.sets)
  const activeIndActive = firstFiniteMetric(ac?.indications?.active, ap?.indications?.active?.sets)
  const activeIndOptimal = firstFiniteMetric(ac?.indications?.optimal, ap?.indications?.optimal?.sets)
  const activeStratReal = firstFiniteMetric(ac?.strategies?.real, ap?.strategies?.real?.sets)
  const cyclesCompleted = presentNumber(state?.cyclesCompleted)

  return {
    cyclesCompleted,
    cycleSuccessRate: cyclesCompleted !== null && cyclesCompleted > 0 ? presentNumber(state?.cycleSuccessRate) : null,
    // Sampled every 50 strategy cycles; 0 means no sample was written yet.
    lastCycleTimeMs: firstPositiveMetric(metrics?.cycleTimeMs) || null,
    // Compatibility fields that a route fills with 0 when unwritten come
    // first, so a zero falls through to the next written source.
    indicationsTotal: firstPositiveMetric(metrics?.indicationsCount, stats?.realtime?.indicationsTotal),
    // Canonical "strategies evaluated" is the Real stage's logical input
    // (strategies_real_evaluated); total_strategies_evaluated is never written.
    strategiesEvaluated: firstPositiveMetric(
      metrics?.strategyEvaluatedReal,
      stats?.breakdown?.strategies?.realEvaluated,
    ),
    prehistoricCandles: firstPositiveMetric(metrics?.prehistoricCandlesProcessed, stats?.historic?.candlesLoaded),
    symbolsLoaded: firstPositiveMetric(metrics?.prehistoricSymbolsProcessed, stats?.historic?.symbolsProcessed),
    historicIntervals: firstPositiveMetric(metrics?.intervalsProcessed, stats?.historic?.framesProcessed),
    processCpuPercent: presentNumber(progression?.monitoring?.cpuPercent),
    processMemoryPercent: presentNumber(progression?.monitoring?.memoryPercent),
    activeIndicationsTotal: firstFiniteMetric(
      ac?.indications?.total,
      ap?.indications?.total?.sets,
      activeIndDirection + activeIndMove + activeIndActive + activeIndOptimal,
    ),
    activeStrategiesTotal: firstFiniteMetric(ac?.strategies?.total, ap?.strategies?.total?.sets, activeStratReal),
    activeIndDirection,
    activeIndMove,
    activeIndActive,
    activeIndOptimal,
    activeStratBase: firstFiniteMetric(ac?.strategies?.base, ap?.strategies?.base?.sets),
    activeStratMain: firstFiniteMetric(ac?.strategies?.main, ap?.strategies?.main?.sets),
    activeStratReal,
  }
}

/** "—" for a figure without a value; locale-grouped integers otherwise. */
export function formatLogMetric(value: number | null | undefined, suffix = ""): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—"
  return `${value.toLocaleString()}${suffix}`
}

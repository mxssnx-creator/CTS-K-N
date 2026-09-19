/**
 * Historic Test — service layer.
 *
 * The single entry point that turns the operator's settings into a completed
 * validation pass: it decides whether a run is due, resolves the symbol
 * universe and the indication set, fans Block out into its independent counts,
 * runs the replay and persists the validated set plus the report.
 *
 * Everything it needs from the outside is injectable, so the whole path is
 * testable without Redis, an exchange or candle storage. Production defaults
 * are supplied, and the pass never reaches a venue — the Historic Test is
 * simulation only.
 */
import { fetchTopSymbols, type SortKey } from "@/lib/top-symbols"
import {
  normalizeHistoricTestSettings,
  type HistoricTestSettings,
  type HistoricTestStrategyFamily,
} from "@/lib/historic-test-settings"
import {
  historicTestReportKey,
  type HistoricTestTrade,
} from "@/lib/historic-test-scoring"
import {
  isHistoricTestRunDue,
  persistHistoricTestRun,
  runHistoricTest,
  type HistoricTestRunResult,
  type HistoricTestSimulationRequest,
  type HistoricTestSimulator,
} from "@/lib/historic-test-runner"
import { createHistoricCandleSimulator } from "@/lib/historic-test-replay"
import { loadHistoricTestCandles } from "@/lib/historic-test-candles"

/** Entry models the pass evaluates when the connection exposes no explicit set. */
export const HISTORIC_TEST_DEFAULT_INDICATIONS = ["momentum", "mean_reversion", "breakout", "relative"] as const

/** Highest Block count validated as its own config, unless the connection says otherwise. */
export const HISTORIC_TEST_DEFAULT_BLOCK_STACK = 3

export type HistoricTestSkipReason = "disabled" | "not_due" | "no_symbols"

export interface HistoricTestServiceResult {
  connectionId: string
  ran: boolean
  skipped: HistoricTestSkipReason | null
  result: HistoricTestRunResult | null
}

export interface HistoricTestServiceDeps {
  redis: any
  /** Raw connection settings; the Historic Test document is normalized from them. */
  loadSettings: (connectionId: string) => Promise<Record<string, unknown>>
  /** Ranked symbol universe for the configured exchange and order. */
  rankSymbols?: (settings: HistoricTestSettings, connectionId: string) => Promise<string[]>
  indications?: (connectionId: string) => Promise<string[]>
  simulate?: HistoricTestSimulator
  now?: number
}

function blockStackOf(raw: Record<string, unknown>): number {
  const value = Number(raw?.blockMaxStack ?? (raw?.coordination_settings as any)?.blockMaxStack)
  return Number.isFinite(value) && value > 0
    ? Math.max(1, Math.min(12, Math.floor(value)))
    : HISTORIC_TEST_DEFAULT_BLOCK_STACK
}

/** Block is validated per count; every other family has a single config. */
export function buildHistoricTestFamilyVariants(
  blockStack: number,
): Partial<Record<HistoricTestStrategyFamily, string[]>> {
  const stack = Math.max(1, Math.floor(Number(blockStack) || 1))
  return { block: Array.from({ length: stack }, (_, index) => `count:${index + 1}`) }
}

async function defaultRankSymbols(settings: HistoricTestSettings, connectionId: string): Promise<string[]> {
  const exchange = settings.symbols.exchange || "bingx"
  const order = settings.symbols.order === "volume_24h" ? "volume" : settings.symbols.order
  try {
    const top = await fetchTopSymbols(exchange, settings.symbolCount, order as SortKey)
    return (top?.symbols || []).map((ticker: any) => String(ticker?.symbol || "")).filter(Boolean)
  } catch {
    // A ranking failure must not run the pass on an arbitrary universe; an
    // empty list is reported as `no_symbols` instead.
    void connectionId
    return []
  }
}

async function readLastRunAt(redis: any, connectionId: string): Promise<number | null> {
  try {
    const raw = await redis.get(historicTestReportKey(connectionId))
    if (!raw) return null
    const parsed = JSON.parse(String(raw))
    const ranAt = Number(parsed?.ranAt)
    return Number.isFinite(ranAt) && ranAt > 0 ? ranAt : null
  } catch {
    return null
  }
}

/**
 * Run the Historic Test for one connection when it is due.
 *
 * Returns without touching anything when the test is disabled, when the recalc
 * interval has not elapsed, or when no symbol universe could be resolved.
 */
export async function maybeRunHistoricTest(
  connectionId: string,
  deps: HistoricTestServiceDeps,
): Promise<HistoricTestServiceResult> {
  const now = Number(deps.now) > 0 ? Number(deps.now) : Date.now()
  const raw = await deps.loadSettings(connectionId).catch(() => ({} as Record<string, unknown>))
  const settings = normalizeHistoricTestSettings(raw)

  if (!settings.enabled) return { connectionId, ran: false, skipped: "disabled", result: null }

  const lastRunAt = await readLastRunAt(deps.redis, connectionId)
  if (!isHistoricTestRunDue(settings, lastRunAt, now)) {
    return { connectionId, ran: false, skipped: "not_due", result: null }
  }

  const rankSymbols = deps.rankSymbols || defaultRankSymbols
  const rankedSymbols = await rankSymbols(settings, connectionId).catch(() => [] as string[])
  if (rankedSymbols.length === 0) {
    return { connectionId, ran: false, skipped: "no_symbols", result: null }
  }

  const indications = deps.indications
    ? await deps.indications(connectionId).catch(() => [...HISTORIC_TEST_DEFAULT_INDICATIONS])
    : [...HISTORIC_TEST_DEFAULT_INDICATIONS]

  // Wire the connection's real configured parameters into the default
  // simulator so the pass measures what would actually run live, instead of
  // generic fallbacks. `profile` is the raw settings object itself --
  // normalizeDcaProfile (inside createHistoricCandleSimulator) already knows
  // how to pull dcaMaxSteps/dcaStepVolumeMultipliers/etc. out of it directly.
  const numOrUndefined = (value: unknown): number | undefined => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const simulate = deps.simulate || createHistoricCandleSimulator({
    loadCandles: (request: HistoricTestSimulationRequest) => loadHistoricTestCandles(request) as Promise<any>,
    profile: raw as any,
    positionCostPercent: numOrUndefined((raw as any)?.positionCost ?? (raw as any)?.exchangePositionCost),
    trailingRetracePct: numOrUndefined((raw as any)?.trailingRetracePct ?? (raw as any)?.trailingMinStep),
    block: {
      volumeRatio: numOrUndefined((raw as any)?.blockVolumeRatio),
      incrementSteps: numOrUndefined((raw as any)?.blockIncrementSteps),
      maxStack: numOrUndefined((raw as any)?.blockMaxStack),
    },
    axis: {
      prev: numOrUndefined((raw as any)?.axisPrevMaxWindow),
      last: numOrUndefined((raw as any)?.axisLastMaxWindow),
      cont: numOrUndefined((raw as any)?.axisContMaxWindow),
      pause: numOrUndefined((raw as any)?.axisPauseMaxWindow),
    },
  })

  const result = await runHistoricTest({
    connectionId,
    settings,
    rankedSymbols,
    indications,
    familyVariants: buildHistoricTestFamilyVariants(blockStackOf(raw)),
    simulate: simulate as (request: HistoricTestSimulationRequest) => Promise<readonly HistoricTestTrade[]>,
    now,
  })

  await persistHistoricTestRun(deps.redis, result)
  return { connectionId, ran: true, skipped: null, result }
}

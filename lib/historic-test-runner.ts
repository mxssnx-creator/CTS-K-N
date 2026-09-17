/**
 * Historic Test — run orchestration.
 *
 * Owns everything around the replay that is decidable without market data:
 * whether a run is due at all, which window it covers, which symbols and
 * families take part, how the per-combination results are bounded, and what is
 * persisted for the engine and the operator report.
 *
 * The replay itself is injected as `simulate`. That keeps this layer pure and
 * testable, and lets the adapter evolve (candle replay, pipeline replay)
 * without touching cadence, selection, validation or persistence.
 *
 * Nothing here ever touches a venue: the Historic Test is simulation only.
 */
import {
  DEFAULT_HISTORIC_TEST_SETTINGS,
  HISTORIC_TEST_STRATEGY_FAMILIES,
  type HistoricTestSettings,
  type HistoricTestStrategyFamily,
} from "@/lib/historic-test-settings"
import {
  historicTestReportKey,
  historicTestValidatedKey,
  scoreHistoricCombination,
  selectValidatedCombinations,
  summarizeHistoricScores,
  combinationKeyOf,
  type HistoricTestCombinationScore,
  type HistoricTestFamilySummary,
  type HistoricTestTrade,
} from "@/lib/historic-test-scoring"

export interface HistoricTestWindow {
  fromMs: number
  toMs: number
  hours: number
}

export interface HistoricTestSimulationRequest {
  connectionId: string
  symbol: string
  indication: string
  family: HistoricTestStrategyFamily
  /** Independent config inside the family (a Block count, for example). */
  variant?: string
  window: HistoricTestWindow
  /** Upper bound on progression steps the adapter may evaluate for this combination. */
  maxProgressCount: number
}

export type HistoricTestSimulator = (
  request: HistoricTestSimulationRequest,
) => Promise<readonly HistoricTestTrade[]>

export interface HistoricTestRunInput {
  connectionId: string
  settings: HistoricTestSettings
  /** Symbols already ranked by the configured order; the run takes the first `symbolCount`. */
  rankedSymbols: readonly string[]
  indications: readonly string[]
  /**
   * Independent configs per family. A family listed here is expanded into one
   * combination per variant, each scored and validated on its own; a family
   * without variants is replayed once. Block counts arrive here.
   */
  familyVariants?: Partial<Record<HistoricTestStrategyFamily, readonly string[]>>
  simulate: HistoricTestSimulator
  now?: number
  lastRunAt?: number | null
}

export interface HistoricTestRunResult {
  connectionId: string
  ranAt: number
  window: HistoricTestWindow
  symbols: string[]
  families: HistoricTestStrategyFamily[]
  scores: HistoricTestCombinationScore[]
  validated: HistoricTestCombinationScore[]
  summaries: HistoricTestFamilySummary[]
  /** Combination keys the engine may act on. */
  validatedKeys: string[]
  errors: number
}

export function resolveHistoricTestWindow(settings: HistoricTestSettings, now = Date.now()): HistoricTestWindow {
  const hours = Number(settings?.periodHours) > 0
    ? Number(settings.periodHours)
    : DEFAULT_HISTORIC_TEST_SETTINGS.periodHours
  return { fromMs: now - hours * 3_600_000, toMs: now, hours }
}

/**
 * A run is due when the test is enabled and the configured recalc interval has
 * elapsed. An unknown last run always counts as due, so a fresh connection
 * validates before the engine leans on the result.
 */
export function isHistoricTestRunDue(
  settings: HistoricTestSettings,
  lastRunAt: number | null | undefined,
  now = Date.now(),
): boolean {
  if (!settings?.enabled) return false
  const last = Number(lastRunAt)
  if (!Number.isFinite(last) || last <= 0) return true
  const intervalMs = Math.max(1, Number(settings.recalcIntervalHours) || DEFAULT_HISTORIC_TEST_SETTINGS.recalcIntervalHours) * 3_600_000
  return now - last >= intervalMs
}

export function enabledHistoricTestFamilies(settings: HistoricTestSettings): HistoricTestStrategyFamily[] {
  return HISTORIC_TEST_STRATEGY_FAMILIES.filter((family) => settings?.strategies?.[family] !== false)
}

/**
 * Run one Historic Test pass.
 *
 * Every combination is simulated, scored and validated on its own; a failing
 * adapter call is counted and skipped rather than aborting the pass, so one
 * bad symbol cannot cost the whole validation.
 */
export async function runHistoricTest(input: HistoricTestRunInput): Promise<HistoricTestRunResult> {
  const now = Number(input.now) > 0 ? Number(input.now) : Date.now()
  const settings = input.settings
  const window = resolveHistoricTestWindow(settings, now)
  const families = enabledHistoricTestFamilies(settings)
  const symbols = Array.from(new Set((input.rankedSymbols || []).map((s) => String(s || "").toUpperCase()).filter(Boolean)))
    .slice(0, Math.max(0, Math.floor(Number(settings.symbolCount) || 0)))
  const indications = Array.from(new Set((input.indications || []).map((i) => String(i || "").toLowerCase()).filter(Boolean)))

  const scores: HistoricTestCombinationScore[] = []
  let errors = 0
  for (const symbol of symbols) {
    for (const indication of indications) {
      for (const family of families) {
        const variants = (input.familyVariants?.[family] || []).map((v) => String(v || "").trim()).filter(Boolean)
        for (const variant of variants.length > 0 ? variants : [""]) {
          const key = { symbol, indication, family, variant: variant || undefined }
          let trades: readonly HistoricTestTrade[] = []
          try {
            trades = await input.simulate({
              connectionId: input.connectionId,
              symbol,
              indication,
              family,
              variant: variant || undefined,
              window,
              maxProgressCount: settings.symbols.maxProgressCount,
            }) || []
          } catch {
            // One unusable config must never invalidate the pass.
            errors++
            continue
          }
          scores.push(scoreHistoricCombination(key, trades, settings.minProfitFactor))
        }
      }
    }
  }

  const validated = selectValidatedCombinations(scores)
  return {
    connectionId: input.connectionId,
    ranAt: now,
    window,
    symbols,
    families,
    scores,
    validated,
    summaries: summarizeHistoricScores(scores, families),
    validatedKeys: validated.map(combinationKeyOf),
    errors,
  }
}

/**
 * Persist the validated set the engine acts on and the operator report.
 *
 * The validated set is written as one document so a reader can never observe
 * a half-updated validation, and it is replaced rather than merged: a
 * combination that stopped being positive must disappear immediately.
 */
export async function persistHistoricTestRun(redis: any, result: HistoricTestRunResult): Promise<void> {
  const validatedKey = historicTestValidatedKey(result.connectionId)
  const reportKey = historicTestReportKey(result.connectionId)
  const validatedDocument = {
    connectionId: result.connectionId,
    ranAt: result.ranAt,
    window: result.window,
    keys: result.validatedKeys,
    combinations: result.validated.map((row) => ({
      symbol: row.symbol,
      indication: row.indication,
      family: row.family,
      variant: row.variant,
      profitFactor: row.profitFactor,
      trades: row.trades,
      averageDrawdownTimeMin: row.averageDrawdownTimeMin,
    })),
  }
  await redis.set(validatedKey, JSON.stringify(validatedDocument))
  await redis.set(reportKey, JSON.stringify({
    connectionId: result.connectionId,
    ranAt: result.ranAt,
    window: result.window,
    symbols: result.symbols,
    families: result.families,
    summaries: result.summaries,
    scores: result.scores,
    errors: result.errors,
  }))
}

/** Read the validated set; an absent or unreadable document means "nothing validated yet". */
export async function readHistoricTestValidatedKeys(redis: any, connectionId: string): Promise<Set<string>> {
  try {
    const raw = await redis.get(historicTestValidatedKey(connectionId))
    if (!raw) return new Set()
    const parsed = JSON.parse(String(raw))
    const keys = Array.isArray(parsed?.keys) ? parsed.keys : []
    return new Set(keys.map((key: unknown) => String(key)))
  } catch {
    return new Set()
  }
}

/**
 * Whether the engine may act on a combination.
 *
 * With the Historic Test disabled every combination is admitted — the overall
 * configuration stands. With it enabled, only validated combinations are, and
 * an empty validated set admits nothing: the pass has not proven anything yet,
 * and acting on unvalidated combinations would defeat the purpose of enabling
 * it.
 */
export function isHistoricTestAdmitted(
  settings: HistoricTestSettings,
  validatedKeys: Set<string>,
  key: { symbol: string; indication: string; family: HistoricTestStrategyFamily; variant?: string },
): boolean {
  if (!settings?.enabled) return true
  return validatedKeys.has(combinationKeyOf(key))
}

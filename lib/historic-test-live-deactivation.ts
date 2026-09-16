/**
 * Historic Test — deactivation from real live results.
 *
 * A historic validation says a config looked good on past data. Live results
 * are the authority on whether it still is, so every validated config is
 * re-judged on its own last N settled LIVE positions and deactivated when that
 * evidence turns negative.
 *
 * Every config is judged separately — a Block count, a family, a symbol — so a
 * failing config never disqualifies a sibling that is still working, and one
 * strong config can never keep a failing one alive.
 *
 * Only settled, system-owned results of the connection under test count.
 * Simulated rows, foreign positions and rows whose accounting is still pending
 * are ignored: deactivating on a simulated or foreign outcome would punish a
 * config for something it never did.
 */
import {
  combinationKeyOf,
  type HistoricTestCombinationKey,
} from "@/lib/historic-test-scoring"
import { signedResultRToMainTradePfRatio } from "@/lib/main-trade-profit-factor"

/** Operator default: how many recent live positions decide a config's fate. */
export const HISTORIC_TEST_LIVE_CHECK_COUNT = { min: 3, max: 100, default: 15 } as const

export interface LiveResultRow {
  /** Combination this result belongs to. */
  key: HistoricTestCombinationKey
  /** Signed result in PositionCost units. */
  signedResultR: number
  closedAt: number
  /** Only settled rows are evidence. */
  settled?: boolean
  /** Only real executions are evidence; simulated rows never deactivate a config. */
  simulated?: boolean
}

export interface ConfigLiveVerdict {
  key: string
  checked: number
  wins: number
  losses: number
  netResultR: number
  profitFactor: number
  /** True when the live evidence no longer supports the config. */
  deactivate: boolean
  reason: "insufficient_evidence" | "negative_live_results" | "below_min_profit_factor" | null
}

export function normalizeLiveCheckCount(value: unknown, fallback = HISTORIC_TEST_LIVE_CHECK_COUNT.default): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(HISTORIC_TEST_LIVE_CHECK_COUNT.min, Math.min(HISTORIC_TEST_LIVE_CHECK_COUNT.max, Math.floor(n)))
}

function isEvidence(row: LiveResultRow): boolean {
  return !!row
    && row.simulated !== true
    && row.settled !== false
    && Number.isFinite(Number(row.signedResultR))
    && Number(row.closedAt) > 0
}

/**
 * Judge one config on its own last N live results.
 *
 * A config with fewer than N settled live results is NOT deactivated: thin
 * evidence is not negative evidence, and deactivating early would discard a
 * config before it ever had a fair run. Once N results exist, the config must
 * be positive overall AND still reach the operator's minimum ProfitFactor.
 */
export function judgeConfigOnLiveResults(
  key: HistoricTestCombinationKey,
  rows: readonly LiveResultRow[],
  minProfitFactor: number,
  checkCount = HISTORIC_TEST_LIVE_CHECK_COUNT.default,
): ConfigLiveVerdict {
  const target = combinationKeyOf(key)
  const bound = normalizeLiveCheckCount(checkCount)
  const recent = (Array.isArray(rows) ? rows : [])
    .filter((row) => isEvidence(row) && combinationKeyOf(row.key) === target)
    .sort((a, b) => Number(b.closedAt) - Number(a.closedAt))
    .slice(0, bound)

  const verdict: ConfigLiveVerdict = {
    key: target,
    checked: recent.length,
    wins: recent.filter((row) => Number(row.signedResultR) > 0).length,
    losses: recent.filter((row) => Number(row.signedResultR) < 0).length,
    netResultR: 0,
    profitFactor: 1,
    deactivate: false,
    reason: null,
  }
  if (recent.length < bound) {
    verdict.reason = "insufficient_evidence"
    return verdict
  }

  const net = recent.reduce((sum, row) => sum + Number(row.signedResultR), 0)
  verdict.netResultR = Number(net.toFixed(12))
  verdict.profitFactor = signedResultRToMainTradePfRatio(net / recent.length)

  if (net <= 0) {
    verdict.deactivate = true
    verdict.reason = "negative_live_results"
    return verdict
  }
  if (verdict.profitFactor < Number(minProfitFactor)) {
    verdict.deactivate = true
    verdict.reason = "below_min_profit_factor"
  }
  return verdict
}

/**
 * Judge every validated config independently and return the keys that survive.
 *
 * Deactivation is reported alongside, so the operator can see which config was
 * dropped and on what evidence rather than watching keys silently disappear.
 */
export function applyLiveDeactivation(
  validatedKeys: readonly HistoricTestCombinationKey[],
  rows: readonly LiveResultRow[],
  minProfitFactor: number,
  checkCount = HISTORIC_TEST_LIVE_CHECK_COUNT.default,
): { active: string[]; deactivated: ConfigLiveVerdict[]; verdicts: ConfigLiveVerdict[] } {
  const verdicts = (validatedKeys || []).map((key) =>
    judgeConfigOnLiveResults(key, rows, minProfitFactor, checkCount))
  return {
    active: verdicts.filter((v) => !v.deactivate).map((v) => v.key),
    deactivated: verdicts.filter((v) => v.deactivate),
    verdicts,
  }
}

export function historicTestDeactivationKey(connectionId: string): string {
  return `historic_test:deactivated:${String(connectionId || "").trim()}`
}

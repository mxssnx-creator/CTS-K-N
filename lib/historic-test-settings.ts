/**
 * Historic Test — operator contract.
 *
 * A per-connection, opt-in validation pass that replays the last N hours of
 * real history through the strategy pipeline as simulated trades, scores every
 * (symbol, indication, strategy family) combination independently, and keeps
 * only the combinations that end positive. When enabled, the engine works
 * from that validated set instead of the overall configuration. Disabled by
 * default: the overall pipeline is unchanged unless an operator turns it on.
 *
 * Every number here is clamped to its operator range and snapped to its step,
 * so a stored or posted value can never widen the contract.
 */
import { DEFAULT_SYMBOL_ORDER } from "@/lib/symbol-selection-defaults"
import { normalizeMainTradePfRatio } from "@/lib/main-trade-profit-factor"

export const HISTORIC_TEST_PERIOD_HOURS = { min: 5, max: 85, step: 5, default: 20 } as const
/**
 * Minimum ProfitFactor a combination must reach to be validated.
 *
 * Lowered from 1.2 to 1.1 by operator decision after the replay was corrected
 * to charge real round-trip cost (0.26%, taker fee both sides plus slippage)
 * instead of borrowing the PositionCost sizing setting (0.10%). That
 * correction moved every measured ProfitFactor down by about 0.16, so a 1.2
 * threshold against honest costs validated nothing: across 29 symbols and the
 * full indication grid the best achievable per symbol was 1.15-1.19.
 *
 * 1.1 is therefore the same strictness as the old 1.2 was against the
 * optimistic cost basis — not a relaxation of the standard.
 */
export const HISTORIC_TEST_MIN_PROFIT_FACTOR_DEFAULT = 1.1
export const HISTORIC_TEST_SYMBOL_COUNT = { min: 1, max: 50, default: 15 } as const
export const HISTORIC_TEST_RECALC_INTERVAL_HOURS = { min: 1, max: 8, default: 2 } as const
export const HISTORIC_TEST_MAX_PROGRESS_COUNT = { min: 10, max: 300, default: 200 } as const
/** Live re-check: how many recent settled live positions decide a config's fate. */
export const HISTORIC_TEST_LIVE_CHECK_POSITIONS = { min: 3, max: 100, default: 15 } as const

export type HistoricTestStrategyFamily = "normal" | "trailing" | "axis" | "block" | "dca"
export const HISTORIC_TEST_STRATEGY_FAMILIES: readonly HistoricTestStrategyFamily[] =
  ["normal", "trailing", "axis", "block", "dca"] as const

export type HistoricTestSymbolOrder = "volatility_1h" | "volume_24h" | "change_24h" | "alphabetical"
export const HISTORIC_TEST_SYMBOL_ORDERS: readonly HistoricTestSymbolOrder[] =
  ["volatility_1h", "volume_24h", "change_24h", "alphabetical"] as const

export interface HistoricTestSettings {
  enabled: boolean
  /** Replay window in hours: 5..85, step 5. */
  periodHours: number
  /** PositionCost-relative PF coordinate a combination must reach (1.00 neutral). */
  minProfitFactor: number
  /** How many symbols the historic pass evaluates: 1..50. */
  symbolCount: number
  /** Re-run cadence in hours: 1..8. */
  recalcIntervalHours: number
  /**
   * Deactivation from real live exchange results: a validated config is
   * re-judged on its own last N settled live positions and dropped when that
   * evidence turns negative. Judged per config, so a failing Block count never
   * disqualifies a sibling.
   */
  liveCheckPositions: number
  /** Which strategy families take part. All on by default. */
  strategies: Record<HistoricTestStrategyFamily, boolean>
  symbols: {
    /** Exchange whose symbol universe is ranked; empty = the connection's own. */
    exchange: string
    /** Ranking used to pick `symbolCount` symbols. */
    order: HistoricTestSymbolOrder
    /** Upper bound on progression steps per symbol: 10..300. */
    maxProgressCount: number
  }
}

export const DEFAULT_HISTORIC_TEST_SETTINGS: HistoricTestSettings = {
  enabled: false,
  periodHours: HISTORIC_TEST_PERIOD_HOURS.default,
  minProfitFactor: HISTORIC_TEST_MIN_PROFIT_FACTOR_DEFAULT,
  symbolCount: HISTORIC_TEST_SYMBOL_COUNT.default,
  recalcIntervalHours: HISTORIC_TEST_RECALC_INTERVAL_HOURS.default,
  liveCheckPositions: HISTORIC_TEST_LIVE_CHECK_POSITIONS.default,
  strategies: { normal: true, trailing: true, axis: true, block: true, dca: true },
  symbols: {
    exchange: "",
    order: DEFAULT_SYMBOL_ORDER,
    maxProgressCount: HISTORIC_TEST_MAX_PROGRESS_COUNT.default,
  },
}

function bool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 1 || value === "1" || value === "true" || value === "on") return true
  if (value === false || value === 0 || value === "0" || value === "false" || value === "off") return false
  return fallback
}

function intInRange(value: unknown, min: number, max: number, fallback: number, step = 1): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const snapped = min + Math.round((n - min) / step) * step
  return Math.max(min, Math.min(max, snapped))
}

function pick(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== "") return source[key]
  }
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" ? parsed : {} } catch { return {} }
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

/**
 * Normalize a stored or posted document. Accepts the nested shape, the
 * `historicTest*` / `historic_test_*` flat mirrors, and JSON-encoded strings
 * (Redis hash values), and always returns a complete, in-range settings object.
 */
export function normalizeHistoricTestSettings(raw: unknown): HistoricTestSettings {
  const source = asRecord(raw)
  const nested = asRecord(pick(source, "historicTest", "historic_test", "historic_test_settings", "historicTestSettings"))
  const s = { ...source, ...nested }
  const strategiesRaw = asRecord(pick(s, "strategies", "historicTestStrategies", "historic_test_strategies"))
  const symbolsRaw = asRecord(pick(s, "symbols", "historicTestSymbols", "historic_test_symbols"))
  const d = DEFAULT_HISTORIC_TEST_SETTINGS

  const orderRaw = String(pick(symbolsRaw, "order", "orderType", "order_type")
    ?? pick(s, "historicTestSymbolOrder", "historic_test_symbol_order") ?? "").trim().toLowerCase()
  const order = (HISTORIC_TEST_SYMBOL_ORDERS as readonly string[]).includes(orderRaw)
    ? (orderRaw as HistoricTestSymbolOrder)
    : d.symbols.order

  const strategies = {} as Record<HistoricTestStrategyFamily, boolean>
  for (const family of HISTORIC_TEST_STRATEGY_FAMILIES) {
    strategies[family] = bool(
      pick(strategiesRaw, family, `${family}Enabled`, `${family}_enabled`)
        ?? pick(s, `historicTest${family[0].toUpperCase()}${family.slice(1)}Enabled`),
      d.strategies[family],
    )
  }

  return {
    enabled: bool(pick(s, "enabled", "historicTestEnabled", "historic_test_enabled"), d.enabled),
    periodHours: intInRange(
      pick(s, "periodHours", "period_hours", "lastPeriodHours", "historicTestPeriodHours", "historic_test_period_hours"),
      HISTORIC_TEST_PERIOD_HOURS.min, HISTORIC_TEST_PERIOD_HOURS.max, d.periodHours, HISTORIC_TEST_PERIOD_HOURS.step,
    ),
    minProfitFactor: normalizeMainTradePfRatio(
      pick(s, "minProfitFactor", "min_profit_factor", "historicTestMinProfitFactor", "historic_test_min_profit_factor")
        ?? d.minProfitFactor,
      d.minProfitFactor,
    ),
    symbolCount: intInRange(
      pick(s, "symbolCount", "symbol_count", "countSymbols", "historicTestSymbolCount", "historic_test_symbol_count"),
      HISTORIC_TEST_SYMBOL_COUNT.min, HISTORIC_TEST_SYMBOL_COUNT.max, d.symbolCount,
    ),
    recalcIntervalHours: intInRange(
      pick(s, "recalcIntervalHours", "recalc_interval_hours", "historicTestRecalcIntervalHours", "historic_test_recalc_interval_hours"),
      HISTORIC_TEST_RECALC_INTERVAL_HOURS.min, HISTORIC_TEST_RECALC_INTERVAL_HOURS.max, d.recalcIntervalHours,
    ),
    liveCheckPositions: intInRange(
      pick(s, "liveCheckPositions", "live_check_positions", "historicTestLiveCheckPositions", "historic_test_live_check_positions"),
      HISTORIC_TEST_LIVE_CHECK_POSITIONS.min, HISTORIC_TEST_LIVE_CHECK_POSITIONS.max, d.liveCheckPositions,
    ),
    strategies,
    symbols: {
      exchange: String(pick(symbolsRaw, "exchange") ?? pick(s, "historicTestExchange", "historic_test_exchange") ?? "").trim().toLowerCase(),
      order,
      maxProgressCount: intInRange(
        pick(symbolsRaw, "maxProgressCount", "max_progress_count")
          ?? pick(s, "historicTestMaxProgressCount", "historic_test_max_progress_count"),
        HISTORIC_TEST_MAX_PROGRESS_COUNT.min, HISTORIC_TEST_MAX_PROGRESS_COUNT.max, d.symbols.maxProgressCount,
      ),
    },
  }
}

/** Flat hash mirrors so the engine can read the contract from `connection_settings` without JSON parsing. */
export function historicTestSettingsToHashFields(settings: HistoricTestSettings): Record<string, string> {
  return {
    historic_test_settings: JSON.stringify(settings),
    historicTestEnabled: String(settings.enabled),
    historicTestPeriodHours: String(settings.periodHours),
    historicTestMinProfitFactor: String(settings.minProfitFactor),
    historicTestSymbolCount: String(settings.symbolCount),
    historicTestRecalcIntervalHours: String(settings.recalcIntervalHours),
    historicTestLiveCheckPositions: String(settings.liveCheckPositions),
    historicTestNormalEnabled: String(settings.strategies.normal),
    historicTestTrailingEnabled: String(settings.strategies.trailing),
    historicTestAxisEnabled: String(settings.strategies.axis),
    historicTestBlockEnabled: String(settings.strategies.block),
    historicTestDcaEnabled: String(settings.strategies.dca),
    historicTestExchange: settings.symbols.exchange,
    historicTestSymbolOrder: settings.symbols.order,
    historicTestMaxProgressCount: String(settings.symbols.maxProgressCount),
  }
}

/**
 * The Historic Test settings live under four nested names and a set of flat
 * fields, and normalizeHistoricTestSettings takes the FIRST nested name that is
 * present, in this order. A save that names another one — or only a flat field —
 * loses against whatever older object is stored: on 2026-09-29 a PUT that turned
 * the test off answered `success:true` and changed nothing, because the stored
 * `historic_test_settings` (third) outranked the submitted `historicTestSettings`
 * (fourth). A switch in the UI that picks the "wrong" name would be dead the same
 * way, which is exactly a setting that "resets itself".
 */
export const HISTORIC_TEST_NESTED_ALIASES = ["historicTest", "historic_test", "historic_test_settings", "historicTestSettings"] as const

const isFlatHistoricKey = (key: string): boolean =>
  (key.startsWith("historicTest") || key.startsWith("historic_test_"))
  && !(HISTORIC_TEST_NESTED_ALIASES as readonly string[]).includes(key)

/**
 * Makes the request the last word. `merged` is the stored settings with the
 * request already merged in; `incoming` is the request alone. Fields the request
 * does not name keep their stored values.
 */
export function applyIncomingHistoricPrecedence(
  merged: Record<string, any>,
  incoming: Record<string, any> | null | undefined,
): void {
  const request = incoming || {}
  const incomingNested = HISTORIC_TEST_NESTED_ALIASES.filter((alias) => request[alias] !== undefined && request[alias] !== null)
  const incomingFlat = Object.keys(request).filter(isFlatHistoricKey)
  if (incomingNested.length === 0 && incomingFlat.length === 0) return

  if (incomingNested.length > 0) {
    // What is stored, without the aliases the request names, is the base the request refines.
    const stored: Record<string, any> = { ...merged }
    for (const alias of incomingNested) delete stored[alias]
    const base = normalizeHistoricTestSettings(stored)
    for (const alias of HISTORIC_TEST_NESTED_ALIASES) {
      if (!incomingNested.includes(alias as any)) delete merged[alias]
    }
    for (const alias of incomingNested) {
      const named = asRecord(merged[alias])
      merged[alias] = {
        ...base,
        ...named,
        strategies: { ...base.strategies, ...asRecord(named.strategies) },
        symbols: { ...base.symbols, ...asRecord(named.symbols) },
      }
    }
    return
  }

  // Flat fields only: a stored nested object would outrank them, so it goes, and
  // the stored effective settings are carried over as flat fields first.
  const stored: Record<string, any> = { ...merged }
  for (const key of incomingFlat) delete stored[key]
  const base = normalizeHistoricTestSettings(stored)
  for (const alias of HISTORIC_TEST_NESTED_ALIASES) delete merged[alias]
  Object.assign(merged, historicTestSettingsToHashFields(base))
  delete merged.historic_test_settings // a nested alias again: only flat fields may remain
  for (const key of incomingFlat) merged[key] = request[key]
}

/** Every field the settings-change detector must treat as a recoordination trigger. */
export const HISTORIC_TEST_SETTINGS_CHANGE_FIELDS = Object.keys(
  historicTestSettingsToHashFields(DEFAULT_HISTORIC_TEST_SETTINGS),
)

#!/usr/bin/env node
/**
 * Direct-Trade Continuous Processor
 *
 * Runs indefinitely with a 280ms tick interval. Self-healing, rate-limit aware,
 * async-optimized. Evaluates independent configs from the configured historic
 * range (48h by default) every 2h, manages
 * multiple positions per symbol/direction/timeframe independently.
 *
 * Usage: node scripts/direct-trade-processor.mjs [--port 3002] [--connection-id ID]
 *
 * Features:
 * - 280ms processing interval
 * - Self-healing on errors (auto-restart loops)
 * - Rate limit respect (BingX: 10 req/s, backs off on 429)
 * - Exact 5m, 15m and 30m timeframes, individually and in every combination
 * - Block Strategy 1-12
 * - Trailing stop support
 * - Recalculates the complete independent set grid every 2h from historic data
 * - Control orders for position management
 * - Simulated + Live mode
 */

import { waitForDirectTradeNextCycle } from "./direct-trade-cycle-scheduler.mjs"
import directTradeHistoryPolicy from "../lib/direct-trade-history-policy.cjs"
import directTradePositionCapacity from "../lib/direct-trade-position-capacity.cjs"
import directTradeLedgerRecovery from "../lib/direct-trade-ledger-recovery.cjs"

const {
  DIRECT_TRADE_HISTORY_MAX_HOURS,
  DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT,
  clampDirectTradeHistoryHours,
  assessDirectTradeHistorySufficiency,
} = directTradeHistoryPolicy

const {
  DIRECT_TRADE_DEFAULT_MAX_TOTAL_POSITIONS,
  assessDirectTradePositionCapacity,
  assessDirectTradeRecentOpenCapacity,
} = directTradePositionCapacity

const {
  backfillLegacyDirectTradeLegControlIds,
  normalizeDirectTradeControlId,
} = directTradeLedgerRecovery

const PORT = process.env.PORT ?? (
  process.argv.includes("--port")
    ? process.argv[process.argv.indexOf("--port") + 1] || "3002"
    : "3002"
)
const BASE = `http://localhost:${PORT}`
const PROCESSOR_TOKEN = process.env.DIRECT_TRADE_PROCESSOR_TOKEN || ""
const connectionArgIndex = process.argv.indexOf("--connection-id")
const PROCESS_CONNECTION_ID = String(
  process.env.DIRECT_TRADE_CONNECTION_ID
    || (connectionArgIndex >= 0 ? process.argv[connectionArgIndex + 1] : "")
    || "",
).trim()
// Live Direct-Trade must prove an exact historic warmup before the realtime
// pulse/order loop is allowed to run. This is intentionally independent from
// the operator's paper/backtest range.
const DIRECT_TRADE_LIVE_HISTORY_HOURS = Math.max(
  1,
  clampDirectTradeHistoryHours(
    process.env.DIRECT_TRADE_LIVE_HISTORY_HOURS,
    48,
  ),
)
const DIRECT_TRADE_ADAPTIVE_HISTORY_MAX_HOURS = Math.max(
  DIRECT_TRADE_LIVE_HISTORY_HOURS,
  clampDirectTradeHistoryHours(
    process.env.DIRECT_TRADE_ADAPTIVE_HISTORY_MAX_HOURS,
    DIRECT_TRADE_HISTORY_MAX_HOURS,
  ),
)
const MAX_DIRECT_DCA_POSITION_VOLUME_RATIO = 5
const MIN_DIRECT_DCA_POSITION_VOLUME_RATIO = 1.4
const DIRECT_TRADE_VOLUME_FACTOR_MIN = 0.1
const DIRECT_TRADE_VOLUME_FACTOR_MAX = 10
const DIRECT_TRADE_VOLUME_FACTOR_DEFAULT = 0.1
const DIRECT_TRADE_BASE_NOTIONAL_PER_FACTOR_USDT = 5
const DIRECT_TRADE_EFFECTIVE_VOLUME_RATIO = 0.2
const DIRECT_TRADE_TRAILING_MIN_TAKE_PROFIT_RATIO_DEFAULT = 5
const DIRECT_TRADE_TAKE_PROFIT_RATIO_MIN = 2
const DIRECT_TRADE_TAKE_PROFIT_RATIO_MAX = 22
const DIRECT_TRADE_PROCESSOR_HEARTBEAT_INTERVAL_MS = 1_500
const DIRECT_TRADE_CONTROL_REQUEST_TIMEOUT_MS = 10_000
const DIRECT_TRADE_MAX_LIVE_CLOSE_ACTIONS_PER_CYCLE = 1
const DIRECT_TRADE_ENTRY_TACTICS = ["momentum", "mean_reversion", "breakout", "relative"]

function normalizeEnabledIndicationTypes(value, fallback = DIRECT_TRADE_ENTRY_TACTICS) {
  const source = Array.isArray(value) ? value : fallback
  return [...new Set(source.filter((entry) => DIRECT_TRADE_ENTRY_TACTICS.includes(entry)))]
}

function normalizeDirectTradeVolumeFactor(value, fallback = DIRECT_TRADE_VOLUME_FACTOR_DEFAULT) {
  const parsed = Number(value)
  const requested = Number.isFinite(parsed) ? parsed : fallback
  const clamped = Math.max(DIRECT_TRADE_VOLUME_FACTOR_MIN, Math.min(DIRECT_TRADE_VOLUME_FACTOR_MAX, requested))
  return Number((Math.round(clamped * 10) / 10).toFixed(1))
}

function normalizeDirectTradeTrailingMinTakeProfitRatio(value, fallback = DIRECT_TRADE_TRAILING_MIN_TAKE_PROFIT_RATIO_DEFAULT) {
  const parsed = Number(value)
  const requested = Math.round(Number.isFinite(parsed) ? parsed : fallback)
  return Math.max(DIRECT_TRADE_TAKE_PROFIT_RATIO_MIN, Math.min(DIRECT_TRADE_TAKE_PROFIT_RATIO_MAX, requested))
}

const DEFAULT_DIRECT_DCA_PROFILE = Object.freeze({
  maxSteps: 4,
  stepVolumeMultipliers: Object.freeze([1, 1, 1, 1]),
  stepDistancesPct: Object.freeze([0.3, 0.6, 1, 1.6]),
  takeProfitMode: "average",
  breakevenProfitPct: 0.2,
  cooldownSeconds: 30,
  maxPositionVolumeRatio: MAX_DIRECT_DCA_POSITION_VOLUME_RATIO,
})

const DIRECT_TRADE_MAX_STOP_LOSS_TO_TAKE_PROFIT_RATIO = 1.5
const DIRECT_TRADE_MIN_PROTECTION_PERCENT = 0.01

function normalizeDirectTradeProtection(takeProfitValue, stopLossValue, fallbackTakeProfit = 0.1) {
  const requestedTakeProfit = Number(takeProfitValue)
  const fallback = Number(fallbackTakeProfit)
  const takeprofit = Math.max(
    DIRECT_TRADE_MIN_PROTECTION_PERCENT,
    Number.isFinite(requestedTakeProfit) && requestedTakeProfit > 0
      ? requestedTakeProfit
      : Number.isFinite(fallback) && fallback > 0
        ? fallback
        : 0.1,
  )
  const requestedStopLoss = Number(stopLossValue)
  const stoploss = Math.max(
    DIRECT_TRADE_MIN_PROTECTION_PERCENT,
    Math.min(
      takeprofit * DIRECT_TRADE_MAX_STOP_LOSS_TO_TAKE_PROFIT_RATIO,
      Number.isFinite(requestedStopLoss) && requestedStopLoss > 0 ? requestedStopLoss : takeprofit,
    ),
  )
  return { takeprofit, stoploss }
}

function normalizeDirectTradeConfig(config) {
  if (!config || typeof config !== "object") return config
  const protection = normalizeDirectTradeProtection(
    config.takeprofit,
    config.stoploss,
    Number(config.positionCostPercent) || Number(state.positionCostPercent) || 0.1,
  )
  return {
    ...config,
    takeprofit: protection.takeprofit,
    stoploss: protection.stoploss,
  }
}

function normalizeLoadedDirectTradePosition(position) {
  if (!position || typeof position !== "object") return position
  const recoveredPosition = backfillLegacyDirectTradeLegControlIds(position)
  if (recoveredPosition !== position) {
    stateDirty = true
    log("info", `Recovered legacy Direct-Trade accounting controls for ${position.symbol || "unknown"}`)
  }
  if (recoveredPosition.status === "closed") return recoveredPosition
  const protection = normalizeDirectTradeProtection(
    recoveredPosition.takeprofit,
    recoveredPosition.stoploss,
    Number(recoveredPosition.positionCostPercent) || Number(state.positionCostPercent) || 0.1,
  )
  const changed = Number(recoveredPosition.takeprofit) !== protection.takeprofit ||
    Number(recoveredPosition.stoploss) !== protection.stoploss
  if (!changed) return recoveredPosition
  const next = { ...recoveredPosition, takeprofit: protection.takeprofit, stoploss: protection.stoploss }
  const entry = Number(next.entryPrice)
  if (entry > 0 && next.trailingArmed !== true) {
    next.currentSlPrice = next.direction === "short"
      ? entry * (1 + protection.stoploss / 100)
      : entry * (1 - protection.stoploss / 100)
  }
  log("warn", `Normalized Direct-Trade protection for ${next.symbol || "unknown"}`, {
    takeprofit: protection.takeprofit,
    stoploss: protection.stoploss,
    ratio: protection.stoploss / protection.takeprofit,
  })
  return next
}

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

class RateLimiter {
  constructor(maxPerSecond = 8) {
    this.maxPerSecond = maxPerSecond
    this.tokens = maxPerSecond
    this.lastRefill = Date.now()
    this.backoffUntil = 0
  }

  async acquire() {
    // Backoff check
    const now = Date.now()
    if (now < this.backoffUntil) {
      await sleep(this.backoffUntil - now)
    }

    // Refill tokens
    const elapsed = (Date.now() - this.lastRefill) / 1000
    this.tokens = Math.min(this.maxPerSecond, this.tokens + elapsed * this.maxPerSecond)
    this.lastRefill = Date.now()

    if (this.tokens < 1) {
      const waitMs = ((1 - this.tokens) / this.maxPerSecond) * 1000
      await sleep(waitMs)
      this.tokens = 1
      this.lastRefill = Date.now()
    }

    this.tokens -= 1
  }

  backoff(durationMs = 2000) {
    this.backoffUntil = Date.now() + durationMs
    console.warn(`[RateLimit] Backing off for ${durationMs}ms`)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function finiteDcaNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback
}

function directDcaArray(value, fallback, minimum, maximum) {
  let source = value
  if (typeof source === "string") {
    try { source = JSON.parse(source) } catch { source = source.split(/[\s,|]+/) }
  }
  const requested = Array.isArray(source) ? source : []
  return Array.from({ length: 4 }, (_, index) => finiteDcaNumber(
    requested[index],
    fallback[index],
    minimum,
    maximum,
  ))
}

function normalizeDirectDcaProfile(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  const maxPositionVolumeRatio = finiteDcaNumber(
    source.maxPositionVolumeRatio ?? source.dcaMaxPositionVolumeRatio,
    DEFAULT_DIRECT_DCA_PROFILE.maxPositionVolumeRatio,
    MIN_DIRECT_DCA_POSITION_VOLUME_RATIO,
    MAX_DIRECT_DCA_POSITION_VOLUME_RATIO,
  )
  const requestedVolumes = directDcaArray(
    source.stepVolumeMultipliers ?? source.dcaStepVolumeMultipliers,
    DEFAULT_DIRECT_DCA_PROFILE.stepVolumeMultipliers,
    0.1,
    2.5,
  )
  let remaining = Math.max(0, maxPositionVolumeRatio - 1)
  const stepVolumeMultipliers = requestedVolumes.map((volume) => {
    const bounded = Math.max(0, Math.min(volume, remaining))
    remaining = Math.max(0, remaining - bounded)
    return Number(bounded.toFixed(6))
  })
  const rawDistances = directDcaArray(
    source.stepDistancesPct ?? source.dcaStepDistancesPct,
    DEFAULT_DIRECT_DCA_PROFILE.stepDistancesPct,
    0.1,
    20,
  )
  const stepDistancesPct = rawDistances.reduce((values, distance) => {
    values.push(Math.max(distance, values.at(-1) ?? distance))
    return values
  }, [])
  const requestedMaxSteps = Math.floor(finiteDcaNumber(
    source.maxSteps ?? source.dcaMaxSteps,
    DEFAULT_DIRECT_DCA_PROFILE.maxSteps,
    1,
    4,
  ))
  const lastExecutableStep = stepVolumeMultipliers.reduce(
    (last, volume, index) => volume > 0 ? index + 1 : last,
    0,
  )
  const takeProfitMode = ["average", "first_entry", "breakeven_plus"].includes(source.takeProfitMode)
    ? source.takeProfitMode
    : DEFAULT_DIRECT_DCA_PROFILE.takeProfitMode
  return {
    maxSteps: Math.max(1, Math.min(requestedMaxSteps, lastExecutableStep || 1)),
    stepVolumeMultipliers,
    stepDistancesPct,
    takeProfitMode,
    breakevenProfitPct: finiteDcaNumber(
      source.breakevenProfitPct,
      DEFAULT_DIRECT_DCA_PROFILE.breakevenProfitPct,
      0.05,
      5,
    ),
    cooldownSeconds: Math.round(finiteDcaNumber(
      source.cooldownSeconds,
      DEFAULT_DIRECT_DCA_PROFILE.cooldownSeconds,
      0,
      3_600,
    )),
    maxPositionVolumeRatio,
  }
}

function directDcaAdverseMovePct(direction, referencePrice, currentPrice) {
  if (!(referencePrice > 0) || !(currentPrice > 0)) return 0
  return Math.max(0, (direction === "short"
    ? (currentPrice - referencePrice) / referencePrice
    : (referencePrice - currentPrice) / referencePrice) * 100)
}

function directDcaTakeProfitPrice(position) {
  const profile = normalizeDirectDcaProfile(position.dcaProfile)
  const average = Number(position.averageEntryPrice || position.entryPrice)
  const initial = Number(position.initialEntryPrice || position.entryPrice)
  if (!(average > 0)) return 0
  const reference = profile.takeProfitMode === "first_entry" && initial > 0 ? initial : average
  const targetPct = profile.takeProfitMode === "breakeven_plus"
    ? profile.breakevenProfitPct
    : Math.max(0, Number(position.takeprofit) || 0)
  if (!(targetPct > 0)) return 0
  return position.direction === "short"
    ? reference * (1 - targetPct / 100)
    : reference * (1 + targetPct / 100)
}

function log(level, msg, data) {
  const ts = new Date().toISOString()
  const prefix = `[${ts}] [Direct-Trade] [${level.toUpperCase()}]`
  if (data) console.log(`${prefix} ${msg}`, typeof data === "object" ? JSON.stringify(data).slice(0, 200) : data)
  else console.log(`${prefix} ${msg}`)
}

async function apiCall(path, method = "GET", body = null, timeoutMs = 30_000) {
  const url = new URL(path, BASE)
  if (PROCESS_CONNECTION_ID && url.pathname.startsWith("/api/trade-engine/direct-trade")) {
    url.searchParams.set("connectionId", PROCESS_CONNECTION_ID)
  }
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(PROCESSOR_TOKEN ? { "x-direct-trade-processor-token": PROCESSOR_TOKEN } : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  }
  if (body) {
    const scopedBody = PROCESS_CONNECTION_ID && typeof body === "object" && !Array.isArray(body)
      ? { ...body, connectionId: PROCESS_CONNECTION_ID }
      : body
    opts.body = JSON.stringify(scopedBody)
  }
  const res = await fetch(url, opts)
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`API ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}

// ─── State Management ─────────────────────────────────────────────────────────

let state = {
  enabled: false,
  liveMode: false,
  connectionId: null,
  symbolCount: 8,
  symbolOrder: "volatility_1h",
  minVolFactor: DIRECT_TRADE_VOLUME_FACTOR_DEFAULT,
  positionCostPercent: 0.1,
  maxSlRatio: 0.75,
  slRatioStep: 0.25,
  inverseMaxSlRatio: 1.25,
  timeframes: ["5m", "15m", "30m"],
  strategyTypes: ["standard", "trailing_fixed", "trailing_auto", "combination", "inverse", "high_protection", "dca"],
  historyHours: 48,
  entryTactics: ["relative"],
  enabledIndicationTypes: ["relative"],
  exitTactics: ["bracket", "momentum_reversal", "relative", "time"],
  entryTiming: "current",
  activityVolumeRatio: 1,
  maxHoldMinutes: 120,
  takeProfitRatioRange: [5, 10],
  takeProfitRatioStep: 5,
  trailingMinTakeProfitRatio: DIRECT_TRADE_TRAILING_MIN_TAKE_PROFIT_RATIO_DEFAULT,
  blockRange: [1, 12],
  blockVolumeRatio: 1,
  blockProfitFactorRatio: 0.8,
  maxTotalPositions: DIRECT_TRADE_DEFAULT_MAX_TOTAL_POSITIONS,
  maxPositionsPerSymbol: 12,
  maxPositionsPerDirection: 6,
  processingIntervalMs: 280,
  recalcIntervalMs: 2 * 60 * 60 * 1000,
  // Evaluation settings
  keepEnabledPosCount: 12,      // Last N pos per config to check if keep enabled
  deactivatePosCount: 16,       // Negative last-N average permanently disables this exact set lineage
  minProfitFactor: DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT,
  minRecentProfitFactor: 25,    // Strict historic last-12-position PF gate for future entries
  recentEvaluationPositions: 12,
  maxDrawdownTimeMin: 10,       // Max DDT to keep config enabled
  prevPosWindow: 25,            // Rolling window for overall PF/DDT eval
  prevPosMinCount: 5,           // Min positions before eval activates
  evalPosCount: 12,             // Coordination eval count
  trailingEnabled: true,
  dcaProfile: normalizeDirectDcaProfile(DEFAULT_DIRECT_DCA_PROFILE),
}

let configs = []
let executionConfigs = []
let activeExecutionConfigs = []
let executionConfigsBySignal = new Map()
let activeSignalKeys = new Set()
let lastSignalPulseAt = 0
let calculationVersion = null
let calculationHistoryHours = null
let adaptiveHistoryHours = null
let lastHistoryPolicy = null
let positions = []
// Per-config performance tracking. The full candidate identity prevents TP,
// SL, trailing and Block variants from sharing a false PF/DDT history.
let configPerformance = new Map()
let configStatus = new Map()
let stats = {
  totalOrders: 0,
  totalFilled: 0,
  totalPnl: 0,
  totalPnlUsdt: 0,
  totalGrossPnlUsdt: 0,
  profitFactorUsdt: null,
  profitFactorUsdtInfinite: false,
  winCount: 0,
  lossCount: 0,
  profitFactor: null,
  profitFactorInfinite: false,
  maxDrawdownTimeMin: 0,
  currentDrawdownTimeMin: 0,
  lastPositionAt: null,
  pnlHistory: [],
  blockStatsByCount: {},
}

let lastRecalcAt = 0
let tickCount = 0
let errorsLast5min = 0
let errorTimestamps = []
const rateLimiter = new RateLimiter(8)
const processorInstanceId = `dtp_${process.pid}_${Math.random().toString(36).slice(2, 12)}${PROCESS_CONNECTION_ID ? `_${PROCESS_CONNECTION_ID.slice(0, 24)}` : ""}`
let processorLeaseHeld = false
let lastProcessorSyncAt = 0
let lastPersistAt = 0
let lastStateRefreshAt = 0
let lastStandbyWarningAt = 0
let lastHeartbeatWarningAt = 0
let lifecycleCycleCount = 0
let lastProgressAt = 0
let stateDirty = false
let tickInFlight = false
let connectionExchange = "bingx"

const BINGX_PUBLIC_HOSTS = new Set([
  "open-api.bingx.com",
  "open-api.bingx.pro",
  "open-api-vst.bingx.com",
  "open-api-vst.bingx.pro",
])

function syntheticDirectTradePrice(symbol) {
  const seed = [...String(symbol || "")].reduce((total, character) => total + character.charCodeAt(0), 0)
  const minute = Math.floor(Date.now() / 60_000)
  const price = 100
    + Math.sin((minute + seed * 3) / (13 + seed % 7)) * (1.2 + (seed % 5) * 0.2)
    + Math.cos((minute + seed) / (37 + seed % 11)) * 0.75
  return Number(price.toFixed(8))
}

/**
 * Read the current public price without allowing paper runs to touch an
 * exchange.  The processor is a plain Node worker, so it cannot import the
 * Next-only BingX public helper directly; keep the same host allow-list here.
 * There is deliberately no automatic fallback to an unverified host.
 */
async function readDirectTradeTicker(symbol) {
  if (process.env.DIRECT_TRADE_SYNTHETIC_MARKET_DATA === "1") {
    return syntheticDirectTradePrice(symbol)
  }

  if (connectionExchange === "bybit") {
    const url = new URL("https://api.bybit.com/v5/market/tickers")
    url.searchParams.set("category", "linear")
    url.searchParams.set("symbol", String(symbol).replace(/-/g, ""))
    await rateLimiter.acquire()
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3_000),
    })
    if (response.status === 429) rateLimiter.backoff(2_000)
    if (!response.ok) return 0
    const payload = await response.json()
    if (Number(payload?.retCode) !== 0) return 0
    return Number(payload?.result?.list?.[0]?.lastPrice || 0) || 0
  }
  if (connectionExchange !== "bingx") {
    throw new Error(`Direct-Trade ticker is not supported for exchange ${connectionExchange || "unknown"}`)
  }

  const origin = String(process.env.BINGX_PUBLIC_ORIGIN || "https://open-api.bingx.com")
  const url = new URL(
    `/openApi/swap/v2/quote/ticker?symbol=${encodeURIComponent(String(symbol).replace(/USDT$/, "-USDT"))}`,
    origin,
  )
  if (url.protocol !== "https:" || !BINGX_PUBLIC_HOSTS.has(url.hostname)) {
    throw new Error(`Refusing unverified BingX public host: ${url.origin}`)
  }

  await rateLimiter.acquire()
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000) })
  if (response.status === 429) rateLimiter.backoff(2_000)
  if (!response.ok) return 0
  const payload = await response.json()
  return Number(payload?.data?.lastPrice || payload?.data?.c || 0) || 0
}

function configKey(config) {
  if (typeof config?.setKey === "string" && config.setKey) return config.setKey
  const numeric = (value) => Number(value || 0).toFixed(4)
  const dcaProfile = (config.strategyType || "standard") === "dca"
    ? normalizeDirectDcaProfile(config.dcaProfile || state.dcaProfile)
    : null
  return [
    config.symbol,
    config.direction,
    `signal:${config.signalDirection || config.direction}`,
    `type:${config.strategyType || "standard"}`,
    config.timeframe,
    `tp:${numeric(config.takeprofit)}`,
    `tpCost:${numeric(config.takeProfitPositionCostRatio)}`,
    `sl:${numeric(config.stoploss)}`,
    `tr:${config.trailing ? 1 : 0}`,
    `tm:${config.trailingMode || (config.trailing ? "fixed" : "none")}`,
    `ts:${numeric(config.trailStart)}`,
    `td:${numeric(config.trailStop)}`,
    `ta:${config.autoTrailSensitivity == null ? "none" : numeric(config.autoTrailSensitivity)}`,
    `b:${Math.max(0, Math.floor(Number(config.blockCount) || 0))}`,
    `br:${numeric(config.blockVolumeRatio ?? config.volumeRatio)}`,
    `bpf:${numeric(config.blockProfitFactorRatio ?? state.blockProfitFactorRatio)}`,
    dcaProfile
      ? `dca:${dcaProfile.maxSteps}:${dcaProfile.stepVolumeMultipliers.map(numeric).join(",")}:${dcaProfile.stepDistancesPct.map(numeric).join(",")}:${dcaProfile.takeProfitMode}:${numeric(dcaProfile.breakevenProfitPct)}:${dcaProfile.cooldownSeconds}:${numeric(dcaProfile.maxPositionVolumeRatio)}`
      : "dca:none",
  ].join("|")
}

function resolveBlockSizing(config, baseQuantity) {
  if ((config?.strategyType || "standard") === "dca") {
    return {
      blockCount: 0,
      blockVolumeRatio: 0,
      blockBaseQuantity: baseQuantity,
      blockAddedQuantity: 0,
      targetBlockQuantity: baseQuantity,
    }
  }
  const requestedCount = Math.floor(Number(config?.blockCount) || 0)
  const configuredMinimum = Math.max(0, Math.floor(Number(state.blockRange?.[0]) || 0))
  const configuredMaximum = Math.max(configuredMinimum, Math.floor(Number(state.blockRange?.[1]) || 0))
  const blockCount = Math.max(configuredMinimum, Math.min(configuredMaximum, requestedCount))
  const requestedRatio = Number(config?.blockVolumeRatio ?? config?.volumeRatio ?? state.blockVolumeRatio)
  const blockVolumeRatio = Math.max(0.1, Math.min(10, Number.isFinite(requestedRatio) ? requestedRatio : 1))
  const blockAddedQuantity = blockCount > 0 ? baseQuantity * blockCount * blockVolumeRatio : 0
  return {
    blockCount,
    blockVolumeRatio,
    blockBaseQuantity: baseQuantity,
    blockAddedQuantity,
    targetBlockQuantity: baseQuantity + blockAddedQuantity,
  }
}

function configuredCalculationHistoryHours(input = state) {
  return input?.liveMode
    ? DIRECT_TRADE_LIVE_HISTORY_HOURS
    : clampDirectTradeHistoryHours(input?.historyHours, 48)
}

function requiredCalculationHistoryHours(input = state) {
  const configured = configuredCalculationHistoryHours(input)
  return Math.max(
    configured,
    Math.min(
      DIRECT_TRADE_ADAPTIVE_HISTORY_MAX_HOURS,
      clampDirectTradeHistoryHours(adaptiveHistoryHours, configured),
    ),
  )
}

function resetAdaptiveHistory(reason) {
  adaptiveHistoryHours = null
  lastHistoryPolicy = null
  if (reason) log("debug", `Historic sufficiency policy reset: ${reason}`)
}

function assessCalculationHistory(summary, currentHours) {
  return assessDirectTradeHistorySufficiency({
    summary,
    configuredStrategyTypes: state.strategyTypes,
    requestedHistoryHours: configuredCalculationHistoryHours(state),
    currentHistoryHours: currentHours,
    maximumHistoryHours: DIRECT_TRADE_ADAPTIVE_HISTORY_MAX_HOURS,
  })
}

function indexExecutionConfigs() {
  const next = new Map()
  for (const config of executionConfigs) {
    if (typeof config?.entrySignalKey !== "string") continue
    const candidates = next.get(config.entrySignalKey)
    if (candidates) candidates.push(config)
    else next.set(config.entrySignalKey, [config])
  }
  executionConfigsBySignal = next
}

function refreshActiveExecutionConfigs() {
  // Pulse updates operate only on the matching execution slice. The complete
  // all-strategy grid remains chunked in Redis and is never copied into this
  // long-running worker merely to evaluate inactive signal lines.
  const candidates = []
  for (const key of activeSignalKeys) {
    const entries = executionConfigsBySignal.get(key)
    if (entries) candidates.push(...entries)
  }
  activeExecutionConfigs = candidates
}

async function loadActiveExecutionConfigs() {
  try {
    const result = await apiCall("/api/trade-engine/direct-trade?includeExecution=1&activeOnly=1")
    if (!Array.isArray(result?.executionConfigs)) return false
    configs = result.executionConfigs
    executionConfigs = result.executionConfigs.filter((config) => config?.valid !== false)
    indexExecutionConfigs()
    refreshActiveExecutionConfigs()
    return true
  } catch (err) {
    log("warn", "Could not load execution slice for active signals", err.message)
    trackError()
    return false
  }
}

async function refreshActiveSignals() {
  try {
    const result = await apiCall("/api/trade-engine/direct-trade/pulse")
    if (!result?.success || !Array.isArray(result.activeSignalKeys)) return false
    activeSignalKeys = new Set(result.activeSignalKeys.filter((key) => typeof key === "string"))
    lastSignalPulseAt = Date.now()
    await loadActiveExecutionConfigs()
    log("debug", `Signal pulse: ${activeSignalKeys.size}/${Number(result.signalsEvaluated || 0)} active signal lines; ${activeExecutionConfigs.length} executable variants`)
    return true
  } catch (err) {
    log("warn", "Signal pulse failed; retaining the last fresh signal snapshot", err.message)
    trackError()
    return false
  }
}

function evaluateConfigPerformance(key) {
  const history = configPerformance.get(key) || []
  const previous = configStatus.get(key)
  if (previous?.permanentlyDeactivated) {
    return {
      enabled: false,
      permanentlyDeactivated: true,
      sampleCount: history.length,
      pf: previous.pf ?? 0,
      avgDDT: previous.avgDDT ?? 0,
      totalPnl: previous.totalPnl ?? 0,
      reason: "negative_deactivation_window",
    }
  }
  const deactivationWindow = Math.max(3, Number(state.deactivatePosCount) || 16)
  if (history.length >= deactivationWindow) {
    const deactivationSample = history.slice(-deactivationWindow)
    const avgPnl = deactivationSample.reduce((sum, position) => sum + position.pnl, 0) / deactivationSample.length
    if (avgPnl < 0) {
      return {
        enabled: false,
        permanentlyDeactivated: true,
        sampleCount: history.length,
        pf: 0,
        avgDDT: Number((deactivationSample.reduce((sum, position) => sum + (position.drawdownTimeMin || 0), 0) / deactivationSample.length).toFixed(2)),
        totalPnl: Number(deactivationSample.reduce((sum, position) => sum + position.pnl, 0).toFixed(4)),
        reason: "negative_deactivation_window",
      }
    }
  }
  if (history.length < state.keepEnabledPosCount) {
    return { enabled: true, permanentlyDeactivated: false, sampleCount: history.length, pf: 0, avgDDT: 0, totalPnl: 0, reason: "warming" }
  }
  const sampled = history.slice(-state.keepEnabledPosCount)
  const totalProfit = sampled.filter((p) => p.pnl > 0).reduce((sum, p) => sum + p.pnl, 0)
  const totalLoss = Math.abs(sampled.filter((p) => p.pnl <= 0).reduce((sum, p) => sum + p.pnl, 0))
  const pfInfinite = totalLoss === 0 && totalProfit > 0
  const pf = totalLoss > 0 ? totalProfit / totalLoss : 0
  const totalPnl = sampled.reduce((sum, p) => sum + p.pnl, 0)
  const avgDDT = sampled.reduce((sum, p) => sum + (p.drawdownTimeMin || 0), 0) / sampled.length
  const enabled = totalPnl > 0 && (pfInfinite || pf >= state.minProfitFactor) && avgDDT <= state.maxDrawdownTimeMin
  return {
    enabled,
    permanentlyDeactivated: false,
    sampleCount: sampled.length,
    pf: pfInfinite ? null : Number(pf.toFixed(3)),
    pfInfinite,
    avgDDT: Number(avgDDT.toFixed(2)),
    totalPnl: Number(totalPnl.toFixed(4)),
    reason: enabled ? "positive" : totalPnl <= 0 ? "non_positive_pnl" : (!pfInfinite && pf < state.minProfitFactor) ? "pf" : "ddt",
  }
}

// ─── Config Calculation ───────────────────────────────────────────────────────

function calculationInputsSignature(input = state, historyHoursOverride = null) {
  return JSON.stringify({
    symbolCount: input.symbolCount,
    symbolOrder: input.symbolOrder,
    minVolFactor: input.minVolFactor,
    positionCostPercent: input.positionCostPercent,
    takeProfitRatioRange: input.takeProfitRatioRange,
    takeProfitRatioStep: input.takeProfitRatioStep,
    trailingMinTakeProfitRatio: input.trailingMinTakeProfitRatio,
    maxSlRatio: input.maxSlRatio,
    slRatioStep: input.slRatioStep,
    inverseMaxSlRatio: input.inverseMaxSlRatio,
    timeframes: input.timeframes,
    strategyTypes: input.strategyTypes,
    blockRange: input.blockRange,
    blockVolumeRatio: input.blockVolumeRatio,
    blockProfitFactorRatio: input.blockProfitFactorRatio,
    trailingEnabled: input.trailingEnabled,
    minProfitFactor: input.minProfitFactor,
    minRecentProfitFactor: input.minRecentProfitFactor,
    recentEvaluationPositions: input.recentEvaluationPositions,
    maxDrawdownTimeMin: input.maxDrawdownTimeMin,
    historyHours: historyHoursOverride == null ? input.historyHours : historyHoursOverride,
    entryTactics: input.entryTactics,
    exitTactics: input.exitTactics,
    entryTiming: input.entryTiming,
    activityVolumeRatio: input.activityVolumeRatio,
    maxHoldMinutes: input.maxHoldMinutes,
    dcaProfile: normalizeDirectDcaProfile(input.dcaProfile),
  })
}

async function recalculateConfigs() {
  log("info", "Recalculating optimal configs...")
  const requestedHistoryHours = requiredCalculationHistoryHours()
  const configuredHistoryHours = configuredCalculationHistoryHours()
  const calculationInputs = calculationInputsSignature(state, requestedHistoryHours)
  try {
    const result = await apiCall("/api/trade-engine/direct-trade/calculate", "POST", {
      symbolCount: state.symbolCount,
      symbolOrder: state.symbolOrder,
      minVolFactor: state.minVolFactor,
      positionCostPercent: state.positionCostPercent,
      maxSlRatio: state.maxSlRatio,
      slRatioStep: state.slRatioStep,
      inverseMaxSlRatio: state.inverseMaxSlRatio,
      timeframes: state.timeframes,
      strategyTypes: state.strategyTypes,
      takeProfitRatioRange: state.takeProfitRatioRange,
      takeProfitRatioStep: state.takeProfitRatioStep,
      trailingMinTakeProfitRatio: state.trailingMinTakeProfitRatio,
      blockRange: state.blockRange,
      blockVolumeRatio: state.blockVolumeRatio,
      blockProfitFactorRatio: state.blockProfitFactorRatio,
      trailingEnabled: state.trailingEnabled,
      minProfitFactor: state.minProfitFactor,
      minRecentProfitFactor: state.minRecentProfitFactor,
      recentEvaluationPositions: state.recentEvaluationPositions,
      maxDrawdownTimeMin: state.maxDrawdownTimeMin,
      // Live mode has an exact pre-entry warmup contract. The persisted paper
      // range remains untouched. If the baseline is statistically sparse the
      // processor may request one bounded expansion without weakening any
      // PF/DDT/win-rate gate.
      historyHours: requestedHistoryHours,
      requestedHistoryHours: configuredHistoryHours,
      entryTactics: state.entryTactics,
      exitTactics: state.exitTactics,
      entryTiming: state.entryTiming,
      activityVolumeRatio: state.activityVolumeRatio,
      maxHoldMinutes: state.maxHoldMinutes,
      dcaProfile: normalizeDirectDcaProfile(state.dcaProfile),
    }, 300_000)

    if (result.success && processorLeaseHeld) {
      if (calculationInputs !== calculationInputsSignature(state, requiredCalculationHistoryHours())) {
        // A settings acknowledgement arrived while this long historical grid
        // was evaluating. Do not open an entry from the now-stale generation;
        // the next owned pulse starts the exact new grid.
        lastRecalcAt = 0
        log("info", "Direct-Trade settings changed during calculation; scheduling an exact replacement grid")
        return false
      }
      calculationVersion = result.summary?.calculatedAt || result.timestamp || calculationVersion
      calculationHistoryHours = Number(result.summary?.historyHours) || requestedHistoryHours
      lastHistoryPolicy = assessCalculationHistory(result.summary, calculationHistoryHours)
      if (!lastHistoryPolicy.canProceed) {
        adaptiveHistoryHours = lastHistoryPolicy.nextHistoryHours
        lastRecalcAt = 0
        configs = []
        executionConfigs = []
        activeExecutionConfigs = []
        executionConfigsBySignal = new Map()
        activeSignalKeys = new Set()
        lastSignalPulseAt = 0
        stateDirty = true
        log(
          "warn",
          `Historic ${calculationHistoryHours}h graph is insufficient (${lastHistoryPolicy.reasons.join(", ")}); ` +
            `expanding once to ${adaptiveHistoryHours}h before realtime entries`,
        )
        await persistState()
        return false
      }
      adaptiveHistoryHours = calculationHistoryHours
      lastRecalcAt = Date.now()
      // The API stores the full grid in chunks. Active candidates are loaded
      // after the causal pulse below, never as one multi-million-row payload.
      await loadState()
      log(
        lastHistoryPolicy.sufficient ? "info" : "warn",
        `Recalculated: ${Number(result.configTotal || 0)} evaluated / ` +
          `${Number(result.executionConfigTotal || executionConfigs.length)} valid configs for ${result.symbols?.length || 0} symbols; ` +
          `history=${calculationHistoryHours}h requested=${configuredHistoryHours}h ` +
          `coverage=${lastHistoryPolicy.sufficient ? "sufficient" : "maximum reached, eligible rows only"}`,
      )

      // Save to server
      await apiCall("/api/trade-engine/direct-trade", "POST", {
        action: "update-config",
        lastRecalcAt: new Date().toISOString(),
      }).catch(() => {})

      stateDirty = true
      await persistState()
      await refreshActiveSignals()
      return true
    }
    return false
  } catch (err) {
    log("error", "Recalculation failed", err.message)
    trackError()
    return false
  }
}

// ─── Position Management ──────────────────────────────────────────────────────

function normalizedControlOrderStatus(result) {
  return String(result?.fill?.status || result?.details?.status || result?.details?.orderStatus || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
}

function isTerminalControlOrderResult(result, requestedQuantity = 0) {
  if (result?.controlState === "completed" || result?.controlState === "failed") return true
  if (result?.pendingReconciliation === true) return false
  const status = normalizedControlOrderStatus(result)
  if ([
    "filled",
    "fully_filled",
    "closed",
    "complete",
    "completed",
    "done",
    "cancelled",
    "canceled",
    "rejected",
    "expired",
    "failed",
  ].includes(status)) return true
  if (status.includes("partial")) return false
  const filledQuantity = Number(result?.fill?.filledQty || result?.details?.filledQty || result?.details?.executedQty || 0)
  return requestedQuantity > 0 && filledQuantity >= requestedQuantity * 0.999999
}

function markOpeningFailed(position, reason) {
  position.status = "open_failed"
  position.openState = "failed"
  position.openFailureReason = String(reason || "Exchange order completed without an executable fill").slice(0, 300)
  position.openFailedAt = new Date().toISOString()
  stateDirty = true
  log("warn", `Opening ${position.direction} ${position.symbol} ended without a position`, position.openFailureReason)
}

function applyEntryOrderSettlement(position, orderResult, orderId = null) {
  const settlement = orderResult?.settlement
  const exactOrderId = String(settlement?.orderId || orderId || "").trim()
  const knownIds = Array.isArray(position.entrySettlementOrderIds)
    ? position.entrySettlementOrderIds.map(String)
    : []
  if (!settlement || !exactOrderId || knownIds.includes(exactOrderId)) return 0
  const fee = Math.max(0, Number(settlement.tradingFee) || 0)
  position.entryTradingFeeUsdt = Number(((Number(position.entryTradingFeeUsdt) || 0) + fee).toFixed(12))
  position.entrySettlementOrderIds = [...knownIds, exactOrderId].slice(-32)
  position.entrySettlementSources = Array.from(new Set([
    ...(Array.isArray(position.entrySettlementSources) ? position.entrySettlementSources : []),
    String(settlement.source || "exchange_settlement"),
  ])).slice(-8)
  return fee
}

function entryLegCollections(position) {
  return [position.positionLegs, position.blockLegs, position.dcaLegs]
    .filter((collection) => Array.isArray(collection))
}

function markEntryLegAccountingComplete(position, control, settlement, fee) {
  const controlId = String(control?.controlId || "")
  const orderId = String(settlement?.orderId || control?.orderId || "")
  let matched = false
  for (const collection of entryLegCollections(position)) {
    for (const leg of collection) {
      if (!leg || typeof leg !== "object") continue
      const sameControl = controlId && String(leg.controlId || "") === controlId
      const sameOrder = orderId && String(leg.orderId || "") === orderId
      if (!sameControl && !sameOrder) continue
      leg.controlId = leg.controlId || controlId || null
      leg.orderId = leg.orderId || orderId || null
      leg.tradingFeeUsdt = Math.max(0, Number(settlement?.tradingFee) || Number(fee) || 0)
      leg.accountingComplete = true
      leg.settlementSource = settlement?.source || "exchange_settlement"
      matched = true
    }
  }
  return matched
}

function refreshEntryAccountingState(position) {
  const legs = Array.isArray(position.positionLegs) ? position.positionLegs : []
  position.entryAccountingComplete = legs.length > 0
    ? legs.every((leg) => leg?.accountingComplete === true)
    : Array.isArray(position.entrySettlementOrderIds) && position.entrySettlementOrderIds.length > 0
  return position.entryAccountingComplete
}

function recomputeClosedLiveSettlement(position) {
  if (position.mode !== "live" || position.status !== "closed") return false
  const settlement = position.closeSettlement
  const settlementNet = Number(settlement?.netRealizedPnl)
  if (!settlement || !Number.isFinite(settlementNet)) return false
  if (!settlement.netIncludesEntryFee && position.entryAccountingComplete !== true) return false

  const totalEntryFee = Math.max(0, Number(position.entryTradingFeeUsdt) || 0)
  const entryFeeAllocatedBeforeFinal = Math.max(
    0,
    Number(position.entryTradingFeeAllocatedBeforeFinalUsdt) || 0,
  )
  const partialRealizedPnlUsdt = Number(position.partialRealizedPnlUsdt) || 0
  const realizedPnlUsdt = settlement.netIncludesEntryFee
    ? partialRealizedPnlUsdt + settlementNet
    : partialRealizedPnlUsdt + entryFeeAllocatedBeforeFinal + settlementNet - totalEntryFee
  const baseEntryNotionalUsdt = Number(position.baseEntryNotionalUsdt) > 0
    ? Number(position.baseEntryNotionalUsdt)
    : Number(position.entryNotionalUsdt) || 0
  position.realizedPnlUsdt = Number(realizedPnlUsdt.toFixed(8))
  if (baseEntryNotionalUsdt > 0) {
    position.pnl = Number(((realizedPnlUsdt / baseEntryNotionalUsdt) * 100).toFixed(4))
  }
  const settlementGross = Number(settlement.grossRealizedPnl)
  if (Number.isFinite(settlementGross)) {
    position.grossPnlUsdt = Number(((Number(position.partialGrossPnlUsdt) || 0) + settlementGross).toFixed(8))
  }
  position.entryTradingFeeAllocatedUsdt = Number(totalEntryFee.toFixed(12))
  const partialTradingFeeUsdt = Math.max(0, Number(position.partialTradingFeeUsdt) || 0)
  const finalTradingFeeUsdt = Math.max(0, Number(settlement.tradingFee) || 0)
  position.tradingFeeUsdt = Number((settlement.netIncludesEntryFee
    ? partialTradingFeeUsdt + finalTradingFeeUsdt
    : Math.max(0, partialTradingFeeUsdt - entryFeeAllocatedBeforeFinal) + finalTradingFeeUsdt + totalEntryFee
  ).toFixed(12))
  position.closeAccountingComplete = true
  position.pnlAccountingComplete = true
  position.pnlAccountingSource = "exchange_settlement"
  position.closeSettlementSource = settlement.source || "exchange_settlement"
  position.pnlAccountingReconciledAt = new Date().toISOString()
  recordAccountedConfigOutcome(position, position.exitReason)
  rebuildRealizedNotionalStats()
  stateDirty = true
  return true
}

function pendingEntryAccountingControl(position) {
  const legs = Array.isArray(position.positionLegs) ? position.positionLegs : []
  const pending = legs.find((leg) => leg?.accountingComplete !== true && leg?.controlId)
  if (pending) return pending
  if (
    position.entryAccountingComplete !== true
    && position.openControlId
    && !(Array.isArray(position.entrySettlementOrderIds) && position.entrySettlementOrderIds.includes(position.openOrderId || position.orderId))
  ) {
    return {
      controlId: position.openControlId,
      orderId: position.openOrderId || position.orderId || null,
      requestedQuantity: position.openRequestedQuantity || position.initialQuantity || position.quantity,
      requestedPrice: position.openRequestedPrice || position.initialEntryPrice || position.entryPrice,
      quantity: position.initialQuantity || position.quantity,
      entryPrice: position.initialEntryPrice || position.entryPrice,
      blockCount: 0,
    }
  }
  return null
}

async function reconcileOneIncompleteLiveAccounting() {
  const now = Date.now()
  const position = positions.find((candidate) => (
    candidate?.mode === "live"
    && candidate?.entryAccountingComplete !== true
    && (candidate?.status === "open" || candidate?.status === "closed")
    && now - Number(candidate.entryAccountingLastCheckedAt || 0) >= 5_000
    && pendingEntryAccountingControl(candidate)
  ))
  if (!position) return false
  const control = pendingEntryAccountingControl(position)
  if (!control) return false
  position.entryAccountingLastCheckedAt = now

  try {
    await rateLimiter.acquire()
    const orderResult = await apiCall("/api/trade-engine/direct-trade/order", "POST", {
      kind: "open",
      stage: Number(control.step) > 0 ? "dca" : Number(control.blockCount) > 0 ? "block" : "entry",
      instanceId: processorInstanceId,
      positionId: position.id,
      controlId: control.controlId,
      connectionId: position.connectionId || state.connectionId,
      symbol: position.symbol,
      positionDirection: position.direction,
      quantity: Number(control.requestedQuantity || control.quantity),
      price: Number(control.requestedPrice || control.entryPrice),
      leverage: 10,
      reconcileOnly: true,
    })
    if (!orderResult?.success || !orderResult?.settlement) {
      position.entryAccountingLastError = String(orderResult?.error || "venue settlement is not available yet").slice(0, 300)
      stateDirty = true
      return false
    }
    const fee = applyEntryOrderSettlement(position, orderResult, orderResult.orderId || control.orderId)
    markEntryLegAccountingComplete(position, control, orderResult.settlement, fee)
    refreshEntryAccountingState(position)
    position.entryAccountingLastError = null
    position.entryAccountingReconciledAt = new Date().toISOString()
    if (position.status === "closed") recomputeClosedLiveSettlement(position)
    stateDirty = true
    log("info", `Reconciled exchange entry accounting for ${position.symbol} control ${control.controlId}`)
    return true
  } catch (error) {
    position.entryAccountingLastError = String(error?.message || error).slice(0, 300)
    stateDirty = true
    if (String(error?.message || error).includes("429")) rateLimiter.backoff(3_000)
    return false
  }
}

async function reconcileOneIncompleteLiveCloseAccounting() {
  const now = Date.now()
  const position = positions.find((candidate) => (
    candidate?.mode === "live"
    && candidate?.status === "closed"
    && candidate?.pnlAccountingComplete !== true
    && candidate?.lastAppliedCloseControlId
    && !candidate?.closeSettlement
    && now - Number(candidate.closeAccountingLastCheckedAt || 0) >= 5_000
  ))
  if (!position) return false
  position.closeAccountingLastCheckedAt = now
  try {
    await rateLimiter.acquire()
    const orderResult = await apiCall("/api/trade-engine/direct-trade/order", "POST", {
      kind: "close",
      instanceId: processorInstanceId,
      positionId: position.id,
      controlId: position.lastAppliedCloseControlId,
      connectionId: position.connectionId || state.connectionId,
      symbol: position.symbol,
      positionDirection: position.direction,
      quantity: Number(position.closeRequestedQuantity || position.quantity),
      price: Number(position.closeRequestedPrice || position.exitPrice),
      leverage: 10,
      reconcileOnly: true,
    })
    if (!orderResult?.success || !orderResult?.settlement) {
      position.closeAccountingLastError = String(orderResult?.error || "venue settlement is not available yet").slice(0, 300)
      stateDirty = true
      return false
    }
    position.closeSettlement = orderResult.settlement
    position.closeSettlementSource = orderResult.settlement.source || null
    position.closeAccountingLastError = null
    const exchangeExitPrice = Number(orderResult.fill?.filledPrice || orderResult.settlement.averageFillPrice)
    if (exchangeExitPrice > 0) position.exitPrice = exchangeExitPrice
    const complete = recomputeClosedLiveSettlement(position)
    stateDirty = true
    log(
      complete ? "info" : "warn",
      complete
        ? `Reconciled exchange close accounting for ${position.symbol} control ${position.lastAppliedCloseControlId}`
        : `Close settlement recovered for ${position.symbol}; waiting for entry-fee accounting`,
    )
    return complete
  } catch (error) {
    position.closeAccountingLastError = String(error?.message || error).slice(0, 300)
    stateDirty = true
    if (String(error?.message || error).includes("429")) rateLimiter.backoff(3_000)
    return false
  }
}

function finalizeOpenedPosition(position, filledPrice, filledQuantity, orderId = null) {
  const entryPrice = Number(filledPrice)
  const quantity = Number(filledQuantity)
  if (!(entryPrice > 0) || !(quantity > 0)) return false

  position.status = "open"
  position.openState = "filled"
  position.openedAt = position.openedAt || new Date().toISOString()
  position.entryPrice = entryPrice
  position.quantity = quantity
  position.blockBaseQuantity = quantity
  position.blockAddedQuantity = quantity * Number(position.blockCount || 0) * Number(position.blockVolumeRatio || 1)
  position.targetBlockQuantity = quantity + position.blockAddedQuantity
  if (orderId && orderId !== "N/A") {
    position.orderId = orderId
    if (position.mode === "live") position.exchangeOrderId = orderId
  }
  position.blockLegs = [{
    setKey: `${position.configKey}#block:0`,
    blockCount: 0,
    quantity,
    entryPrice,
    volumeRatio: position.blockVolumeRatio,
    volumeMultiplier: 1,
    orderId: position.orderId || null,
    controlId: position.openControlId || null,
    requestedQuantity: Number(position.openRequestedQuantity) || quantity,
    requestedPrice: Number(position.openRequestedPrice) || entryPrice,
    accountingComplete: position.mode !== "live",
    settlementSource: null,
    addedAt: Date.now(),
  }]
  position.positionLegs = [...position.blockLegs]
  position.baseEntryNotionalUsdt = Number((entryPrice * quantity).toFixed(8))
  position.entryNotionalUsdt = position.baseEntryNotionalUsdt
  position.initialEntryNotionalUsdt = position.baseEntryNotionalUsdt
  position.initialQuantity = quantity
  position.initialEntryPrice = entryPrice
  position.averageEntryPrice = entryPrice
  position.dcaTakeProfitPrice = position.strategyType === "dca" ? directDcaTakeProfitPrice(position) : 0
  position.blockLastPulseAt = lastSignalPulseAt
  if (position.direction === "long") {
    position.highWatermark = entryPrice
    position.currentSlPrice = entryPrice * (1 - Number(position.stoploss || 0) / 100)
  } else {
    position.lowWatermark = entryPrice
    position.currentSlPrice = entryPrice * (1 + Number(position.stoploss || 0) / 100)
  }
  position.lastObservedPrice = entryPrice
  if (!position.openStatsApplied) {
    stats.totalOrders++
    stats.totalFilled++
    position.openStatsApplied = true
  }
  stats.lastPositionAt = position.openedAt
  stateDirty = true
  log("info", `Opened ${position.mode} ${position.direction} ${position.symbol} @ ${entryPrice.toFixed(4)} (Type:${position.strategyType} TF:${position.timeframe} TP:${position.takeprofit}% SL:${position.stoploss}% Exit:${position.exitTactic || "default"})`)
  return true
}

async function submitOrReconcileOpening(position, reconcileOnly = false) {
  if (position.status !== "opening") return position.status === "open"
  const connectionId = position.connectionId || state.connectionId
  if (!connectionId || !PROCESSOR_TOKEN) {
    markOpeningFailed(position, "Missing explicit live connection or worker token")
    await persistState()
    return false
  }

  try {
    // Older persisted IDs can contain timeframe separators such as `5m+15m`.
    // Canonicalize before retrying so recovery does not remain stuck at the
    // gateway's identifier validation boundary.
    position.openControlId = normalizeDirectTradeControlId(
      position.openControlId,
      `dtopen_${position.id}`,
    )
    await rateLimiter.acquire()
    position.openAttemptedAt = position.openAttemptedAt || new Date().toISOString()
    const orderResult = await apiCall("/api/trade-engine/direct-trade/order", "POST", {
      kind: "open",
      stage: "entry",
      instanceId: processorInstanceId,
      positionId: position.id,
      controlId: position.openControlId,
      connectionId,
      symbol: position.symbol,
      positionDirection: position.direction,
      quantity: position.openRequestedQuantity,
      price: position.openRequestedPrice,
      leverage: 10,
      reconcileOnly,
    })
    position.openControlState = orderResult?.controlState || position.openControlState || "acknowledged"
    position.openOrderId = orderResult?.orderId && orderResult.orderId !== "N/A"
      ? orderResult.orderId
      : position.openOrderId || null
    position.openLastCheckedAt = new Date().toISOString()

    if (!orderResult?.success) {
      if (orderResult?.controlState === "failed") {
        markOpeningFailed(position, orderResult?.error || "Exchange rejected the entry")
        await persistState()
      }
      return false
    }
    if (!isTerminalControlOrderResult(orderResult, position.openRequestedQuantity)) {
      position.openState = "pending_reconciliation"
      stateDirty = true
      await persistState()
      return false
    }

    const exchangeEntryPrice = Number(orderResult.fill?.filledPrice || orderResult.details?.avgPrice)
    const exchangeFilledQuantity = Number(orderResult.fill?.filledQty || orderResult.details?.filledQty)
    if (!(exchangeEntryPrice > 0) || !(exchangeFilledQuantity > 0)) {
      markOpeningFailed(position, `Terminal ${normalizedControlOrderStatus(orderResult) || "exchange"} response had no fill`)
      await persistState()
      return false
    }
    const finalized = finalizeOpenedPosition(position, exchangeEntryPrice, exchangeFilledQuantity, orderResult.orderId)
    if (finalized) {
      const entryFee = applyEntryOrderSettlement(position, orderResult, orderResult.orderId)
      position.entryAccountingComplete = Boolean(orderResult.settlement)
      if (position.blockLegs?.[0]) {
        position.blockLegs[0].tradingFeeUsdt = entryFee
        position.blockLegs[0].accountingComplete = Boolean(orderResult.settlement)
        position.blockLegs[0].settlementSource = orderResult.settlement?.source || null
      }
      if (position.positionLegs?.[0]) {
        position.positionLegs[0].tradingFeeUsdt = entryFee
        position.positionLegs[0].accountingComplete = Boolean(orderResult.settlement)
        position.positionLegs[0].settlementSource = orderResult.settlement?.source || null
      }
    }
    await persistState()
    return finalized
  } catch (err) {
    if (err.message?.includes("429")) rateLimiter.backoff(3_000)
    // While enabled, the exact same control id is retried and the service
    // reconciles it. After Stop, a 409 means no durable control reached the
    // service, so cancelling this never-submitted opening is safe.
    if (!state.enabled && String(err.message || err).includes("not currently authorised")) {
      markOpeningFailed(position, "Entry was stopped before its durable exchange control was created")
      await persistState()
      return false
    }
    position.openState = "pending_reconciliation"
    position.openLastError = String(err.message || err).slice(0, 300)
    stateDirty = true
    log("warn", `Opening reconciliation deferred for ${position.symbol}`, position.openLastError)
    trackError()
    return false
  }
}

async function processOpeningPositions() {
  const opening = positions.filter((position) => position.status === "opening")
  for (const position of opening) {
    if (Date.now() - Date.parse(position.openLastCheckedAt || "") < 1_000) continue
    await submitOrReconcileOpening(position, !state.enabled)
  }
}

function getOpenPositionsForSymbol(symbol, direction) {
  return positions.filter(
    (p) => p.symbol === symbol && p.direction === direction && (p.status === "open" || p.status === "opening")
  )
}

function currentRuntimePositions() {
  const runtimeMode = state.liveMode ? "live" : "simulated"
  return positions.filter((position) => (
    (position?.mode === "live" ? "live" : "simulated") === runtimeMode
  ))
}

function canOpenPosition(config) {
  const runtimePositions = currentRuntimePositions()
  // Derivatives venues net one physical position per symbol/direction slot.
  // Independent configuration variants may still be simulated and evaluated,
  // but two live rows must never own the same exchange slot or race each
  // other's reduce-only close.
  if (state.liveMode && runtimePositions.some((position) => (
    position?.symbol === config?.symbol
    && position?.direction === config?.direction
    && (position?.status === "open" || position?.status === "opening")
  ))) return false
  return assessDirectTradePositionCapacity({
    positions: runtimePositions,
    candidate: config,
    maxTotalPositions: state.maxTotalPositions,
    maxPositionsPerSymbol: state.maxPositionsPerSymbol,
    maxPositionsPerDirection: state.maxPositionsPerDirection,
  }).allowed
}

async function openPosition(config) {
  config = normalizeDirectTradeConfig(config)
  const posId = `dt_${config.symbol}_${config.direction}_${config.timeframe}_${Date.now()}`
  const isDca = (config.strategyType || "standard") === "dca"
  const dcaProfile = normalizeDirectDcaProfile(config.dcaProfile || state.dcaProfile)
  const finalDcaDistance = dcaProfile.stepDistancesPct[Math.max(0, dcaProfile.maxSteps - 1)]
  const requestedStoploss = isDca
    ? Math.max(Number(config.stoploss) || 0, finalDcaDistance + 0.35)
    : Number(config.stoploss) || 0
  const protection = normalizeDirectTradeProtection(
    config.takeprofit,
    requestedStoploss,
    Number(state.positionCostPercent) || 0.1,
  )

  const position = {
    id: posId,
    symbol: config.symbol,
    direction: config.direction,
    signalDirection: config.signalDirection || config.direction,
    strategyType: config.strategyType || "standard",
    timeframe: config.timeframe,
    entryPrice: 0,
    exitPrice: 0,
    quantity: 0,
    takeprofit: protection.takeprofit,
    stoploss: protection.stoploss,
    trailing: Boolean(config.trailing && state.trailingEnabled),
    trailingMode: config.trailingMode || (config.trailing ? "fixed" : "none"),
    trailStart: config.trailStart,
    trailStop: config.trailStop,
    autoTrailSensitivity: config.autoTrailSensitivity ?? null,
    exitTactic: config.exitTactic || "bracket",
    maxHoldMinutes: state.maxHoldMinutes,
    blockCount: isDca ? 0 : config.blockCount,
    blockVolumeRatio: config.blockVolumeRatio ?? config.volumeRatio ?? state.blockVolumeRatio,
    blockProfitFactorRatio: config.blockProfitFactorRatio ?? state.blockProfitFactorRatio,
    entrySignalKey: config.entrySignalKey || null,
    entryTactic: config.entryTactic || null,
    indicationType: config.entryTactic || null,
    blockAddedCount: 0,
    blockLastPulseAt: 0,
    blockRealizedVolumeMultiplier: 1,
    blockLegs: [],
    positionLegs: [],
    dcaProfile: isDca ? dcaProfile : null,
    dcaLegs: [],
    dcaPendingStep: 0,
    dcaRealizedVolumeMultiplier: 1,
    dcaTakeProfitPrice: 0,
    initialEntryPrice: 0,
    averageEntryPrice: 0,
    baseEntryNotionalUsdt: 0,
    initialEntryNotionalUsdt: 0,
    initialQuantity: 0,
    partialCloseQuantity: 0,
    partialEntryNotionalUsdt: 0,
    partialGrossPnlUsdt: 0,
    partialRealizedPnlUsdt: 0,
    partialTradingFeeUsdt: 0,
    entryTradingFeeUsdt: 0,
    entryTradingFeeAllocatedUsdt: 0,
    entrySettlementOrderIds: [],
    entrySettlementSources: [],
    entryAccountingComplete: !state.liveMode,
    closeAccountingComplete: !state.liveMode,
    closeGeneration: 0,
    closeControlId: null,
    closeState: null,
    lastAppliedCloseControlId: null,
    positionCostPercent: Math.max(0.02, Math.min(1, Number(config.positionCostPercent) || Number(state.positionCostPercent) || 0.1)),
    status: state.liveMode ? "opening" : "open",
    openedAt: new Date().toISOString(),
    closedAt: null,
    pnl: 0,
    drawdownTimeMin: 0,
    highWatermark: 0,
    lowWatermark: Infinity,
    currentSlPrice: 0,
    trailingArmed: false,
    lastObservedPrice: 0,
    mode: state.liveMode ? "live" : "simulated",
    connectionId: state.connectionId || null,
    configKey: configKey(config),
  }

  // Both Paper and live flows use the same causal public price for initial
  // sizing. The exchange result remains authoritative for the recorded fill.
  let marketPrice = 0
  try {
    marketPrice = await readDirectTradeTicker(config.symbol)
  } catch (error) {
    log("warn", `Ticker read blocked for ${config.symbol}`, error?.message || error)
  }
  if (!marketPrice) return null
  // Factor 1 requests one fifth of the $5 Direct baseline. The connector is
  // still authoritative for quantity precision and the smallest executable
  // venue notional, so factor 0.1 stays minimal without creating invalid lots.
  const baseQuantity = (
    normalizeDirectTradeVolumeFactor(state.minVolFactor)
    * DIRECT_TRADE_BASE_NOTIONAL_PER_FACTOR_USDT
    * DIRECT_TRADE_EFFECTIVE_VOLUME_RATIO
  ) / marketPrice
  const blockSizing = resolveBlockSizing(config, baseQuantity)
  // Direct-Trade Block uses one base fill followed by causal, one-ratio add-on
  // fills. The historical simulator follows the same path. Keeping the full
  // target only as metadata prevents a Block PF from becoming a copied Base PF
  // while preserving the non-compounding formula B + (count × B × ratio).
  position.blockCount = blockSizing.blockCount
  position.blockVolumeRatio = blockSizing.blockVolumeRatio
  position.blockBaseQuantity = blockSizing.blockBaseQuantity
  position.blockAddedQuantity = blockSizing.blockAddedQuantity
  position.targetBlockQuantity = blockSizing.targetBlockQuantity
  position.quantity = blockSizing.blockBaseQuantity
  position.openControlId = normalizeDirectTradeControlId(`dtopen_${posId}`)
  position.openRequestedQuantity = blockSizing.blockBaseQuantity
  position.openRequestedPrice = marketPrice

  if (state.liveMode) {
    // Persist the economic intent before touching the exchange. A process
    // crash can therefore recover this exact control id instead of creating a
    // second position id/order on the next tick.
    positions.push(position)
    stateDirty = true
    if (!(await persistState())) return position
    await submitOrReconcileOpening(position, false)
    return position
  }

  finalizeOpenedPosition(position, marketPrice, blockSizing.blockBaseQuantity)
  positions.push(position)
  return position
}

function executionConfigForPosition(position) {
  const candidates = executionConfigs.length > 0 ? executionConfigs : activeExecutionConfigs
  return candidates.find((config) => {
    if (configKey(config) !== position.configKey) return false
    return !position.entrySignalKey || config.entrySignalKey === position.entrySignalKey
  }) || null
}

async function addDirectTradeBlockLeg(position, config) {
  const maximumCount = Math.max(0, Math.floor(Number(position.blockCount) || 0))
  const pendingCount = Math.max(0, Math.floor(Number(position.blockPendingCount) || 0))
  const hasPendingControl = pendingCount > 0 && Boolean(position.blockPendingControlId)
  if (maximumCount <= 0 || position.status !== "open") return false
  if (hasPendingControl) {
    if (Date.now() - Number(position.blockLastReconcileAt || 0) < 1_000) return false
  } else {
    if (!config || !state.enabled) return false
    if (!position.entrySignalKey || !activeSignalKeys.has(position.entrySignalKey)) return false
    if (!lastSignalPulseAt || Date.now() - lastSignalPulseAt > 90_000) return false
    if (Number(position.blockLastPulseAt) === lastSignalPulseAt) return false
  }

  const currentAddedCount = Math.max(
    0,
    Math.floor(Number(position.blockAddedCount) || (Array.isArray(position.blockLegs)
      ? position.blockLegs.filter((leg) => Number(leg?.blockCount) > 0).length
      : 0)),
  )
  const nextCount = hasPendingControl ? pendingCount : currentAddedCount + 1
  if (!hasPendingControl) position.blockLastPulseAt = lastSignalPulseAt
  if (nextCount > maximumCount) return false

  const baseQuantity = Number(position.blockBaseQuantity) || 0
  const volumeRatio = Math.max(0.1, Math.min(10, Number(position.blockVolumeRatio) || Number(state.blockVolumeRatio) || 1))
  const requestedQuantity = hasPendingControl
    ? Number(position.blockPendingRequestedQuantity)
    : baseQuantity * volumeRatio
  const marketPrice = hasPendingControl
    ? Number(position.blockPendingRequestedPrice)
    : Number(position.lastObservedPrice) || 0
  if (!(baseQuantity > 0) || !(requestedQuantity > 0) || !(marketPrice > 0)) return false

  let filledPrice = marketPrice
  let filledQuantity = requestedQuantity
  let orderId = null
  let entrySettlement = null
  let appliedControlId = null
  if (position.mode === "live") {
    try {
      if (!(position.connectionId || state.connectionId) || !PROCESSOR_TOKEN) {
        log("error", `Block add for ${position.symbol} blocked: missing live connection or worker token`)
        return false
      }
      const controlGeneration = Math.max(0, Math.floor(Number(position.blockControlGeneration) || 0))
      const stableControlId = normalizeDirectTradeControlId(
        hasPendingControl
          ? position.blockPendingControlId
          : `dtblk_${String(position.id).slice(-25)}_${nextCount}_${controlGeneration}`,
        `dtblk_${String(position.id).slice(-25)}_${nextCount}_${controlGeneration}`,
      )
      appliedControlId = stableControlId
      if (!hasPendingControl) {
        position.blockPendingCount = nextCount
        position.blockPendingControlId = stableControlId
        position.blockPendingRequestedQuantity = requestedQuantity
        position.blockPendingRequestedPrice = marketPrice
        position.blockLastReconcileAt = 0
        stateDirty = true
        if (!(await persistState())) return false
      }
      const orderResult = await apiCall("/api/trade-engine/direct-trade/order", "POST", {
        kind: "open",
        stage: "block",
        instanceId: processorInstanceId,
        positionId: position.id,
        controlId: stableControlId,
        connectionId: position.connectionId || state.connectionId,
        symbol: position.symbol,
        positionDirection: position.direction,
        quantity: requestedQuantity,
        price: marketPrice,
        leverage: 10,
        reconcileOnly: hasPendingControl,
      })
      if (!orderResult?.success) {
        if (orderResult?.controlState === "failed") {
          position.blockControlGeneration = controlGeneration + 1
          position.blockPendingCount = 0
          position.blockPendingControlId = null
          position.blockPendingRequestedQuantity = 0
          position.blockPendingRequestedPrice = 0
          stateDirty = true
          await persistState()
        }
        log("warn", `Block add rejected for ${position.symbol} Count ${nextCount}`, orderResult?.error)
        return false
      }
      if (!isTerminalControlOrderResult(orderResult, requestedQuantity)) {
        position.blockPendingCount = nextCount
        position.blockPendingControlId = stableControlId
        position.blockPendingRequestedQuantity = requestedQuantity
        position.blockPendingRequestedPrice = marketPrice
        position.blockLastReconcileAt = Date.now()
        stateDirty = true
        log("debug", `Block add ${nextCount} for ${position.symbol} is pending exchange reconciliation`)
        return false
      }
      filledPrice = Number(orderResult.fill?.filledPrice || orderResult.details?.avgPrice)
      filledQuantity = Number(orderResult.fill?.filledQty || orderResult.details?.filledQty)
      orderId = orderResult.orderId || null
      entrySettlement = orderResult.settlement || null
      if (!(filledPrice > 0) || !(filledQuantity > 0)) {
        position.blockControlGeneration = controlGeneration + 1
        position.blockPendingCount = 0
        position.blockPendingControlId = null
        position.blockPendingRequestedQuantity = 0
        position.blockPendingRequestedPrice = 0
        stateDirty = true
        await persistState()
        log("warn", `Block add for ${position.symbol} Count ${nextCount} had no authoritative fill`)
        return false
      }
    } catch (err) {
      if (err.message?.includes("429")) rateLimiter.backoff(3000)
      if (!state.enabled && String(err.message || err).includes("not currently authorised")) {
        position.blockControlGeneration = Math.max(0, Math.floor(Number(position.blockControlGeneration) || 0)) + 1
        position.blockPendingCount = 0
        position.blockPendingControlId = null
        position.blockPendingRequestedQuantity = 0
        position.blockPendingRequestedPrice = 0
        stateDirty = true
        await persistState()
        return false
      }
      log("error", `Block add error for ${position.symbol} Count ${nextCount}`, err.message)
      trackError()
      return false
    }
  }

  const existingLegs = Array.isArray(position.positionLegs) && position.positionLegs.length > 0
    ? position.positionLegs
    : Array.isArray(position.blockLegs) ? position.blockLegs : []
  const currentNotional = existingLegs.reduce(
    (sum, leg) => sum + Math.abs(Number(leg?.entryPrice) || 0) * Math.abs(Number(leg?.quantity) || 0),
    0,
  ) || Math.abs(Number(position.entryPrice) || 0) * Math.abs(Number(position.quantity) || 0)
  const currentQuantity = Math.abs(Number(position.quantity) || 0)
  const nextQuantity = currentQuantity + filledQuantity
  position.quantity = nextQuantity
  position.entryNotionalUsdt = Number((currentNotional + filledPrice * filledQuantity).toFixed(8))
  position.blockAddedCount = nextCount
  position.blockPendingCount = 0
  position.blockPendingControlId = null
  position.blockPendingRequestedQuantity = 0
  position.blockPendingRequestedPrice = 0
  position.blockRealizedVolumeMultiplier = baseQuantity > 0 ? Number((nextQuantity / baseQuantity).toFixed(6)) : 1
  position.blockAddedQuantity = baseQuantity * nextCount * volumeRatio
  position.targetBlockQuantity = baseQuantity * (1 + maximumCount * volumeRatio)
  position.positionLegs = [
    ...existingLegs,
    {
      setKey: `${position.configKey}#block:${nextCount}`,
      blockCount: nextCount,
      quantity: filledQuantity,
      entryPrice: filledPrice,
      baseQuantity,
      volumeRatio,
      volumeIncrementRatio: nextCount * volumeRatio,
      volumeMultiplier: 1 + nextCount * volumeRatio,
      targetBlockQuantity: baseQuantity * (1 + nextCount * volumeRatio),
      orderId,
      controlId: appliedControlId,
      controlGeneration: Math.max(0, Math.floor(Number(position.blockControlGeneration) || 0)),
      requestedQuantity,
      requestedPrice: marketPrice,
      tradingFeeUsdt: Math.max(0, Number(entrySettlement?.tradingFee) || 0),
      accountingComplete: position.mode !== "live" || Boolean(entrySettlement),
      settlementSource: entrySettlement?.source || null,
      addedAt: Date.now(),
    },
  ]
  position.blockLegs = [...position.positionLegs]
  if (position.mode === "live") {
    applyEntryOrderSettlement(position, { settlement: entrySettlement }, orderId)
    position.entryAccountingComplete = Boolean(position.entryAccountingComplete && entrySettlement)
  }
  stats.totalOrders++
  stats.totalFilled++
  stateDirty = true
  if (position.mode === "live") await persistState()
  log("info", `Added ${position.mode} Block Count ${nextCount}/${maximumCount} ${position.direction} ${position.symbol} @ ${filledPrice.toFixed(4)} qty ${filledQuantity}`)
  return true
}

async function processDirectTradeBlockAdds() {
  const openBlockPositions = positions.filter((position) => {
    return position.status === "open"
      && Number(position.blockCount) > 0
      && Number(position.blockAddedCount || 0) < Number(position.blockCount)
  })
  for (const position of openBlockPositions) {
    const config = executionConfigForPosition(position)
    await addDirectTradeBlockLeg(position, config)
  }
}

async function processPendingAccumulationOrders() {
  const pending = positions.filter((position) => position.status === "open" && (
    position.blockPendingControlId || position.dcaPendingControlId
  ))
  for (const position of pending) {
    if (position.blockPendingControlId) {
      await addDirectTradeBlockLeg(position, executionConfigForPosition(position))
    }
    if (position.dcaPendingControlId) {
      await addDirectTradeDcaLeg(
        position,
        Number(position.dcaPendingRequestedPrice) || Number(position.lastObservedPrice),
      )
    }
  }
}

async function addDirectTradeDcaLeg(position, currentPrice) {
  const pendingControlStep = Math.max(0, Math.floor(Number(position.dcaPendingControlStep) || 0))
  const hasPendingControl = pendingControlStep > 0 && Boolean(position.dcaPendingControlId)
  if ((!state.enabled && !hasPendingControl) || position.status !== "open" || position.strategyType !== "dca") return false
  if (!(Number(currentPrice) > 0) && !hasPendingControl) return false

  const profile = normalizeDirectDcaProfile(position.dcaProfile || state.dcaProfile)
  position.dcaProfile = profile
  if (!hasPendingControl) {
    const retryCooldownMs = Math.max(5_000, profile.cooldownSeconds * 1_000)
    if (Date.now() - Number(position.dcaLastFailureAt || 0) < retryCooldownMs) return false
  }
  const baseQuantity = Math.abs(Number(position.initialQuantity || position.blockBaseQuantity) || 0)
  const currentQuantity = Math.abs(Number(position.quantity) || 0)
  const initialEntryPrice = Number(position.initialEntryPrice || position.entryPrice)
  if (!(baseQuantity > 0) || !(currentQuantity > 0) || !(initialEntryPrice > 0)) return false

  const legs = Array.isArray(position.dcaLegs) ? position.dcaLegs : []
  const completedSteps = new Set(legs.filter((leg) => Number(leg?.quantity) > 0).map((leg) => Math.floor(Number(leg.step))))
  let nextStep = hasPendingControl ? pendingControlStep : 0
  if (!nextStep) {
    for (let step = 1; step <= profile.maxSteps; step++) {
      if (!completedSteps.has(step)) { nextStep = step; break }
    }
  }
  if (!nextStep) return false
  if (hasPendingControl && Date.now() - Number(position.dcaLastReconcileAt || 0) < 1_000) return false

  const lastFilledAt = legs.reduce((latest, leg) => Math.max(latest, Number(leg?.filledAt) || 0), 0)
  if (!hasPendingControl && lastFilledAt > 0 && Date.now() - lastFilledAt < profile.cooldownSeconds * 1_000) return false
  const adverseMove = hasPendingControl
    ? Number(position.dcaPendingAdverseMovePct)
    : directDcaAdverseMovePct(position.direction, initialEntryPrice, Number(currentPrice))
  const triggerDistancePct = hasPendingControl
    ? Number(position.dcaPendingTriggerDistancePct)
    : profile.stepDistancesPct[nextStep - 1]
  if (!hasPendingControl && adverseMove + 1e-12 < triggerDistancePct) return false

  const volumeMultiplier = profile.stepVolumeMultipliers[nextStep - 1]
  const remainingQuantity = Math.max(0, baseQuantity * profile.maxPositionVolumeRatio - currentQuantity)
  const requestedQuantity = hasPendingControl
    ? Number(position.dcaPendingRequestedQuantity)
    : Math.max(0, Math.min(baseQuantity * volumeMultiplier, remainingQuantity))
  if (!(requestedQuantity > Math.max(1e-12, baseQuantity * 1e-9))) return false

  let filledPrice = hasPendingControl ? Number(position.dcaPendingRequestedPrice) : Number(currentPrice)
  let filledQuantity = requestedQuantity
  let orderId = null
  let entrySettlement = null
  let appliedControlId = null
  try {
    if (position.mode === "live") {
      const connectionId = position.connectionId || state.connectionId
      if (!connectionId || !PROCESSOR_TOKEN) {
        log("error", `DCA add for ${position.symbol} blocked: missing live connection or worker token`)
        return false
      }
      await rateLimiter.acquire()
      const controlGeneration = Math.max(0, Math.floor(Number(position.dcaControlGeneration) || 0))
      const stableControlId = normalizeDirectTradeControlId(
        hasPendingControl
          ? position.dcaPendingControlId
          : `dtdca_${String(position.id).slice(-24)}_${nextStep}_${controlGeneration}`,
        `dtdca_${String(position.id).slice(-24)}_${nextStep}_${controlGeneration}`,
      )
      appliedControlId = stableControlId
      if (!hasPendingControl) {
        position.dcaPendingControlStep = nextStep
        position.dcaPendingControlId = stableControlId
        position.dcaPendingRequestedQuantity = requestedQuantity
        position.dcaPendingRequestedPrice = Number(currentPrice)
        position.dcaPendingTriggerDistancePct = triggerDistancePct
        position.dcaPendingAdverseMovePct = adverseMove
        position.dcaLastReconcileAt = 0
        stateDirty = true
        if (!(await persistState())) return false
      }
      const orderResult = await apiCall("/api/trade-engine/direct-trade/order", "POST", {
        kind: "open",
        stage: "dca",
        instanceId: processorInstanceId,
        positionId: position.id,
        // Retrying an ambiguous transport result reuses the exact control ID;
        // the control gateway therefore cannot double-fill one DCA step.
        controlId: stableControlId,
        connectionId,
        symbol: position.symbol,
        positionDirection: position.direction,
        quantity: requestedQuantity,
        price: hasPendingControl ? Number(position.dcaPendingRequestedPrice) : Number(currentPrice),
        leverage: 10,
        reconcileOnly: hasPendingControl,
      })
      if (!orderResult?.success) {
        if (orderResult?.controlState === "failed") {
          position.dcaControlGeneration = controlGeneration + 1
          position.dcaPendingControlStep = 0
          position.dcaPendingControlId = null
          position.dcaPendingRequestedQuantity = 0
          position.dcaPendingRequestedPrice = 0
          position.dcaLastFailureAt = Date.now()
          stateDirty = true
          await persistState()
        }
        log("warn", `DCA add rejected for ${position.symbol} Step ${nextStep}`, orderResult?.error)
        return false
      }
      if (!isTerminalControlOrderResult(orderResult, requestedQuantity)) {
        position.dcaPendingControlStep = nextStep
        position.dcaPendingControlId = stableControlId
        position.dcaLastReconcileAt = Date.now()
        stateDirty = true
        log("debug", `DCA Step ${nextStep} for ${position.symbol} is pending exchange reconciliation`)
        return false
      }
      filledPrice = Number(orderResult.fill?.filledPrice || orderResult.details?.avgPrice)
      filledQuantity = Number(orderResult.fill?.filledQty || orderResult.details?.filledQty)
      orderId = orderResult.orderId || null
      entrySettlement = orderResult.settlement || null
      if (!(filledPrice > 0) || !(filledQuantity > 0)) {
        position.dcaControlGeneration = controlGeneration + 1
        position.dcaPendingControlStep = 0
        position.dcaPendingControlId = null
        position.dcaPendingRequestedQuantity = 0
        position.dcaPendingRequestedPrice = 0
        position.dcaLastFailureAt = Date.now()
        stateDirty = true
        await persistState()
        log("warn", `DCA add for ${position.symbol} Step ${nextStep} had no authoritative fill`)
        return false
      }
    }

    const boundedFilledQuantity = Math.min(filledQuantity, remainingQuantity)
    if (!(boundedFilledQuantity > 0)) return false
    const currentLegs = Array.isArray(position.positionLegs) && position.positionLegs.length > 0
      ? position.positionLegs
      : [{ entryPrice: position.entryPrice, quantity: currentQuantity }]
    const currentNotional = currentLegs.reduce(
      (sum, leg) => sum + Math.abs(Number(leg?.entryPrice) || 0) * Math.abs(Number(leg?.quantity) || 0),
      0,
    )
    const nextQuantity = currentQuantity + boundedFilledQuantity
    const entryNotionalUsdt = currentNotional + filledPrice * boundedFilledQuantity
    const leg = {
      setKey: `${position.configKey}#dca:${nextStep}`,
      step: nextStep,
      quantity: boundedFilledQuantity,
      requestedQuantity,
      entryPrice: filledPrice,
      baseQuantity,
      volumeMultiplier,
      triggerDistancePct,
      adverseMovePct: adverseMove,
      orderId,
      controlId: appliedControlId,
      controlGeneration: Math.max(0, Math.floor(Number(position.dcaControlGeneration) || 0)),
      requestedPrice: hasPendingControl ? Number(position.dcaPendingRequestedPrice) : Number(currentPrice),
      tradingFeeUsdt: Math.max(0, Number(entrySettlement?.tradingFee) || 0),
      accountingComplete: position.mode !== "live" || Boolean(entrySettlement),
      settlementSource: entrySettlement?.source || null,
      filledAt: Date.now(),
    }
    position.positionLegs = [...currentLegs, leg]
    // Compatibility readers written before the canonical position ledger use
    // blockLegs for notional/PnL. Keep the same confirmed legs there as well.
    position.blockLegs = [...position.positionLegs]
    position.dcaLegs = [...legs, leg].slice(-4)
    position.dcaPendingControlStep = 0
    position.dcaPendingControlId = null
    position.dcaPendingRequestedQuantity = 0
    position.dcaPendingRequestedPrice = 0
    position.dcaPendingTriggerDistancePct = 0
    position.dcaPendingAdverseMovePct = 0
    position.dcaLastFailureAt = 0
    position.quantity = nextQuantity
    position.entryNotionalUsdt = Number(entryNotionalUsdt.toFixed(8))
    position.averageEntryPrice = entryNotionalUsdt / nextQuantity
    position.entryPrice = position.averageEntryPrice
    position.dcaRealizedVolumeMultiplier = Number((nextQuantity / baseQuantity).toFixed(6))
    position.dcaTakeProfitPrice = directDcaTakeProfitPrice(position)
    if (position.mode === "live") {
      applyEntryOrderSettlement(position, { settlement: entrySettlement }, orderId)
      position.entryAccountingComplete = Boolean(position.entryAccountingComplete && entrySettlement)
    }
    stats.totalOrders++
    stats.totalFilled++
    stateDirty = true
    if (position.mode === "live") await persistState()
    log("info", `Added ${position.mode} DCA Step ${nextStep}/${profile.maxSteps} ${position.direction} ${position.symbol} @ ${filledPrice.toFixed(4)} qty ${boundedFilledQuantity} total ${position.dcaRealizedVolumeMultiplier.toFixed(3)}×`)
    return true
  } catch (err) {
    if (err.message?.includes("429")) rateLimiter.backoff(3_000)
    if (!state.enabled && String(err.message || err).includes("not currently authorised")) {
      position.dcaControlGeneration = Math.max(0, Math.floor(Number(position.dcaControlGeneration) || 0)) + 1
      position.dcaPendingControlStep = 0
      position.dcaPendingControlId = null
      position.dcaPendingRequestedQuantity = 0
      position.dcaPendingRequestedPrice = 0
      position.dcaLastFailureAt = Date.now()
      stateDirty = true
      await persistState()
      return false
    }
    log("error", `DCA add error for ${position.symbol} Step ${nextStep}`, err.message)
    trackError()
    return false
  } finally {
    position.dcaPendingStep = 0
  }
}

function autoTrailingRuntimeParameters(pos) {
  const sensitivity = Math.max(0.5, Math.min(1.5, Number(pos.autoTrailSensitivity) || 1))
  const targetDistance = Math.max(0.08, Number(pos.takeprofit) * (0.28 + sensitivity * 0.1))
  const trailStop = Math.max(0.04, Math.min(targetDistance * 0.82, targetDistance * (0.32 + sensitivity * 0.08)))
  return { trailStart: targetDistance, trailStop }
}

function relativeExitRuntime(pos, currentPrice) {
  const takeprofit = Math.max(0.1, Number(pos.takeprofit) || 0.1)
  const activation = Math.max(0.1, Math.min(takeprofit * 0.5, 1.25))
  const retracement = Math.max(0.06, Math.min(takeprofit * 0.22, 0.65))
  if (pos.direction === "long") {
    return pos.highWatermark >= pos.entryPrice * (1 + activation / 100)
      && currentPrice <= pos.highWatermark * (1 - retracement / 100)
  }
  return pos.lowWatermark <= pos.entryPrice * (1 - activation / 100)
    && currentPrice >= pos.lowWatermark * (1 + retracement / 100)
}

function rebuildRealizedNotionalStats() {
  const runtimeMode = state.liveMode ? "live" : "simulated"
  const modeClosed = positions.filter((position) => {
    const positionMode = position.mode === "live" ? "live" : "simulated"
    return position.status === "closed" && positionMode === runtimeMode
  })
  const closed = modeClosed.filter((position) => (
    position.mode !== "live" || (
      position.pnlAccountingComplete === true
      && Number.isFinite(Number(position.realizedPnlUsdt))
    )
  ))
  const aggregate = (rows) => {
    let totalPnlUsdt = 0
    let totalGrossPnlUsdt = 0
    let totalPnl = 0
    let profitUsdt = 0
    let lossUsdt = 0
    let profit = 0
    let loss = 0
    for (const position of rows) {
      const entryNotional = Math.abs(Number(position.entryPrice) || 0) * Math.abs(Number(position.quantity) || 0)
      const net = Number.isFinite(Number(position.realizedPnlUsdt))
        ? Number(position.realizedPnlUsdt)
        : entryNotional > 0 ? entryNotional * (Number(position.pnl) || 0) / 100 : NaN
      const gross = Number.isFinite(Number(position.grossPnlUsdt))
        ? Number(position.grossPnlUsdt)
        : entryNotional > 0 ? entryNotional * (Number(position.grossPnl) || 0) / 100 : NaN
      if (!Number.isFinite(net)) continue
      totalPnlUsdt += net
      const pnl = Number(position.pnl) || 0
      totalPnl += pnl
      if (Number.isFinite(gross)) totalGrossPnlUsdt += gross
      if (net > 0) profitUsdt += net
      else lossUsdt += Math.abs(net)
      if (pnl > 0) profit += pnl
      else loss += Math.abs(pnl)
    }
    const profitFactorInfinite = runtimeMode === "live"
      ? lossUsdt === 0 && profitUsdt > 0
      : loss === 0 && profit > 0
    const profitFactor = runtimeMode === "live"
      ? lossUsdt > 0 ? profitUsdt / lossUsdt : null
      : loss > 0 ? profit / loss : null
    return {
      totalPnl: Number(totalPnl.toFixed(8)),
      totalPnlUsdt: Number(totalPnlUsdt.toFixed(8)),
      totalGrossPnlUsdt: Number(totalGrossPnlUsdt.toFixed(8)),
      profitFactor: profitFactor == null ? null : Number(profitFactor.toFixed(6)),
      profitFactorInfinite,
      profitFactorUsdt: lossUsdt > 0 ? Number((profitUsdt / lossUsdt).toFixed(6)) : null,
      profitFactorUsdtInfinite: lossUsdt === 0 && profitUsdt > 0,
    }
  }
  const all = aggregate(closed)
  stats.totalPnl = all.totalPnl
  stats.totalPnlUsdt = all.totalPnlUsdt
  stats.totalGrossPnlUsdt = all.totalGrossPnlUsdt
  stats.profitFactor = all.profitFactor
  stats.profitFactorInfinite = all.profitFactorInfinite
  stats.profitFactorUsdt = all.profitFactorUsdt
  stats.profitFactorUsdtInfinite = all.profitFactorUsdtInfinite
  stats.winCount = closed.filter((position) => (
    runtimeMode === "live" ? Number(position.realizedPnlUsdt) > 0 : Number(position.pnl) > 0
  )).length
  stats.lossCount = closed.length - stats.winCount
  stats.maxDrawdownTimeMin = closed.reduce(
    (maximum, position) => Math.max(maximum, Number(position.drawdownTimeMin) || 0),
    0,
  )
  stats.lastPositionAt = closed.at(-1)?.closedAt || null
  stats.accountingPending = modeClosed.length - closed.length
  let cumulativePnl = 0
  stats.pnlHistory = closed
    .slice()
    .sort((left, right) => Date.parse(left.closedAt || "") - Date.parse(right.closedAt || ""))
    .map((position) => {
      cumulativePnl += Number(position.pnl) || 0
      return {
        time: position.closedAt,
        pnl: Number(position.pnl) || 0,
        cumPnl: Number(cumulativePnl.toFixed(8)),
      }
    })
    .slice(-500)
  const byCount = {}
  for (const position of closed) {
    const count = Math.max(0, Math.floor(Number(position.blockCount) || 0))
    const key = String(count)
    const rows = byCount[key] || (byCount[key] = [])
    rows.push(position)
  }
  stats.blockStatsByCount = Object.fromEntries(Object.entries(byCount).map(([count, rows]) => [count, {
    blockCount: Number(count),
    closed: rows.length,
    ...aggregate(rows),
    volumeRatio: Number(rows.at(-1)?.blockVolumeRatio) || Number(state.blockVolumeRatio) || 1,
    meanQuantity: rows.length > 0 ? Number((rows.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0) / rows.length).toFixed(12)) : 0,
  }]))
}

function recordAccountedConfigOutcome(position, reason = position.exitReason || "closed") {
  if (position.configPerformanceRecorded === true) return false
  if (position.mode === "live" && position.pnlAccountingComplete !== true) return false
  if (!Number.isFinite(Number(position.pnl))) return false

  const positionConfigKey = position.configKey || configKey(position)
  if (!configPerformance.has(positionConfigKey)) configPerformance.set(positionConfigKey, [])
  const perfArr = configPerformance.get(positionConfigKey)
  if (!perfArr.some((entry) => entry?.positionId === position.id)) {
    perfArr.push({
      positionId: position.id,
      pnl: Number(position.pnl) || 0,
      drawdownTimeMin: Number(position.drawdownTimeMin) || 0,
      closedAt: position.closedAt,
      exitReason: reason,
      accountingSource: position.pnlAccountingSource || (position.mode === "live" ? "exchange_settlement" : "simulation_model"),
    })
  }
  const historyWindow = Math.max(
    1,
    Math.ceil(Number(state.keepEnabledPosCount) || 0),
    Math.ceil(Number(state.deactivatePosCount) || 0),
    Math.ceil(Number(state.prevPosWindow) || 0),
    Math.ceil(Number(state.evalPosCount) || 0),
  )
  if (perfArr.length > historyWindow) perfArr.splice(0, perfArr.length - historyWindow)

  const status = evaluateConfigPerformance(positionConfigKey)
  if (perfArr.length > 0 || status.permanentlyDeactivated || !status.enabled) {
    configStatus.set(positionConfigKey, { ...status, updatedAt: position.closedAt })
  }
  position.configPerformanceRecorded = true
  stateDirty = true
  return true
}

function rebuildAccountedConfigPerformance() {
  const runtimeMode = state.liveMode ? "live" : "simulated"
  const historyWindow = Math.max(
    1,
    Math.ceil(Number(state.keepEnabledPosCount) || 0),
    Math.ceil(Number(state.deactivatePosCount) || 0),
    Math.ceil(Number(state.prevPosWindow) || 0),
    Math.ceil(Number(state.evalPosCount) || 0),
  )
  const nextPerformance = new Map()
  const accounted = positions
    .filter((position) => {
      const positionMode = position.mode === "live" ? "live" : "simulated"
      return position.status === "closed"
        && positionMode === runtimeMode
        && (positionMode !== "live" || position.pnlAccountingComplete === true)
        && Number.isFinite(Number(position.pnl))
    })
    .sort((left, right) => Date.parse(left.closedAt || "") - Date.parse(right.closedAt || ""))
  for (const position of accounted) {
    const key = position.configKey || configKey(position)
    const rows = nextPerformance.get(key) || []
    rows.push({
      positionId: position.id,
      pnl: Number(position.pnl) || 0,
      drawdownTimeMin: Number(position.drawdownTimeMin) || 0,
      closedAt: position.closedAt,
      exitReason: position.exitReason || "closed",
      accountingSource: position.pnlAccountingSource || (runtimeMode === "live" ? "exchange_settlement" : "simulation_model"),
    })
    if (rows.length > historyWindow) rows.splice(0, rows.length - historyWindow)
    nextPerformance.set(key, rows)
    position.configPerformanceRecorded = true
  }
  configPerformance = nextPerformance
  configStatus = new Map()
  for (const [key, rows] of configPerformance) {
    const status = evaluateConfigPerformance(key)
    if (rows.length > 0 || status.permanentlyDeactivated || !status.enabled) {
      configStatus.set(key, { ...status, updatedAt: rows.at(-1)?.closedAt || null })
    }
  }
}

function momentumReversalRuntime(pos, currentPrice) {
  const activation = Math.max(0.1, Math.min((Number(pos.takeprofit) || 0.1) * 0.25, 0.75))
  const previous = Number(pos.lastObservedPrice) || pos.entryPrice
  return pos.direction === "long"
    ? pos.highWatermark >= pos.entryPrice * (1 + activation / 100) && currentPrice < previous
    : pos.lowWatermark <= pos.entryPrice * (1 - activation / 100) && currentPrice > previous
}

async function checkAndClosePositions() {
  const openPos = positions.filter((p) => p.status === "open")
  if (openPos.length === 0) return
  let liveCloseActions = 0

  // Batch fetch current prices
  const symbols = [...new Set(openPos.map((p) => p.symbol))]
  const prices = {}

  // Public ticker reads can run concurrently; the shared token bucket keeps
  // the venue request rate bounded while avoiding a 32-symbol serial delay.
  await Promise.all(symbols.map(async (symbol) => {
    try {
      prices[symbol] = await readDirectTradeTicker(symbol)
    } catch (err) {
      if (String(err).includes("429")) rateLimiter.backoff(2000)
      log("warn", `Ticker read blocked for ${symbol}`, err?.message || err)
    }
  }))

  for (const pos of openPos) {
    const currentPrice = prices[pos.symbol]
    if (pos.closeControlId || String(pos.closeState || "").startsWith("closing")) {
      if (pos.mode === "live" && liveCloseActions >= DIRECT_TRADE_MAX_LIVE_CLOSE_ACTIONS_PER_CYCLE) continue
      if (pos.mode === "live") liveCloseActions++
      await closePosition(
        pos,
        Number(pos.closeRequestedPrice) || Number(currentPrice) || Number(pos.lastObservedPrice),
        pos.closeReason || "exchange_reconciliation",
      )
      continue
    }
    // The authoritative position size is unknown while an accumulation order
    // is active. Reconcile that stable control before issuing a reduce-only
    // close, otherwise the close quantity could leave an unprotected fill or
    // flip the venue position.
    if (pos.blockPendingControlId || pos.dcaPendingControlId) continue
    if (!currentPrice || !pos.entryPrice) continue

    // A hard DCA stop always has priority over an accumulation fill. When the
    // processor is stopped, existing positions are still closed/protected but
    // no new DCA exposure is added.
    if (pos.strategyType === "dca") {
      const hardStopHit = pos.direction === "long"
        ? currentPrice <= pos.currentSlPrice
        : currentPrice >= pos.currentSlPrice
      if (hardStopHit) {
        await closePosition(pos, currentPrice, "sl")
        continue
      }
      await addDirectTradeDcaLeg(pos, currentPrice)
    }

    let shouldClose = false
    let exitReason = ""

    if (pos.direction === "long") {
      // Update high watermark
      if (currentPrice > pos.highWatermark) {
        pos.highWatermark = currentPrice
        // Trailing stop update
        const trailingParameters = pos.trailingMode === "auto"
          ? autoTrailingRuntimeParameters(pos)
          : { trailStart: pos.trailStart || 0.5, trailStop: pos.trailStop || 0.3 }
        if (pos.trailing && pos.highWatermark > pos.entryPrice * (1 + trailingParameters.trailStart / 100)) {
          const newSl = pos.highWatermark * (1 - trailingParameters.trailStop / 100)
          if (newSl > pos.currentSlPrice) pos.currentSlPrice = newSl
          pos.trailingArmed = true
        }
      }

      // TP check
      const tpPrice = pos.strategyType === "dca" && Number(pos.dcaTakeProfitPrice) > 0
        ? Number(pos.dcaTakeProfitPrice)
        : pos.entryPrice * (1 + pos.takeprofit / 100)
      if (currentPrice >= tpPrice) { shouldClose = true; exitReason = "tp" }
      // SL check
      if (currentPrice <= pos.currentSlPrice) { shouldClose = true; exitReason = pos.trailing && pos.trailingArmed ? "trailing" : "sl" }
    } else {
      // Short
      if (currentPrice < pos.lowWatermark || pos.lowWatermark === Infinity) {
        pos.lowWatermark = currentPrice
        const trailingParameters = pos.trailingMode === "auto"
          ? autoTrailingRuntimeParameters(pos)
          : { trailStart: pos.trailStart || 0.5, trailStop: pos.trailStop || 0.3 }
        if (pos.trailing && pos.lowWatermark < pos.entryPrice * (1 - trailingParameters.trailStart / 100)) {
          const newSl = pos.lowWatermark * (1 + trailingParameters.trailStop / 100)
          if (newSl < pos.currentSlPrice) pos.currentSlPrice = newSl
          pos.trailingArmed = true
        }
      }

      const tpPrice = pos.strategyType === "dca" && Number(pos.dcaTakeProfitPrice) > 0
        ? Number(pos.dcaTakeProfitPrice)
        : pos.entryPrice * (1 - pos.takeprofit / 100)
      if (currentPrice <= tpPrice) { shouldClose = true; exitReason = "tp" }
      if (currentPrice >= pos.currentSlPrice) { shouldClose = true; exitReason = pos.trailing && pos.trailingArmed ? "trailing" : "sl" }
    }

    // Exit tactics use only causal tick data and the position's own retained
    // watermarks. They do not borrow a different config's history or the
    // hindsight-only best-market-exit metric.
    const exitTactic = pos.exitTactic || "bracket"
    if (!shouldClose && exitTactic === "momentum_reversal" && momentumReversalRuntime(pos, currentPrice)) {
      shouldClose = true
      exitReason = "momentum_reversal"
    }
    if (!shouldClose && exitTactic === "relative" && relativeExitRuntime(pos, currentPrice)) {
      shouldClose = true
      exitReason = "relative_reversal"
    }
    if (!shouldClose && exitTactic === "time") {
      const openedAt = new Date(pos.openedAt).getTime()
      const maxHoldMs = Math.max(1, Number(pos.maxHoldMinutes) || Number(state.maxHoldMinutes) || 1) * 60_000
      if (Number.isFinite(openedAt) && Date.now() - openedAt >= maxHoldMs) {
        shouldClose = true
        exitReason = "timeout"
      }
    }
    pos.lastObservedPrice = currentPrice

    // Drawdown time tracking
    const pnlPercent = pos.direction === "long"
      ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100
    if (pnlPercent < 0) {
      pos.drawdownStartedAt ||= Date.now()
      const currentDrawdownTimeMin = (Date.now() - pos.drawdownStartedAt) / 60_000
      pos.drawdownTimeMin = Math.max(Number(pos.drawdownTimeMin) || 0, currentDrawdownTimeMin)
    } else {
      pos.drawdownStartedAt = 0
    }

    if (shouldClose) {
      if (pos.mode === "live" && liveCloseActions >= DIRECT_TRADE_MAX_LIVE_CLOSE_ACTIONS_PER_CYCLE) continue
      if (pos.mode === "live") liveCloseActions++
      await closePosition(pos, currentPrice, exitReason)
    }
  }
}

async function closePosition(pos, exitPrice, reason) {
  if (Date.now() < Number(pos.closeRetryAfter || 0)) return false
  let realizedExitPrice = Number(exitPrice)
  let realizedQuantity = Math.abs(Number(pos.quantity) || 0)
  let finalSettlement = null

  // A live close is authoritative only after the exchange accepts it. Keep
  // the local row open on failure so the next leased tick retries instead of
  // reporting a phantom close and dropping protection.
  if (pos.mode === "live") {
    try {
      const closeRecheckMs = pos.closeState === "closing_settlement_pending" ? 5_000 : 1_000
      if (pos.closeControlId && Date.now() - Date.parse(pos.closeLastCheckedAt || "") < closeRecheckMs) return false
      const generation = Math.max(0, Math.floor(Number(pos.closeGeneration) || 0))
      if (!pos.closeControlId) {
        pos.closeControlId = normalizeDirectTradeControlId(`dtclose_${pos.id}_${generation}`)
        pos.closeRequestedQuantity = realizedQuantity
        pos.closeRequestedPrice = realizedExitPrice
        pos.closeReason = reason
        pos.closeSubmittedAt = null
        pos.closeState = "closing_prepared"
        stateDirty = true
        // Save the exact close generation before the venue request. A crash
        // cannot replace it with a new client id and double-reduce the book.
        if (!(await persistState())) return false
      }
      const activeControlId = pos.closeControlId
      pos.closeRequestedQuantity = Number(pos.closeRequestedQuantity) > 0
        ? Number(pos.closeRequestedQuantity)
        : realizedQuantity
      pos.closeRequestedPrice = Number(pos.closeRequestedPrice) > 0
        ? Number(pos.closeRequestedPrice)
        : realizedExitPrice
      await rateLimiter.acquire()
      const wasSubmitted = Boolean(pos.closeSubmittedAt)
      pos.closeSubmittedAt = pos.closeSubmittedAt || new Date().toISOString()
      pos.closeState = "closing_submitted"
      const closeResult = await apiCall("/api/trade-engine/direct-trade/order", "POST", {
        kind: "close",
        instanceId: processorInstanceId,
        positionId: pos.id,
        controlId: activeControlId,
        connectionId: pos.connectionId || state.connectionId,
        symbol: pos.symbol,
        positionDirection: pos.direction,
        quantity: pos.closeRequestedQuantity,
        price: pos.closeRequestedPrice,
        leverage: 10,
        reconcileOnly: wasSubmitted,
      }, DIRECT_TRADE_CONTROL_REQUEST_TIMEOUT_MS)
      pos.closeControlState = closeResult?.controlState || pos.closeControlState
      pos.closeOrderId = closeResult?.orderId && closeResult.orderId !== "N/A"
        ? closeResult.orderId
        : pos.closeOrderId || null
      pos.closeLastCheckedAt = new Date().toISOString()
      if (!closeResult?.success) {
        if (closeResult?.controlState === "failed") {
          pos.closeGeneration = generation + 1
          pos.closeControlId = null
          pos.closeSubmittedAt = null
          pos.closeState = "closing_retry"
          pos.closeRetryAfter = Date.now() + 1_000
          pos.closeLastError = String(closeResult?.error || "Exchange rejected close").slice(0, 300)
          stateDirty = true
          await persistState()
        }
        log("warn", `Close order rejected for ${pos.symbol}`, closeResult?.error)
        return false
      }
      if (closeResult?.alreadyClosed === true) {
        // The venue is flat, so retrying another reduce-only generation can
        // only create rate-limit pressure. Close the local ownership row while
        // keeping exchange PnL explicitly pending; absence is not a fill and
        // must never manufacture an exit price or settlement.
        pos.orphanedCloseControlId = activeControlId
        pos.status = "closed"
        pos.closeState = "closed_accounting_pending"
        pos.closeControlState = "venue_position_absent"
        pos.closeControlId = null
        pos.lastAppliedCloseControlId = null
        pos.closeSubmittedAt = null
        pos.closeRetryAfter = 0
        pos.closeSettlementWaitStartedAt = 0
        pos.closeAccountingComplete = false
        pos.pnlAccountingComplete = false
        pos.pnlAccountingSource = "exchange_position_absent_pending"
        pos.closeAccountingLastError = "Exchange position absent; settlement must be reconciled without inferring PnL"
        pos.closedAt = new Date().toISOString()
        pos.exitReason = "exchange_position_absent"
        pos.remainingQuantity = 0
        stateDirty = true
        rebuildRealizedNotionalStats()
        await persistState()
        log("warn", `Closed local ${pos.direction} ${pos.symbol} ownership because the exchange position is already absent; PnL remains accounting-pending`)
        return true
      }
      if (!isTerminalControlOrderResult(closeResult, Number(pos.closeRequestedQuantity))) {
        pos.closeState = "closing_pending_reconciliation"
        stateDirty = true
        await persistState()
        return false
      }
      finalSettlement = closeResult?.settlement || null
      if (!finalSettlement) {
        pos.closeSettlementWaitStartedAt = Number(pos.closeSettlementWaitStartedAt) || Date.now()
        // A terminal fill without its exact venue PnL/fee settlement is not an
        // accounting result. Keep replaying this durable control on a bounded
        // cadence; other positions continue processing and no order can be
        // resubmitted under the same control id.
        pos.closeState = "closing_settlement_pending"
        stateDirty = true
        await persistState()
        return false
      } else {
        pos.closeSettlementWaitStartedAt = 0
      }
      const exchangePrice = Number(closeResult.fill?.filledPrice || closeResult.details?.avgPrice || closeResult.avgPrice)
      const exchangeQuantity = Number(closeResult.fill?.filledQty || closeResult.details?.filledQty)
      // A successful live close must carry an exchange-confirmed execution
      // price. Never book a ticker estimate as realised PnL. Quantity is
      // likewise replaced only when the exchange reports a positive fill.
      if (!Number.isFinite(exchangePrice) || exchangePrice <= 0
        || !Number.isFinite(exchangeQuantity) || exchangeQuantity <= 0) {
        // A terminal cancel/reject with no fill is safe to replace with the
        // next generation. An active/ambiguous order never reaches this path.
        pos.closeGeneration = generation + 1
        pos.closeControlId = null
        pos.closeSubmittedAt = null
        pos.closeState = "closing_retry"
        pos.closeRetryAfter = Date.now() + 1_000
        pos.closeLastError = `Terminal ${normalizedControlOrderStatus(closeResult) || "exchange"} response had no fill`
        stateDirty = true
        await persistState()
        log("warn", `Close response for ${pos.symbol} had no authoritative fill price/quantity`)
        return false
      }
      realizedExitPrice = exchangePrice
      if (exchangeQuantity < realizedQuantity * 0.999999) {
        const currentLegs = Array.isArray(pos.positionLegs) && pos.positionLegs.length > 0
          ? pos.positionLegs
          : Array.isArray(pos.blockLegs) && pos.blockLegs.length > 0
            ? pos.blockLegs
          : [{ entryPrice: pos.entryPrice, quantity: pos.quantity }]
        const currentQuantity = currentLegs.reduce((sum, leg) => sum + Math.abs(Number(leg?.quantity) || 0), 0)
        const filledQuantity = Math.min(exchangeQuantity, currentQuantity)
        if (!(currentQuantity > 0) || !(filledQuantity > 0)) return false
        const closeFraction = Math.min(1, filledQuantity / currentQuantity)
        let partialEntryNotionalUsdt = 0
        let partialGrossPnlUsdt = 0
        const remainingLegs = []
        for (const leg of currentLegs) {
          const entryPrice = Number(leg?.entryPrice) || 0
          const quantity = Math.abs(Number(leg?.quantity) || 0)
          const closedQuantity = quantity * closeFraction
          const remainingQuantity = quantity - closedQuantity
          if (entryPrice > 0 && closedQuantity > 0) {
            partialEntryNotionalUsdt += entryPrice * closedQuantity
            partialGrossPnlUsdt += (pos.direction === "long"
              ? realizedExitPrice - entryPrice
              : entryPrice - realizedExitPrice) * closedQuantity
          }
          if (remainingQuantity > Math.max(1e-12, quantity * 1e-9)) {
            remainingLegs.push({ ...leg, quantity: remainingQuantity })
          }
        }
        pos.positionLegs = remainingLegs
        pos.blockLegs = [...remainingLegs]
        pos.quantity = Math.max(0, currentQuantity - filledQuantity)
        pos.partialCloseQuantity = (Number(pos.partialCloseQuantity) || 0) + filledQuantity
        pos.partialEntryNotionalUsdt = (Number(pos.partialEntryNotionalUsdt) || 0) + partialEntryNotionalUsdt
        pos.partialGrossPnlUsdt = (Number(pos.partialGrossPnlUsdt) || 0) + partialGrossPnlUsdt
        const remainingKnownEntryFee = Math.max(
          0,
          (Number(pos.entryTradingFeeUsdt) || 0) - (Number(pos.entryTradingFeeAllocatedUsdt) || 0),
        )
        const entryFeeAllocation = remainingKnownEntryFee * closeFraction
        const settlementNet = Number(finalSettlement?.netRealizedPnl)
        const partialRealizedPnlUsdt = Number.isFinite(settlementNet)
          ? settlementNet - (finalSettlement?.netIncludesEntryFee ? 0 : entryFeeAllocation)
          : partialGrossPnlUsdt - entryFeeAllocation
        const partialTradingFeeUsdt = Math.max(0, Number(finalSettlement?.tradingFee) || 0)
          + (finalSettlement?.netIncludesEntryFee ? 0 : entryFeeAllocation)
        const hadPriorPartial = Number(pos.partialCloseCount || 0) > 0
        pos.partialCloseCount = Number(pos.partialCloseCount || 0) + 1
        pos.partialRealizedPnlUsdt = Number(((Number(pos.partialRealizedPnlUsdt) || 0) + partialRealizedPnlUsdt).toFixed(12))
        pos.partialTradingFeeUsdt = Number(((Number(pos.partialTradingFeeUsdt) || 0) + partialTradingFeeUsdt).toFixed(12))
        pos.entryTradingFeeAllocatedUsdt = Number(((Number(pos.entryTradingFeeAllocatedUsdt) || 0) + entryFeeAllocation).toFixed(12))
        pos.closeAccountingComplete = (hadPriorPartial ? pos.closeAccountingComplete !== false : true)
          && Boolean(finalSettlement)
          && Boolean(finalSettlement?.netIncludesEntryFee || pos.entryAccountingComplete)
        pos.pnlAccountingSource = pos.closeAccountingComplete
          ? "exchange_settlement"
          : "exchange_fills_incomplete_fees"
        pos.lastPartialClosePrice = realizedExitPrice
        pos.lastPartialCloseAt = new Date().toISOString()
        pos.closeState = "closing_partial"
        pos.lastAppliedCloseControlId = activeControlId
        pos.closeGeneration = generation + 1
        pos.closeControlId = null
        pos.closeSubmittedAt = null
        pos.closeRequestedQuantity = pos.quantity
        pos.closeRequestedPrice = realizedExitPrice
        pos.closeRetryAfter = 0
        pos.blockRealizedVolumeMultiplier = Number(pos.blockBaseQuantity) > 0
          ? Number((pos.quantity / Number(pos.blockBaseQuantity)).toFixed(6))
          : 1
        pos.dcaRealizedVolumeMultiplier = Number(pos.initialQuantity) > 0
          ? Number((pos.quantity / Number(pos.initialQuantity)).toFixed(6))
          : 1
        stateDirty = true
        await persistState()
        log("warn", `Partial close ${pos.mode} ${pos.direction} ${pos.symbol}: ${filledQuantity.toFixed(12)} filled, ${pos.quantity.toFixed(12)} remaining`)
        return false
      }
      pos.lastAppliedCloseControlId = activeControlId
      realizedQuantity = Math.min(exchangeQuantity, realizedQuantity)
    } catch (err) {
      pos.closeState = "closing_pending_reconciliation"
      pos.closeLastError = String(err.message || err).slice(0, 300)
      pos.closeLastCheckedAt = new Date().toISOString()
      stateDirty = true
      log("error", `Close order reconciliation deferred for ${pos.symbol}`, err.message)
      trackError()
      return false
    }
  }

  const positionLegs = Array.isArray(pos.positionLegs) && pos.positionLegs.length > 0
    ? pos.positionLegs
    : Array.isArray(pos.blockLegs) && pos.blockLegs.length > 0
      ? pos.blockLegs
    : [{ entryPrice: pos.entryPrice, quantity: pos.quantity }]
  const entryNotionalUsdt = positionLegs.reduce(
    (sum, leg) => sum + Math.abs(Number(leg?.entryPrice) || 0) * Math.abs(Number(leg?.quantity) || 0),
    0,
  )
  const grossPnlUsdtFromLegs = positionLegs.reduce((sum, leg) => {
    const entryPrice = Number(leg?.entryPrice) || 0
    const quantity = Math.abs(Number(leg?.quantity) || 0)
    if (!(entryPrice > 0) || !(quantity > 0)) return sum
    const priceMove = pos.direction === "long"
      ? realizedExitPrice - entryPrice
      : entryPrice - realizedExitPrice
    return sum + priceMove * quantity
  }, 0)
  const totalEntryNotionalUsdt = (Number(pos.partialEntryNotionalUsdt) || 0) + entryNotionalUsdt
  const totalGrossPnlUsdt = (Number(pos.partialGrossPnlUsdt) || 0) + grossPnlUsdtFromLegs
  const baseEntryNotionalUsdt = Number(pos.baseEntryNotionalUsdt) > 0
    ? Number(pos.baseEntryNotionalUsdt)
    : totalEntryNotionalUsdt
  const totalPositionVolumeMultiplier = baseEntryNotionalUsdt > 0
    ? totalEntryNotionalUsdt / baseEntryNotionalUsdt
    : 1
  const grossPnl = baseEntryNotionalUsdt > 0
    ? (totalGrossPnlUsdt / baseEntryNotionalUsdt) * 100
    : pos.direction === "long"
      ? ((realizedExitPrice - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - realizedExitPrice) / pos.entryPrice) * 100
  // The configured PositionCost is charged against every realised leg's
  // notional. This keeps staged Block PnL/PF on the same ratio basis as the
  // historical simulation instead of charging one cost to a multi-leg book.
  const positionCostPercent = Math.max(0.02, Math.min(1, Number(pos.positionCostPercent) || Number(state.positionCostPercent) || 0.1))
  const positionCostUsdt = pos.mode === "simulated"
    ? totalEntryNotionalUsdt * (positionCostPercent / 100)
    : 0
  const remainingKnownEntryFee = Math.max(
    0,
    (Number(pos.entryTradingFeeUsdt) || 0) - (Number(pos.entryTradingFeeAllocatedUsdt) || 0),
  )
  const finalSettlementNet = Number(finalSettlement?.netRealizedPnl)
  const finalRealizedPnlUsdt = pos.mode === "live"
    ? Number.isFinite(finalSettlementNet)
      ? finalSettlementNet - (finalSettlement?.netIncludesEntryFee ? 0 : remainingKnownEntryFee)
      : grossPnlUsdtFromLegs - remainingKnownEntryFee
    : grossPnlUsdtFromLegs - positionCostUsdt
  const realizedPnlUsdt = pos.mode === "live"
    ? (Number(pos.partialRealizedPnlUsdt) || 0) + finalRealizedPnlUsdt
    : totalGrossPnlUsdt - positionCostUsdt
  const pnl = baseEntryNotionalUsdt > 0
    ? (realizedPnlUsdt / baseEntryNotionalUsdt) * 100
    : pos.mode === "live" ? grossPnl : grossPnl - positionCostPercent

  pos.status = "closed"
  pos.closeState = "closed"
  pos.closeControlId = null
  pos.closeSubmittedAt = null
  pos.closeControlState = "completed"
  pos.closeRetryAfter = 0
  pos.exitPrice = realizedExitPrice
  pos.quantity = (Number(pos.partialCloseQuantity) || 0) + realizedQuantity
  pos.remainingQuantity = 0
  pos.closedAt = new Date().toISOString()
  pos.exitReason = reason
  pos.grossPnl = Number(grossPnl.toFixed(4))
  pos.positionCostPercent = positionCostPercent
  pos.pnl = Number(pnl.toFixed(4))
  pos.entryNotionalUsdt = Number(totalEntryNotionalUsdt.toFixed(8))
  pos.grossPnlUsdt = Number(totalGrossPnlUsdt.toFixed(8))
  pos.realizedPnlUsdt = Number(realizedPnlUsdt.toFixed(8))
  if (pos.mode === "live") {
    pos.closeSettlement = finalSettlement
    const finalTradingFeeUsdt = Math.max(0, Number(finalSettlement?.tradingFee) || 0)
      + (finalSettlement?.netIncludesEntryFee ? 0 : remainingKnownEntryFee)
    pos.entryTradingFeeAllocatedBeforeFinalUsdt = Number((Number(pos.entryTradingFeeAllocatedUsdt) || 0).toFixed(12))
    pos.entryTradingFeeAllocatedUsdt = Number((Number(pos.entryTradingFeeUsdt) || 0).toFixed(12))
    pos.tradingFeeUsdt = Number(((Number(pos.partialTradingFeeUsdt) || 0) + finalTradingFeeUsdt).toFixed(12))
    const previousCloseAccountingComplete = Number(pos.partialCloseCount || 0) > 0
      ? pos.closeAccountingComplete !== false
      : true
    pos.closeAccountingComplete = previousCloseAccountingComplete
      && Boolean(finalSettlement)
      && Boolean(finalSettlement?.netIncludesEntryFee || pos.entryAccountingComplete)
    pos.pnlAccountingComplete = pos.closeAccountingComplete
    pos.pnlAccountingSource = pos.pnlAccountingComplete
      ? "exchange_settlement"
      : "exchange_fills_incomplete_fees"
    pos.closeSettlementSource = finalSettlement?.source || null
  } else {
    pos.pnlAccountingComplete = true
    pos.pnlAccountingSource = "simulation_model"
  }
  pos.blockRealizedVolumeMultiplier = Number(pos.blockBaseQuantity) > 0
    ? Number(totalPositionVolumeMultiplier.toFixed(6))
    : 1
  pos.dcaRealizedVolumeMultiplier = Number(pos.initialQuantity) > 0
    ? Number(totalPositionVolumeMultiplier.toFixed(6))
    : 1

  rebuildRealizedNotionalStats()
  const recordedOutcome = recordAccountedConfigOutcome(pos, reason)
  stateDirty = true
  if (pos.mode === "live" && !recordedOutcome) {
    log("warn", `Closed live ${pos.direction} ${pos.symbol} @ ${realizedExitPrice.toFixed(4)}; exchange PnL accounting remains pending for ${pos.lastAppliedCloseControlId || "unknown control"}`)
  } else {
    log("info", `Closed ${pos.mode} ${pos.direction} ${pos.symbol} @ ${realizedExitPrice.toFixed(4)} | PnL: ${pos.pnl > 0 ? "+" : ""}${pos.pnl.toFixed(3)}% (${pos.realizedPnlUsdt.toFixed(4)} USDT) | Reason: ${reason} | Accounted total PnL: ${stats.totalPnl.toFixed(3)}%`)
  }
  return true
}

// ─── Error Tracking ───────────────────────────────────────────────────────────

function trackError() {
  const now = Date.now()
  errorTimestamps.push(now)
  errorTimestamps = errorTimestamps.filter((t) => now - t < 5 * 60 * 1000)
  errorsLast5min = errorTimestamps.length
}

// ─── State Persistence ────────────────────────────────────────────────────────

async function persistState() {
  try {
    const result = await apiCall("/api/trade-engine/direct-trade", "POST", {
      action: "processor-sync",
      instanceId: processorInstanceId,
      tickCount,
      errorsLast5min,
      lastRecalcAt,
      configCount: executionConfigs.length,
      historyPolicy: lastHistoryPolicy,
      lifecycleCycleCount,
      lastProgressAt: lastProgressAt > 0 ? new Date(lastProgressAt).toISOString() : null,
      positions,
      stats,
      configStatus: Object.fromEntries(configStatus),
      configPerformance: Object.fromEntries(configPerformance),
    })
    processorLeaseHeld = result?.leaseHeld === true
    lastProcessorSyncAt = Date.now()
    lastPersistAt = lastProcessorSyncAt
    if (result?.state && typeof result.state === "object") applyRemoteState(result.state, "sync")
    stateDirty = false
    return processorLeaseHeld
  } catch (err) {
    processorLeaseHeld = false
    trackError()
    return false
  }
}

async function ensureProcessorLease() {
  if (processorLeaseHeld && Date.now() - lastProcessorSyncAt < 2_000) return true
  return persistState()
}

async function processorHeartbeatLoop() {
  while (true) {
    await sleep(DIRECT_TRADE_PROCESSOR_HEARTBEAT_INTERVAL_MS)
    const hasManagedPositions = positions.some((position) => (
      position.status === "open" || position.status === "opening"
      || (position.mode === "live" && position.status === "closed" && position.pnlAccountingComplete !== true)
    ))
    if (!processorLeaseHeld || (!state.enabled && !hasManagedPositions)) continue
    try {
      const result = await apiCall("/api/trade-engine/direct-trade", "POST", {
        action: "processor-heartbeat",
        instanceId: processorInstanceId,
        tickCount,
        errorsLast5min,
        lifecycleCycleCount,
        lastProgressAt: lastProgressAt > 0 ? new Date(lastProgressAt).toISOString() : null,
      }, 2_500)
      if (result?.leaseHeld === false) processorLeaseHeld = false
    } catch (error) {
      // A missed HTTP acknowledgement does not prove loss of ownership. The
      // next heartbeat or full snapshot performs the exact Redis-owner check.
      if (Date.now() - lastHeartbeatWarningAt >= 10_000) {
        lastHeartbeatWarningAt = Date.now()
        log("warn", "Processor heartbeat deferred", error?.message || error)
      }
    }
  }
}

function applyRemoteState(nextState, source = "load") {
  if (!nextState || typeof nextState !== "object") return false
  const prev = { ...state }
  state = {
    ...state,
    ...nextState,
    minVolFactor: normalizeDirectTradeVolumeFactor(
      nextState.minVolFactor ?? nextState.volumeFactor ?? state.minVolFactor,
      state.minVolFactor,
    ),
    trailingMinTakeProfitRatio: normalizeDirectTradeTrailingMinTakeProfitRatio(
      nextState.trailingMinTakeProfitRatio ?? nextState.trailingMinStep ?? state.trailingMinTakeProfitRatio,
    ),
    enabledIndicationTypes: normalizeEnabledIndicationTypes(
      nextState.enabledIndicationTypes,
      state.enabledIndicationTypes,
    ),
    dcaProfile: normalizeDirectDcaProfile(nextState.dcaProfile || state.dcaProfile),
  }
  const persistedRecalcAt = Date.parse(nextState.lastRecalcAt || "")
  if (Number.isFinite(persistedRecalcAt) && persistedRecalcAt > 0) {
    lastRecalcAt = persistedRecalcAt
  }
  if (state.liveMode !== prev.liveMode) {
    // Changing execution mode is a hard lifecycle boundary. Force a new
    // baseline calculation (plus a bounded sufficiency expansion if needed)
    // and a new causal pulse before any entry can be considered.
    resetAdaptiveHistory(state.liveMode ? "entered live mode" : "returned to paper mode")
    lastRecalcAt = 0
    calculationHistoryHours = null
    lastSignalPulseAt = 0
    log(
      "info",
      state.liveMode
        ? `Live mode requested; ${DIRECT_TRADE_LIVE_HISTORY_HOURS}h baseline historic warmup required before realtime processing`
        : `Paper mode requested; configured historic warmup required before realtime processing`,
    )
    rebuildAccountedConfigPerformance()
  }
  // A persisted acknowledgement is an event from the state owner. Compare
  // only calculation inputs: UI-only status updates never cause a rebuild.
  const evaluationInputsChanged = JSON.stringify({
    minVolFactor: normalizeDirectTradeVolumeFactor(prev.minVolFactor),
    positionCostPercent: prev.positionCostPercent,
    keepEnabledPosCount: prev.keepEnabledPosCount,
    minProfitFactor: prev.minProfitFactor,
    minRecentProfitFactor: prev.minRecentProfitFactor,
    recentEvaluationPositions: prev.recentEvaluationPositions,
    maxDrawdownTimeMin: prev.maxDrawdownTimeMin,
    timeframes: prev.timeframes,
    historyHours: prev.historyHours,
    entryTactics: prev.entryTactics,
    exitTactics: prev.exitTactics,
    entryTiming: prev.entryTiming,
    activityVolumeRatio: prev.activityVolumeRatio,
    maxHoldMinutes: prev.maxHoldMinutes,
    takeProfitRatioRange: prev.takeProfitRatioRange,
    takeProfitRatioStep: prev.takeProfitRatioStep,
    trailingMinTakeProfitRatio: normalizeDirectTradeTrailingMinTakeProfitRatio(prev.trailingMinTakeProfitRatio),
    blockVolumeRatio: prev.blockVolumeRatio,
    blockProfitFactorRatio: prev.blockProfitFactorRatio,
    maxSlRatio: prev.maxSlRatio,
    slRatioStep: prev.slRatioStep,
    inverseMaxSlRatio: prev.inverseMaxSlRatio,
    strategyTypes: prev.strategyTypes,
    deactivatePosCount: prev.deactivatePosCount,
    trailingEnabled: prev.trailingEnabled,
    dcaProfile: normalizeDirectDcaProfile(prev.dcaProfile),
  }) !== JSON.stringify({
    minVolFactor: normalizeDirectTradeVolumeFactor(state.minVolFactor),
    positionCostPercent: state.positionCostPercent,
    keepEnabledPosCount: state.keepEnabledPosCount,
    minProfitFactor: state.minProfitFactor,
    minRecentProfitFactor: state.minRecentProfitFactor,
    recentEvaluationPositions: state.recentEvaluationPositions,
    maxDrawdownTimeMin: state.maxDrawdownTimeMin,
    timeframes: state.timeframes,
    historyHours: state.historyHours,
    entryTactics: state.entryTactics,
    exitTactics: state.exitTactics,
    entryTiming: state.entryTiming,
    activityVolumeRatio: state.activityVolumeRatio,
    maxHoldMinutes: state.maxHoldMinutes,
    takeProfitRatioRange: state.takeProfitRatioRange,
    takeProfitRatioStep: state.takeProfitRatioStep,
    trailingMinTakeProfitRatio: normalizeDirectTradeTrailingMinTakeProfitRatio(state.trailingMinTakeProfitRatio),
    blockVolumeRatio: state.blockVolumeRatio,
    blockProfitFactorRatio: state.blockProfitFactorRatio,
    maxSlRatio: state.maxSlRatio,
    slRatioStep: state.slRatioStep,
    inverseMaxSlRatio: state.inverseMaxSlRatio,
    strategyTypes: state.strategyTypes,
    deactivatePosCount: state.deactivatePosCount,
    trailingEnabled: state.trailingEnabled,
    dcaProfile: normalizeDirectDcaProfile(state.dcaProfile),
  })
  if (evaluationInputsChanged) {
    log("info", `Config change detected by ${source}: volFactor=${normalizeDirectTradeVolumeFactor(state.minVolFactor)}, tp=${state.takeProfitRatioRange.join("-")}×cost step=${state.takeProfitRatioStep}, blockRatio=${state.blockVolumeRatio}, minPF=${state.minProfitFactor}`)
    // Settings are authoritative immediately. Rebuild the entire historic
    // grid on the next owned tick instead of trading stale configurations.
    resetAdaptiveHistory(`calculation inputs changed by ${source}`)
    lastRecalcAt = 0
  }
  return evaluationInputsChanged
}

async function loadState(includeExecution = false) {
  try {
    const result = await apiCall(`/api/trade-engine/direct-trade${includeExecution ? "?includeExecution=1" : ""}`)
    lastStateRefreshAt = Date.now()
    if (result?.state) {
      applyRemoteState(result.state, "load")
    }
    const remoteExchange = String(result?.exchange || "").trim().toLowerCase()
    if (remoteExchange === "bingx" || remoteExchange === "bybit") {
      connectionExchange = remoteExchange
    } else if (PROCESS_CONNECTION_ID) {
      throw new Error(`Selected Direct-Trade connection has unsupported exchange ${remoteExchange || "unknown"}`)
    }
    const remoteCalculationVersion = result?.calculation?.calculatedAt || null
    const remoteCalculationHistoryHours = Number(result?.calculation?.historyHours)
    calculationHistoryHours = Number.isFinite(remoteCalculationHistoryHours) && remoteCalculationHistoryHours > 0
      ? remoteCalculationHistoryHours
      : null
    if (calculationHistoryHours && result?.calculation) {
      const remotePolicy = assessCalculationHistory(result.calculation, calculationHistoryHours)
      lastHistoryPolicy = remotePolicy
      adaptiveHistoryHours = remotePolicy.canProceed
        ? calculationHistoryHours
        : remotePolicy.nextHistoryHours
    }
    if (!includeExecution && remoteCalculationVersion && remoteCalculationVersion !== calculationVersion) {
      calculationVersion = remoteCalculationVersion
      await refreshActiveSignals()
      return
    }
    if (Array.isArray(result?.executionConfigs)) {
      configs = result.executionConfigs.map(normalizeDirectTradeConfig)
      executionConfigs = configs.filter((config) => config?.valid !== false)
      indexExecutionConfigs()
      refreshActiveExecutionConfigs()
    }
    if (result?.stats && typeof result.stats === "object") stats = { ...stats, ...result.stats }
    if (Array.isArray(result?.positions)) positions = result.positions.map(normalizeLoadedDirectTradePosition)
    rebuildRealizedNotionalStats()
    if (result?.configPerformance && typeof result.configPerformance === "object") {
      configPerformance = new Map(Object.entries(result.configPerformance))
    }
    if (result?.configStatus && typeof result.configStatus === "object") {
      configStatus = new Map(Object.entries(result.configStatus))
    }
    // Persisted feedback predating exchange settlement completion may contain
    // provisional rows. Reconstruct the bounded current-mode window solely
    // from durable, accounted position outcomes on every recovery.
    rebuildAccountedConfigPerformance()
    if (remoteCalculationVersion) calculationVersion = remoteCalculationVersion
    log("info", `State loaded: enabled=${state.enabled}, live=${state.liveMode}, evaluated=${Number(result?.configTotal || 0)}, executable=${executionConfigs.length}, keepEnabledN=${state.keepEnabledPosCount}`)
  } catch (err) {
    log("warn", "Could not load state from server, using defaults", err.message)
  }
}

// ─── Entry Signal Check (simplified for processor) ────────────────────────────

function shouldEnterNow(config) {
  if (config?.valid === false) return false
  // Live permissions never shrink the internal historic calculation matrix.
  // An empty list is a valid safety state: keep calculating every selected
  // indication type while emitting no new exchange entry.
  if (
    state.liveMode
    && !normalizeEnabledIndicationTypes(state.enabledIndicationTypes, []).includes(config?.entryTactic)
  ) return false
  // Historical PF/DDT makes a variant eligible; the one-minute pulse supplies
  // the fresh causal market signal. A stale historical winner can never open
  // an order after the pulse window has expired.
  if (typeof config?.entrySignalKey !== "string" || !activeSignalKeys.has(config.entrySignalKey)) return false
  if (Date.now() - lastSignalPulseAt > 90_000) return false
  // Use the pre-calculated configs as entry signals.
  // The calculation already validated its operator-selected historic range;
  // the current pulse above is still required before an order may be opened.
  // Here we just check timing and position limits
  if (!canOpenPosition(config)) return false

  if (!state.trailingEnabled && config.trailing) return false
  // A stale pre-change execution slice must not bypass the newly persisted
  // trailing-distance floor. Existing positions are deliberately unaffected:
  // this gate controls only creation of a new entry.
  if (config.trailing) {
    const takeProfitPositionCostRatio = Number(config.takeProfitPositionCostRatio)
    if (
      !Number.isFinite(takeProfitPositionCostRatio)
      || takeProfitPositionCostRatio < normalizeDirectTradeTrailingMinTakeProfitRatio(state.trailingMinTakeProfitRatio)
    ) return false
  }

  const candidateKey = configKey(config)
  // Check if we already have a position with the same full config. A new
  // TP/SL/trailing candidate for the same symbol/direction/timeframe remains
  // independent (subject to the explicit symbol and direction caps above).
  const existing = positions.find(
    (p) => p.symbol === config.symbol
      && p.direction === config.direction
      && (p.configKey || configKey(p)) === candidateKey
      && (
        p.status === "open"
        || p.status === "opening"
        || (p.status === "open_failed" && Date.now() - new Date(p.openedAt).getTime() < 30_000)
      )
  )
  if (existing) return false

  // ─── Keep-Enabled Check: per symbol/direction/config independent ─────────
  // Evaluates last N closed positions for THIS specific config combination.
  // If PF < minProfitFactor or avg DDT > maxDrawdownTimeMin, config is disabled.
  const configEvaluation = evaluateConfigPerformance(candidateKey)
  if (configEvaluation.sampleCount > 0 || configEvaluation.permanentlyDeactivated || !configEvaluation.enabled) {
    configStatus.set(candidateKey, { ...configEvaluation, updatedAt: new Date().toISOString() })
  }
  if (!configEvaluation.enabled) {
    const pfDisplay = configEvaluation.pfInfinite ? "∞" : Number(configEvaluation.pf || 0).toFixed(2)
    log("debug", `Config ${candidateKey} disabled: ${configEvaluation.reason} (PF ${pfDisplay}, DDT ${configEvaluation.avgDDT.toFixed(1)}m, PnL ${configEvaluation.totalPnl.toFixed(3)}%)`)
    stateDirty = true
    return false
  }

  // Stagger entries: don't open all at once
  if (!assessDirectTradeRecentOpenCapacity({ positions: currentRuntimePositions() }).allowed) return false

  return true
}

// ─── Main Processing Loop ─────────────────────────────────────────────────────

async function processTick() {
  if (tickInFlight) return
  tickInFlight = true
  try {
  tickCount++

  // 1. Check if recalculation needed (every 2h)
  if (calculationHistoryHours !== requiredCalculationHistoryHours()) {
    lastRecalcAt = 0
  }
  let calculationFresh = true
  if (Date.now() - lastRecalcAt > state.recalcIntervalMs) {
    calculationFresh = await recalculateConfigs()
  }

  // 2. Check and close existing positions
  await processOpeningPositions()
  await processPendingAccumulationOrders()
  await reconcileOneIncompleteLiveAccounting()
  await reconcileOneIncompleteLiveCloseAccounting()
  await checkAndClosePositions()

  // 2b. Advance each open Direct-Trade Block lane at most once per fresh
  // signal pulse. This mirrors the historical staged-add simulation and keeps
  // live ratio volume causal instead of sending the entire target at entry.
  await processDirectTradeBlockAdds()

  // Existing positions remain protected above, but a stale or failed
  // historical generation may never create a new Direct-Trade entry.
  if (!calculationFresh) return

  // 3. Open new positions based on configs
  if (activeExecutionConfigs.length > 0) {
    // Rotate through configs, one entry attempt per tick
    const configIndex = tickCount % activeExecutionConfigs.length
    const config = activeExecutionConfigs[configIndex]

    if (config && shouldEnterNow(config)) {
      await openPosition(config)
    }
  }

  // Persist on a real elapsed-time deadline, not after an arbitrary number
  // of loop iterations. Slow market/Redis work therefore cannot postpone a
  // lease renewal or settings acknowledgement indefinitely.
  if (stateDirty || Date.now() - lastPersistAt >= 2_000) {
    await persistState()
  }
  } finally {
    tickInFlight = false
  }
}

// ─── Self-Healing Main Loop ───────────────────────────────────────────────────

async function mainLoop() {
  log("info", "Direct-Trade Processor starting...")
  await loadState()
  // The lightweight authenticated heartbeat is independent from full
  // position/statistics snapshots, so 30-second venue reconciliation cannot
  // expire the six-second single-writer lease or overwrite newer state.
  void processorHeartbeatLoop()

  if (!state.enabled) {
    log("info", "Direct-Trade is disabled. Waiting for enable signal...")
  }

  // Acquire the single-writer lease before generating configs or touching a
  // position. A second process becomes a passive standby instead of doubling
  // entries, closes, or dashboard counts.
  if (
    state.enabled &&
    await ensureProcessorLease() &&
    (!calculationVersion || calculationHistoryHours !== requiredCalculationHistoryHours())
  ) {
    await recalculateConfigs()
  }

  while (true) {
    // The loop itself owns serialization: every asynchronous lifecycle,
    // persistence and venue action below must settle before the cadence wait
    // is calculated and the next cycle may begin.
    const cycleStartedAt = Date.now()
    try {
      const now = Date.now()
      // A lease owner receives settings with its two-second state-sync
      // acknowledgement. Standby/disabled workers have no such stream, so
      // they make only this bounded state read to observe a Start action.
      if ((!state.enabled || !processorLeaseHeld) && now - lastStateRefreshAt >= 2_000) {
        await loadState()
      }

      // Current market eligibility is refreshed independently from the full
      // bounded historic calculation. It is cheap, rate-limited, and
      // keeps 5m/15m/30m entry decisions continuous between two full rebuilds.
      if (state.enabled && Date.now() - lastSignalPulseAt >= 60_000) {
        await refreshActiveSignals()
      }

      const hasManagedPositions = positions.some((position) => (
        position.status === "open" || position.status === "opening"
        || (position.mode === "live" && position.status === "closed" && position.pnlAccountingComplete !== true)
      ))
      const ownsLease = (state.enabled || hasManagedPositions)
        ? await ensureProcessorLease()
        : false

      if (state.enabled && ownsLease) {
        await processTick()
      } else {
        // Still manage existing positions after Stop, but only from the lease
        // owner. This prevents duplicate exchange closes during a restart.
        if (hasManagedPositions && ownsLease) {
          await processOpeningPositions()
          await processPendingAccumulationOrders()
          await reconcileOneIncompleteLiveAccounting()
          await reconcileOneIncompleteLiveCloseAccounting()
          await checkAndClosePositions()
          if (stateDirty) await persistState()
        } else if (state.enabled && !ownsLease && Date.now() - lastStandbyWarningAt >= 10_000) {
          lastStandbyWarningAt = Date.now()
          log("warn", "Another Direct-Trade processor owns the lease; standing by")
        }
      }
    } catch (err) {
      log("error", "Tick error (self-healing)", err.message || err)
      trackError()

      // If too many errors, increase interval temporarily
      if (errorsLast5min > 20) {
        log("warn", "Too many errors, backing off to 5s interval for 1 minute")
        await sleep(5000)
      }
    }

    // Progress is published only after the complete lifecycle iteration has
    // settled. The independent heartbeat can therefore prove that a process
    // exists without falsely declaring a blocked exchange call healthy.
    lifecycleCycleCount++
    lastProgressAt = Date.now()

    await waitForDirectTradeNextCycle({
      cycleStartedAt,
      cycleFinishedAt: Date.now(),
      processingIntervalMs: state.processingIntervalMs || 280,
      sleep,
    })
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────

async function waitForServer(timeoutMs = 60000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) return true
    } catch {}
    await sleep(2000)
  }
  return false
}

async function start() {
  log("info", `Direct-Trade Processor v1.0 | Target: ${BASE} | Connection: ${PROCESS_CONNECTION_ID || "legacy"}`)
  log("info", "Waiting for server...")

  const serverReady = await waitForServer()
  if (!serverReady) {
    log("error", "Server not reachable after 60s. Exiting.")
    process.exit(1)
  }

  log("info", "Server ready. Starting main loop.")
  await mainLoop()
}

start().catch((err) => {
  log("error", "Fatal error", err)
  process.exit(1)
})

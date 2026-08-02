#!/usr/bin/env node
/**
 * Direct-Trade Continuous Processor
 *
 * Runs indefinitely with 500ms tick interval. Self-healing, rate-limit aware,
 * async-optimized. Evaluates independent configs from the configured historic
 * range (60h by default) every 2h, manages
 * multiple positions per symbol/direction/timeframe independently.
 *
 * Usage: node scripts/direct-trade-processor.mjs [--port 3002]
 *
 * Features:
 * - 500ms processing interval
 * - Self-healing on errors (auto-restart loops)
 * - Rate limit respect (BingX: 10 req/s, backs off on 429)
 * - Exact 1m, 10m and 15m timeframes, individually and in every combination
 * - Block Strategy 1-12
 * - Trailing stop support
 * - Recalculates the complete independent set grid every 2h from historic data
 * - Control orders for position management
 * - Simulated + Live mode
 */

const PORT = process.env.PORT ?? (
  process.argv.includes("--port")
    ? process.argv[process.argv.indexOf("--port") + 1] || "3002"
    : "3002"
)
const BASE = `http://localhost:${PORT}`

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

function log(level, msg, data) {
  const ts = new Date().toISOString()
  const prefix = `[${ts}] [Direct-Trade] [${level.toUpperCase()}]`
  if (data) console.log(`${prefix} ${msg}`, typeof data === "object" ? JSON.stringify(data).slice(0, 200) : data)
  else console.log(`${prefix} ${msg}`)
}

async function apiCall(path, method = "GET", body = null, timeoutMs = 30_000) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${BASE}${path}`, opts)
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
  symbolCount: 8,
  symbolOrder: "volatility_1h",
  minVolFactor: 0.1,
  positionCostPercent: 0.1,
  maxSlRatio: 0.75,
  slRatioStep: 0.25,
  inverseMaxSlRatio: 1.25,
  timeframes: ["1m", "10m", "15m"],
  strategyTypes: ["standard", "trailing_fixed", "trailing_auto", "combination", "inverse", "high_protection"],
  historyHours: 60,
  entryTactics: ["momentum", "mean_reversion", "breakout", "relative"],
  exitTactics: ["bracket", "momentum_reversal", "relative", "time"],
  entryTiming: "current",
  activityVolumeRatio: 1,
  maxHoldMinutes: 120,
  blockRange: [1, 12],
  maxTotalPositions: 300,
  maxPositionsPerSymbol: 3,
  maxPositionsPerDirection: 2,
  processingIntervalMs: 280,
  recalcIntervalMs: 2 * 60 * 60 * 1000,
  // Evaluation settings
  keepEnabledPosCount: 12,      // Last N pos per config to check if keep enabled
  deactivatePosCount: 16,       // Negative last-N average permanently disables this exact set lineage
  minProfitFactor: 0.8,         // Min PF to keep config enabled
  minRecentProfitFactor: 10,    // Strict historic last-12-position PF gate for future entries
  recentEvaluationPositions: 12,
  maxDrawdownTimeMin: 10,       // Max DDT to keep config enabled
  prevPosWindow: 25,            // Rolling window for overall PF/DDT eval
  prevPosMinCount: 5,           // Min positions before eval activates
  evalPosCount: 12,             // Coordination eval count
  trailingEnabled: true,
}

let configs = []
let executionConfigs = []
let activeExecutionConfigs = []
let executionConfigsBySignal = new Map()
let activeSignalKeys = new Set()
let lastSignalPulseAt = 0
let calculationVersion = null
let positions = []
// Per-config performance tracking. The full candidate identity prevents TP,
// SL, trailing and Block variants from sharing a false PF/DDT history.
let configPerformance = new Map()
let configStatus = new Map()
let stats = {
  totalOrders: 0,
  totalFilled: 0,
  totalPnl: 0,
  winCount: 0,
  lossCount: 0,
  profitFactor: null,
  profitFactorInfinite: false,
  maxDrawdownTimeMin: 0,
  currentDrawdownTimeMin: 0,
  lastPositionAt: null,
  pnlHistory: [],
}

let lastRecalcAt = 0
let tickCount = 0
let errorsLast5min = 0
let errorTimestamps = []
const rateLimiter = new RateLimiter(8)
const processorInstanceId = `dtp_${process.pid}_${Math.random().toString(36).slice(2, 12)}`
let processorLeaseHeld = false
let lastProcessorSyncAt = 0
let stateDirty = false
let tickInFlight = false
let loopCount = 0

function configKey(config) {
  if (typeof config?.setKey === "string" && config.setKey) return config.setKey
  const numeric = (value) => Number(value || 0).toFixed(4)
  return [
    config.symbol,
    config.direction,
    `signal:${config.signalDirection || config.direction}`,
    `type:${config.strategyType || "standard"}`,
    config.timeframe,
    `tp:${numeric(config.takeprofit)}`,
    `sl:${numeric(config.stoploss)}`,
    `tr:${config.trailing ? 1 : 0}`,
    `tm:${config.trailingMode || (config.trailing ? "fixed" : "none")}`,
    `ts:${numeric(config.trailStart)}`,
    `td:${numeric(config.trailStop)}`,
    `ta:${config.autoTrailSensitivity == null ? "none" : numeric(config.autoTrailSensitivity)}`,
    `b:${Math.max(0, Math.floor(Number(config.blockCount) || 0))}`,
    `v:${numeric(config.volumeRatio)}`,
  ].join("|")
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

async function recalculateConfigs() {
  log("info", "Recalculating optimal configs...")
  // The complete 60h maximum-symbol grid can legitimately outlive the short
  // processor lease. Keep refreshing the existing owner lease while the HTTP
  // request is in flight so a standby cannot take over and duplicate orders.
  const leaseKeepalive = setInterval(() => { void persistState() }, 2_000)
  leaseKeepalive.unref?.()
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
      blockRange: state.blockRange,
      trailingEnabled: state.trailingEnabled,
      minProfitFactor: state.minProfitFactor,
      minRecentProfitFactor: state.minRecentProfitFactor,
      recentEvaluationPositions: state.recentEvaluationPositions,
      maxDrawdownTimeMin: state.maxDrawdownTimeMin,
      historyHours: state.historyHours,
      entryTactics: state.entryTactics,
      exitTactics: state.exitTactics,
      entryTiming: state.entryTiming,
      activityVolumeRatio: state.activityVolumeRatio,
      maxHoldMinutes: state.maxHoldMinutes,
    }, 300_000)

    if (result.success && processorLeaseHeld) {
      calculationVersion = result.summary?.calculatedAt || result.timestamp || calculationVersion
      lastRecalcAt = Date.now()
      // The API stores the full grid in chunks. Active candidates are loaded
      // after the causal pulse below, never as one multi-million-row payload.
      await loadState()
      log("info", `Recalculated: ${Number(result.configTotal || 0)} evaluated / ${Number(result.executionConfigTotal || executionConfigs.length)} valid configs for ${result.symbols?.length || 0} symbols`)

      // Save to server
      await apiCall("/api/trade-engine/direct-trade", "POST", {
        action: "update-config",
        lastRecalcAt: new Date().toISOString(),
      }).catch(() => {})

      stateDirty = true
      await persistState()
      await refreshActiveSignals()
    }
  } catch (err) {
    log("error", "Recalculation failed", err.message)
    trackError()
  } finally {
    clearInterval(leaseKeepalive)
  }
}

// ─── Position Management ──────────────────────────────────────────────────────

function getOpenPositionsForSymbol(symbol, direction) {
  return positions.filter(
    (p) => p.symbol === symbol && p.direction === direction && p.status === "open"
  )
}

function canOpenPosition(config) {
  const totalOpenPositions = positions.filter((p) => p.status === "open").length
  if (totalOpenPositions >= Math.max(1, Math.min(300, Number(state.maxTotalPositions) || 300))) return false
  const symbolPositions = positions.filter(
    (p) => p.symbol === config.symbol && p.status === "open"
  )
  if (symbolPositions.length >= state.maxPositionsPerSymbol) return false

  const dirPositions = symbolPositions.filter((p) => p.direction === config.direction)
  if (dirPositions.length >= state.maxPositionsPerDirection) return false

  return true
}

async function openPosition(config) {
  const posId = `dt_${config.symbol}_${config.direction}_${config.timeframe}_${Date.now()}`

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
    takeprofit: config.takeprofit,
    stoploss: config.stoploss,
    trailing: Boolean(config.trailing && state.trailingEnabled),
    trailingMode: config.trailingMode || (config.trailing ? "fixed" : "none"),
    trailStart: config.trailStart,
    trailStop: config.trailStop,
    autoTrailSensitivity: config.autoTrailSensitivity ?? null,
    exitTactic: config.exitTactic || "bracket",
    maxHoldMinutes: state.maxHoldMinutes,
    blockCount: config.blockCount,
    volumeRatio: config.volumeRatio,
    positionCostPercent: Math.max(0.02, Math.min(1, Number(config.positionCostPercent) || Number(state.positionCostPercent) || 0.1)),
    status: "open",
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
    configKey: configKey(config),
  }

  if (state.liveMode) {
    // Place real order via live-order-service
    try {
      await rateLimiter.acquire()
      const orderResult = await apiCall("/api/testing/place-order", "POST", {
        symbol: config.symbol,
        side: config.direction === "long" ? "buy" : "sell",
        quantity: 0, // Will be calculated by the order service based on volume factor
        orderType: "market",
        leverage: 10,
        volumeFactor: state.minVolFactor * 0.5,
        directTrade: true,
      })

      if (orderResult?.success) {
        position.entryPrice = orderResult.fill?.filledPrice || orderResult.details?.avgPrice || 0
        position.quantity = orderResult.fill?.filledQty || orderResult.quantity || 0
        position.orderId = orderResult.orderId
        stats.totalOrders++
        stats.totalFilled++
      } else {
        log("warn", `Order failed for ${config.symbol}`, orderResult?.error)
        return null
      }
    } catch (err) {
      if (err.message?.includes("429")) rateLimiter.backoff(3000)
      log("error", `Order error for ${config.symbol}`, err.message)
      trackError()
      return null
    }
  } else {
    // Simulated: use current market price
    try {
      await rateLimiter.acquire()
      const ticker = await fetch(
        `https://open-api.bingx.com/openApi/swap/v2/quote/ticker?symbol=${config.symbol.replace(/USDT$/, "-USDT")}`,
        { signal: AbortSignal.timeout(3000) }
      ).then((r) => r.json()).catch(() => null)

      position.entryPrice = Number(ticker?.data?.lastPrice || ticker?.data?.c || 0)
      position.quantity = (state.minVolFactor * 5 * 0.5) / (position.entryPrice || 1) // 50% system safety factor
      stats.totalOrders++
      stats.totalFilled++
    } catch {
      return null
    }
  }

  if (!position.entryPrice) return null

  // Set initial SL/TP prices
  if (config.direction === "long") {
    position.highWatermark = position.entryPrice
    position.currentSlPrice = position.entryPrice * (1 - config.stoploss / 100)
  } else {
    position.lowWatermark = position.entryPrice
    position.currentSlPrice = position.entryPrice * (1 + config.stoploss / 100)
  }
  position.lastObservedPrice = position.entryPrice

  positions.push(position)
  stats.lastPositionAt = position.openedAt
  stateDirty = true
  log("info", `Opened ${position.mode} ${config.direction} ${config.symbol} @ ${position.entryPrice.toFixed(4)} (TF:${config.timeframe} TP:${config.takeprofit}% SL:${config.stoploss}%)`)
  return position
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

  // Batch fetch current prices
  const symbols = [...new Set(openPos.map((p) => p.symbol))]
  const prices = {}

  // Public ticker reads can run concurrently; the shared token bucket keeps
  // the venue request rate bounded while avoiding a 32-symbol serial delay.
  await Promise.all(symbols.map(async (symbol) => {
    try {
      await rateLimiter.acquire()
      const bingxSym = symbol.replace(/USDT$/, "-USDT")
      const res = await fetch(
        `https://open-api.bingx.com/openApi/swap/v2/quote/ticker?symbol=${bingxSym}`,
        { signal: AbortSignal.timeout(3000) }
      )
      if (res.ok) {
        const data = await res.json()
        prices[symbol] = Number(data?.data?.lastPrice || data?.data?.c || 0)
      }
    } catch (err) {
      if (String(err).includes("429")) rateLimiter.backoff(2000)
    }
  }))

  for (const pos of openPos) {
    const currentPrice = prices[pos.symbol]
    if (!currentPrice || !pos.entryPrice) continue

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
      const tpPrice = pos.entryPrice * (1 + pos.takeprofit / 100)
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

      const tpPrice = pos.entryPrice * (1 - pos.takeprofit / 100)
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
      const openTime = new Date(pos.openedAt).getTime()
      pos.drawdownTimeMin = (Date.now() - openTime) / 60000
    }

    if (shouldClose) {
      await closePosition(pos, currentPrice, exitReason)
    }
  }
}

async function closePosition(pos, exitPrice, reason) {
  const grossPnl = pos.direction === "long"
    ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
    : ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100
  // The configured 0.1% position cost is applied once, at the only point
  // where a result becomes realised. Open rows remain managed independently
  // and cannot influence PF/DDT or deactivation before they close.
  const positionCostPercent = Math.max(0.02, Math.min(1, Number(pos.positionCostPercent) || Number(state.positionCostPercent) || 0.1))
  const pnl = grossPnl - positionCostPercent

  // A live close is authoritative only after the exchange accepts it. Keep
  // the local row open on failure so the next leased tick retries instead of
  // reporting a phantom close and dropping protection.
  if (pos.mode === "live" && pos.orderId) {
    try {
      await rateLimiter.acquire()
      const closeResult = await apiCall("/api/testing/place-order", "POST", {
        symbol: pos.symbol,
        side: pos.direction === "long" ? "sell" : "buy",
        quantity: pos.quantity,
        orderType: "market",
        leverage: 10,
        directTrade: true,
        closePosition: true,
      })
      if (!closeResult?.success) {
        log("warn", `Close order rejected for ${pos.symbol}`, closeResult?.error)
        return false
      }
    } catch (err) {
      log("error", `Close order failed for ${pos.symbol}`, err.message)
      trackError()
      return false
    }
  }

  pos.status = "closed"
  pos.exitPrice = exitPrice
  pos.closedAt = new Date().toISOString()
  pos.exitReason = reason
  pos.grossPnl = Number(grossPnl.toFixed(4))
  pos.positionCostPercent = positionCostPercent
  pos.pnl = Number(pnl.toFixed(4))

  // Update stats
  stats.totalPnl += pos.pnl
  if (pos.pnl > 0) stats.winCount++
  else stats.lossCount++

  const totalProfit = positions.filter((p) => p.status === "closed" && p.pnl > 0).reduce((s, p) => s + p.pnl, 0)
  const totalLoss = Math.abs(positions.filter((p) => p.status === "closed" && p.pnl <= 0).reduce((s, p) => s + p.pnl, 0))
  stats.profitFactorInfinite = totalLoss === 0 && totalProfit > 0
  stats.profitFactor = totalLoss > 0 ? Number((totalProfit / totalLoss).toFixed(3)) : stats.profitFactorInfinite ? null : 0
  stats.maxDrawdownTimeMin = Math.max(stats.maxDrawdownTimeMin, pos.drawdownTimeMin || 0)
  stats.lastPositionAt = pos.closedAt

  // PnL history
  stats.pnlHistory.push({
    time: pos.closedAt,
    pnl: pos.pnl,
    cumPnl: stats.totalPnl,
  })
  // Keep last 500 entries
  if (stats.pnlHistory.length > 500) stats.pnlHistory = stats.pnlHistory.slice(-500)

  // Track per-config performance for keep-enabled evaluation
  const positionConfigKey = pos.configKey || configKey(pos)
  if (!configPerformance.has(positionConfigKey)) configPerformance.set(positionConfigKey, [])
  const perfArr = configPerformance.get(positionConfigKey)
  perfArr.push({
    pnl: pos.pnl,
    drawdownTimeMin: pos.drawdownTimeMin || 0,
    closedAt: pos.closedAt,
    exitReason: reason,
  })
  // Retain exactly the largest configured rolling evaluation window. This is
  // not a hidden candidate cap; it prevents stale results from changing the
  // requested current-window PF/DDT decision.
  const historyWindow = Math.max(
    1,
    Math.ceil(Number(state.keepEnabledPosCount) || 0),
    Math.ceil(Number(state.deactivatePosCount) || 0),
    Math.ceil(Number(state.prevPosWindow) || 0),
    Math.ceil(Number(state.evalPosCount) || 0),
  )
  if (perfArr.length > historyWindow) perfArr.splice(0, perfArr.length - historyWindow)

  const status = evaluateConfigPerformance(positionConfigKey)
  // Do not materialise a warm-up status for every one of the independent
  // candidates. Persist only configurations that have actual outcomes or a
  // durable deactivation, keeping state-sync proportional to real positions.
  if (perfArr.length > 0 || status.permanentlyDeactivated || !status.enabled) {
    configStatus.set(positionConfigKey, { ...status, updatedAt: pos.closedAt })
  }
  stateDirty = true
  log("info", `Closed ${pos.mode} ${pos.direction} ${pos.symbol} @ ${exitPrice.toFixed(4)} | PnL: ${pos.pnl > 0 ? "+" : ""}${pos.pnl.toFixed(3)}% | Reason: ${reason} | Total PnL: ${stats.totalPnl.toFixed(3)}% | Config[${positionConfigKey}] history: ${perfArr.length}`)
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
      positions,
      stats,
      configStatus: Object.fromEntries(configStatus),
      configPerformance: Object.fromEntries(configPerformance),
    })
    processorLeaseHeld = result?.leaseHeld === true
    lastProcessorSyncAt = Date.now()
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

async function loadState(includeExecution = false) {
  try {
    const result = await apiCall(`/api/trade-engine/direct-trade${includeExecution ? "?includeExecution=1" : ""}`)
    if (result?.state) {
      const prev = { ...state }
      state = { ...state, ...result.state }
      const persistedRecalcAt = Date.parse(result.state.lastRecalcAt || "")
      if (Number.isFinite(persistedRecalcAt) && persistedRecalcAt > 0) {
        lastRecalcAt = persistedRecalcAt
      }
      // Detect instant-effect config changes (volume factor, eval settings)
      const evaluationInputsChanged = JSON.stringify({
        minVolFactor: prev.minVolFactor,
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
        maxSlRatio: prev.maxSlRatio,
        slRatioStep: prev.slRatioStep,
        inverseMaxSlRatio: prev.inverseMaxSlRatio,
        strategyTypes: prev.strategyTypes,
        deactivatePosCount: prev.deactivatePosCount,
        trailingEnabled: prev.trailingEnabled,
      }) !== JSON.stringify({
        minVolFactor: state.minVolFactor,
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
        maxSlRatio: state.maxSlRatio,
        slRatioStep: state.slRatioStep,
        inverseMaxSlRatio: state.inverseMaxSlRatio,
        strategyTypes: state.strategyTypes,
        deactivatePosCount: state.deactivatePosCount,
        trailingEnabled: state.trailingEnabled,
      })
      if (evaluationInputsChanged) {
        log("info", `Config change detected: volFactor=${state.minVolFactor}, keepEnabled=${state.keepEnabledPosCount}, minPF=${state.minProfitFactor}, maxDDT=${state.maxDrawdownTimeMin}`)
        // Settings are authoritative immediately. Rebuild the entire historic
        // grid on the next owned tick instead of trading stale configurations.
        lastRecalcAt = 0
      }
    }
    const remoteCalculationVersion = result?.calculation?.calculatedAt || null
    if (!includeExecution && remoteCalculationVersion && remoteCalculationVersion !== calculationVersion) {
      calculationVersion = remoteCalculationVersion
      await refreshActiveSignals()
      return
    }
    if (Array.isArray(result?.executionConfigs)) {
      configs = result.executionConfigs
      executionConfigs = configs.filter((config) => config?.valid !== false)
      indexExecutionConfigs()
      refreshActiveExecutionConfigs()
    }
    if (result?.stats && typeof result.stats === "object") stats = { ...stats, ...result.stats }
    if (Array.isArray(result?.positions)) positions = result.positions
    if (result?.configPerformance && typeof result.configPerformance === "object") {
      configPerformance = new Map(Object.entries(result.configPerformance))
    }
    if (result?.configStatus && typeof result.configStatus === "object") {
      configStatus = new Map(Object.entries(result.configStatus))
    }
    if (remoteCalculationVersion) calculationVersion = remoteCalculationVersion
    log("info", `State loaded: enabled=${state.enabled}, live=${state.liveMode}, evaluated=${Number(result?.configTotal || 0)}, executable=${executionConfigs.length}, keepEnabledN=${state.keepEnabledPosCount}`)
  } catch (err) {
    log("warn", "Could not load state from server, using defaults", err.message)
  }
}

// ─── Entry Signal Check (simplified for processor) ────────────────────────────

function shouldEnterNow(config) {
  if (config?.valid === false) return false
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

  const candidateKey = configKey(config)
  // Check if we already have a position with the same full config. A new
  // TP/SL/trailing candidate for the same symbol/direction/timeframe remains
  // independent (subject to the explicit symbol and direction caps above).
  const existing = positions.find(
    (p) => p.symbol === config.symbol
      && p.direction === config.direction
      && (p.configKey || configKey(p)) === candidateKey
      && p.status === "open"
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
  const recentOpens = positions.filter(
    (p) => p.status === "open" && Date.now() - new Date(p.openedAt).getTime() < 30000
  )
  if (recentOpens.length >= 2) return false

  return true
}

// ─── Main Processing Loop ─────────────────────────────────────────────────────

async function processTick() {
  if (tickInFlight) return
  tickInFlight = true
  try {
  tickCount++

  // 1. Check if recalculation needed (every 2h)
  if (Date.now() - lastRecalcAt > state.recalcIntervalMs) {
    await recalculateConfigs()
  }

  // 2. Check and close existing positions
  await checkAndClosePositions()

  // 3. Open new positions based on configs
  if (activeExecutionConfigs.length > 0) {
    // Rotate through configs, one entry attempt per tick
    const configIndex = tickCount % activeExecutionConfigs.length
    const config = activeExecutionConfigs[configIndex]

    if (config && shouldEnterNow(config)) {
      await openPosition(config)
    }
  }

  // Persist a consistent snapshot after data changes and at least every two
  // seconds. The same call renews the single-writer lease before it expires.
  if (stateDirty || tickCount % 4 === 0) {
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

  if (!state.enabled) {
    log("info", "Direct-Trade is disabled. Waiting for enable signal...")
  }

  // Acquire the single-writer lease before generating configs or touching a
  // position. A second process becomes a passive standby instead of doubling
  // entries, closes, or dashboard counts.
  if (state.enabled && await ensureProcessorLease() && !calculationVersion) {
    await recalculateConfigs()
  }

  while (true) {
    try {
      loopCount++
      // Reload state periodically (every 60 loops = 30s), including while
      // disabled. The old tick-based condition reloaded on every 500ms loop
      // while disabled and could race a settings update.
      if (loopCount % 60 === 0) {
        await loadState()
      }

      // Current market eligibility is refreshed independently from the full
      // 60h calculation. It is cheap, bounded by public API backpressure, and
      // keeps 1m/10m/15m entry decisions continuous between two full rebuilds.
      if (state.enabled && Date.now() - lastSignalPulseAt >= 60_000) {
        await refreshActiveSignals()
      }

      const hasOpenPositions = positions.some((p) => p.status === "open")
      const ownsLease = (state.enabled || hasOpenPositions)
        ? await ensureProcessorLease()
        : false

      if (state.enabled && ownsLease) {
        await processTick()
      } else {
        // Still manage existing positions after Stop, but only from the lease
        // owner. This prevents duplicate exchange closes during a restart.
        if (hasOpenPositions && ownsLease) {
          await checkAndClosePositions()
          if (stateDirty) await persistState()
        } else if (state.enabled && !ownsLease && loopCount % 20 === 0) {
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
        continue
      }
    }

    await sleep(state.processingIntervalMs || 280)
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
  log("info", `Direct-Trade Processor v1.0 | Target: ${BASE}`)
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

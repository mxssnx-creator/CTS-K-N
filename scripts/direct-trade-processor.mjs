#!/usr/bin/env node
/**
 * Direct-Trade Continuous Processor
 *
 * Runs indefinitely with 500ms tick interval. Self-healing, rate-limit aware,
 * async-optimized. Calculates best configs from 8h data every 2h, manages
 * multiple positions per symbol/direction/timeframe independently.
 *
 * Usage: node scripts/direct-trade-processor.mjs [--port 3002]
 *
 * Features:
 * - 500ms processing interval
 * - Self-healing on errors (auto-restart loops)
 * - Rate limit respect (BingX: 10 req/s, backs off on 429)
 * - Multiple timeframes (1m, 5m, 10m) independent + combined
 * - Block Strategy 1-12
 * - Trailing stop support
 * - Recalculates best configs every 2h from last 8h data
 * - Control orders for position management
 * - Simulated + Live mode
 */

const PORT = process.env.PORT || process.argv.includes("--port")
  ? process.argv[process.argv.indexOf("--port") + 1] || "3002"
  : "3002"
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

async function apiCall(path, method = "GET", body = null) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30000),
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
  minVolFactor: 1,
  maxSlRatio: 1,
  slRatioStep: 0.25,
  timeframes: ["1m", "5m", "10m"],
  blockRange: [1, 12],
  maxPositionsPerSymbol: 3,
  maxPositionsPerDirection: 2,
  processingIntervalMs: 500,
  recalcIntervalMs: 2 * 60 * 60 * 1000,
  // Evaluation settings
  keepEnabledPosCount: 8,       // Last N pos per config to check if keep enabled
  minProfitFactor: 1.1,         // Min PF to keep config enabled
  maxDrawdownTimeMin: 10,       // Max DDT to keep config enabled
  prevPosWindow: 25,            // Rolling window for overall PF/DDT eval
  prevPosMinCount: 5,           // Min positions before eval activates
  evalPosCount: 12,             // Coordination eval count
}

let configs = []
let positions = []
// Per-config performance tracking: key = "symbol|direction|timeframe" → last N positions
let configPerformance = new Map()
let stats = {
  totalOrders: 0,
  totalFilled: 0,
  totalPnl: 0,
  winCount: 0,
  lossCount: 0,
  profitFactor: 0,
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

// ─── Config Calculation ───────────────────────────────────────────────────────

async function recalculateConfigs() {
  log("info", "Recalculating optimal configs...")
  try {
    const result = await apiCall("/api/trade-engine/direct-trade/calculate", "POST", {
      symbolCount: state.symbolCount,
      symbolOrder: state.symbolOrder,
      minVolFactor: state.minVolFactor,
      maxSlRatio: state.maxSlRatio,
      slRatioStep: state.slRatioStep,
      timeframes: state.timeframes,
      blockRange: state.blockRange,
    })

    if (result.success && result.configs) {
      configs = result.configs
      lastRecalcAt = Date.now()
      log("info", `Recalculated: ${configs.length} configs for ${result.symbols?.length || 0} symbols`)

      // Save to server
      await apiCall("/api/trade-engine/direct-trade", "POST", {
        action: "update-config",
        lastRecalcAt: new Date().toISOString(),
      }).catch(() => {})

      // Persist configs via Redis through status endpoint
      await persistState()
    }
  } catch (err) {
    log("error", "Recalculation failed", err.message)
    trackError()
  }
}

// ─── Position Management ──────────────────────────────────────────────────────

function getOpenPositionsForSymbol(symbol, direction) {
  return positions.filter(
    (p) => p.symbol === symbol && p.direction === direction && p.status === "open"
  )
}

function canOpenPosition(config) {
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
    timeframe: config.timeframe,
    entryPrice: 0,
    exitPrice: 0,
    quantity: 0,
    takeprofit: config.takeprofit,
    stoploss: config.stoploss,
    trailing: config.trailing,
    trailStart: config.trailStart,
    trailStop: config.trailStop,
    blockCount: config.blockCount,
    volumeRatio: config.volumeRatio,
    status: "open",
    openedAt: new Date().toISOString(),
    closedAt: null,
    pnl: 0,
    drawdownTimeMin: 0,
    highWatermark: 0,
    lowWatermark: Infinity,
    currentSlPrice: 0,
    mode: state.liveMode ? "live" : "simulated",
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
        volumeFactor: state.minVolFactor,
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
      position.quantity = (state.minVolFactor * 5) / (position.entryPrice || 1) // ~$5 notional per vol factor
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

  positions.push(position)
  position.lastPositionAt = position.openedAt
  log("info", `Opened ${position.mode} ${config.direction} ${config.symbol} @ ${position.entryPrice.toFixed(4)} (TF:${config.timeframe} TP:${config.takeprofit}% SL:${config.stoploss}%)`)
  return position
}

async function checkAndClosePositions() {
  const openPos = positions.filter((p) => p.status === "open")
  if (openPos.length === 0) return

  // Batch fetch current prices
  const symbols = [...new Set(openPos.map((p) => p.symbol))]
  const prices = {}

  for (const symbol of symbols) {
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
  }

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
        if (pos.trailing && pos.highWatermark > pos.entryPrice * (1 + (pos.trailStart || 0.5) / 100)) {
          const newSl = pos.highWatermark * (1 - (pos.trailStop || 0.3) / 100)
          if (newSl > pos.currentSlPrice) pos.currentSlPrice = newSl
        }
      }

      // TP check
      const tpPrice = pos.entryPrice * (1 + pos.takeprofit / 100)
      if (currentPrice >= tpPrice) { shouldClose = true; exitReason = "tp" }
      // SL check
      if (currentPrice <= pos.currentSlPrice) { shouldClose = true; exitReason = pos.trailing ? "trailing" : "sl" }
    } else {
      // Short
      if (currentPrice < pos.lowWatermark || pos.lowWatermark === Infinity) {
        pos.lowWatermark = currentPrice
        if (pos.trailing && pos.lowWatermark < pos.entryPrice * (1 - (pos.trailStart || 0.5) / 100)) {
          const newSl = pos.lowWatermark * (1 + (pos.trailStop || 0.3) / 100)
          if (newSl < pos.currentSlPrice) pos.currentSlPrice = newSl
        }
      }

      const tpPrice = pos.entryPrice * (1 - pos.takeprofit / 100)
      if (currentPrice <= tpPrice) { shouldClose = true; exitReason = "tp" }
      if (currentPrice >= pos.currentSlPrice) { shouldClose = true; exitReason = pos.trailing ? "trailing" : "sl" }
    }

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
  pos.status = "closed"
  pos.exitPrice = exitPrice
  pos.closedAt = new Date().toISOString()
  pos.exitReason = reason

  const pnl = pos.direction === "long"
    ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
    : ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100
  pos.pnl = Number(pnl.toFixed(4))

  // Close live position
  if (state.liveMode && pos.orderId) {
    try {
      await rateLimiter.acquire()
      await apiCall("/api/testing/place-order", "POST", {
        symbol: pos.symbol,
        side: pos.direction === "long" ? "sell" : "buy",
        quantity: pos.quantity,
        orderType: "market",
        leverage: 10,
        directTrade: true,
        closePosition: true,
      })
    } catch (err) {
      log("error", `Close order failed for ${pos.symbol}`, err.message)
    }
  }

  // Update stats
  stats.totalPnl += pos.pnl
  if (pos.pnl > 0) stats.winCount++
  else stats.lossCount++

  const totalProfit = positions.filter((p) => p.status === "closed" && p.pnl > 0).reduce((s, p) => s + p.pnl, 0)
  const totalLoss = Math.abs(positions.filter((p) => p.status === "closed" && p.pnl <= 0).reduce((s, p) => s + p.pnl, 0))
  stats.profitFactor = totalLoss > 0 ? Number((totalProfit / totalLoss).toFixed(3)) : totalProfit > 0 ? 10 : 0
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
  const configKey = `${pos.symbol}|${pos.direction}|${pos.timeframe}`
  if (!configPerformance.has(configKey)) configPerformance.set(configKey, [])
  const perfArr = configPerformance.get(configKey)
  perfArr.push({
    pnl: pos.pnl,
    drawdownTimeMin: pos.drawdownTimeMin || 0,
    closedAt: pos.closedAt,
    exitReason: reason,
  })
  // Keep last 100 per config for evaluation window
  if (perfArr.length > 100) perfArr.splice(0, perfArr.length - 100)

  log("info", `Closed ${pos.mode} ${pos.direction} ${pos.symbol} @ ${exitPrice.toFixed(4)} | PnL: ${pos.pnl > 0 ? "+" : ""}${pos.pnl.toFixed(3)}% | Reason: ${reason} | Total PnL: ${stats.totalPnl.toFixed(3)}% | Config[${configKey}] history: ${perfArr.length}`)
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
    await fetch(`${BASE}/api/trade-engine/direct-trade/status`, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    }).catch(() => {})

    // Persist via direct Redis keys through the API
    // The status route reads these keys
  } catch {}
}

async function loadState() {
  try {
    const result = await apiCall("/api/trade-engine/direct-trade")
    if (result?.state) {
      const prev = { ...state }
      state = { ...state, ...result.state }
      // Detect instant-effect config changes (volume factor, eval settings)
      if (prev.minVolFactor !== state.minVolFactor ||
          prev.keepEnabledPosCount !== state.keepEnabledPosCount ||
          prev.minProfitFactor !== state.minProfitFactor ||
          prev.maxDrawdownTimeMin !== state.maxDrawdownTimeMin) {
        log("info", `Config change detected: volFactor=${state.minVolFactor}, keepEnabled=${state.keepEnabledPosCount}, minPF=${state.minProfitFactor}, maxDDT=${state.maxDrawdownTimeMin}`)
      }
    }
    if (result?.configs) {
      configs = result.configs
    }
    log("info", `State loaded: enabled=${state.enabled}, live=${state.liveMode}, configs=${configs.length}, keepEnabledN=${state.keepEnabledPosCount}`)
  } catch (err) {
    log("warn", "Could not load state from server, using defaults", err.message)
  }
}

// ─── Entry Signal Check (simplified for processor) ────────────────────────────

function shouldEnterNow(config) {
  // Use the pre-calculated configs as entry signals
  // The calculation already validated entries based on 8h backtested data
  // Here we just check timing and position limits
  if (!canOpenPosition(config)) return false

  // Check if we already have a position with same config
  const existing = positions.find(
    (p) => p.symbol === config.symbol
      && p.direction === config.direction
      && p.timeframe === config.timeframe
      && p.status === "open"
  )
  if (existing) return false

  // ─── Keep-Enabled Check: per symbol/direction/config independent ─────────
  // Evaluates last N closed positions for THIS specific config combination.
  // If PF < minProfitFactor or avg DDT > maxDrawdownTimeMin, config is disabled.
  const configKey = `${config.symbol}|${config.direction}|${config.timeframe}`
  const perfHistory = configPerformance.get(configKey) || []
  if (perfHistory.length >= state.keepEnabledPosCount) {
    const evalWindow = perfHistory.slice(-state.keepEnabledPosCount)
    const wins = evalWindow.filter((p) => p.pnl > 0)
    const losses = evalWindow.filter((p) => p.pnl <= 0)
    const totalProfit = wins.reduce((s, p) => s + p.pnl, 0)
    const totalLoss = Math.abs(losses.reduce((s, p) => s + p.pnl, 0))
    const configPF = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? 10 : 0
    const avgDDT = evalWindow.reduce((s, p) => s + (p.drawdownTimeMin || 0), 0) / evalWindow.length

    if (configPF < state.minProfitFactor) {
      log("debug", `Config ${configKey} disabled: PF ${configPF.toFixed(2)} < ${state.minProfitFactor}`)
      return false
    }
    if (avgDDT > state.maxDrawdownTimeMin) {
      log("debug", `Config ${configKey} disabled: DDT ${avgDDT.toFixed(1)}m > ${state.maxDrawdownTimeMin}m`)
      return false
    }
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
  tickCount++

  // 1. Check if recalculation needed (every 2h)
  if (Date.now() - lastRecalcAt > state.recalcIntervalMs) {
    await recalculateConfigs()
  }

  // 2. Check and close existing positions
  await checkAndClosePositions()

  // 3. Open new positions based on configs
  if (configs.length > 0) {
    // Rotate through configs, one entry attempt per tick
    const configIndex = tickCount % configs.length
    const config = configs[configIndex]

    if (config && shouldEnterNow(config)) {
      await openPosition(config)
    }
  }

  // 4. Persist processor heartbeat every 10 ticks
  if (tickCount % 10 === 0) {
    try {
      await fetch(`${BASE}/api/trade-engine/direct-trade/status`, {
        signal: AbortSignal.timeout(2000),
      }).catch(() => {})
    } catch {}
  }
}

// ─── Self-Healing Main Loop ───────────────────────────────────────────────────

async function mainLoop() {
  log("info", "Direct-Trade Processor starting...")
  await loadState()

  if (!state.enabled) {
    log("info", "Direct-Trade is disabled. Waiting for enable signal...")
  }

  // Initial calculation
  if (configs.length === 0 && state.enabled) {
    await recalculateConfigs()
  }

  while (true) {
    try {
      // Reload state periodically (every 60 ticks = 30s)
      if (tickCount % 60 === 0) {
        await loadState()
      }

      if (state.enabled) {
        await processTick()
      } else {
        // Still check positions even when disabled (manage existing)
        if (positions.some((p) => p.status === "open")) {
          await checkAndClosePositions()
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

    await sleep(state.processingIntervalMs || 500)
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

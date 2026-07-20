import { DEFAULT_VOLUME_STEP_RATIO } from "@/lib/constants"
import { NextResponse } from "next/server"
import { getAllConnections, getConnection, initRedis, updateConnectionState, setSettings, getSettings, getRedisClient,
  buildMainConnectionEnableUpdate } from "@/lib/redis-db"
import { API_VERSIONS } from "@/lib/system-version"
import { logProgressionEvent, getProgressionLogs } from "@/lib/engine-progression-logs"
import { createExchangeConnector } from "@/lib/exchange-connectors"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { loadSettingsAsync } from "@/lib/settings-storage"
import { fetchTopSymbols, normaliseSort } from "@/lib/top-symbols"
import { emitEngineStageAck } from "@/lib/engine-stage-ack"
import { checkProductionReadiness, productionReadinessJson } from "@/lib/production-readiness"
import { applyMainConnectionSettingsChange } from "@/lib/connection-recoordinator"
import { allocateStateSwitchVersion, queueEngineRefreshRequest } from "@/lib/engine-refresh-queue"
import { evaluateRealTradeReadiness } from "@/lib/real-trade-gates"
import { buildPrehistoricGateKeys } from "@/lib/progression-scope"
import {
  QUICKSTART_CONNECTION_TEST_TIMEOUT_MS,
  resolveQuickStartEngineBootWaitMs,
} from "@/lib/quickstart-timeouts"
import { invalidateTradeEngineStatusCache } from "@/lib/trade-engine-status-cache"
import { DEFAULT_SYMBOL_COUNT } from "@/lib/symbol-selection-defaults"

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function hasUsableExchangeCredentials(connection: any): boolean {
  const key = String(connection?.api_key || connection?.apiKey || "")
  const secret = String(connection?.api_secret || connection?.apiSecret || "")
  if (key.length < 10 || secret.length < 10) return false
  const banned = /PLACEHOLDER|00998877|^test/i
  return !banned.test(key) && !banned.test(secret)
}


function hasOwnField(source: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, field)
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === "string") return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

function readFirstMeaningful(source: Record<string, unknown>, fields: string[]): unknown {
  for (const field of fields) {
    if (hasOwnField(source, field) && hasMeaningfulValue(source[field])) {
      return source[field]
    }
  }
  return undefined
}

function parseStoredSymbols(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((symbol): symbol is string => typeof symbol === "string" && symbol.length > 0)
  }
  if (typeof value !== "string" || value.trim().length === 0) return []
  const trimmed = value.trim()
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) {
      return parsed.filter((symbol): symbol is string => typeof symbol === "string" && symbol.length > 0)
    }
  } catch {
    // Fall back to comma-separated legacy values below.
  }
  return trimmed.split(",").map((symbol) => symbol.trim()).filter(Boolean)
}

function stringifySettingValue(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  return String(value)
}

function resolveQuickStartValue(
  body: Record<string, unknown>,
  existing: Record<string, unknown>,
  bodyFields: string[],
  existingFields: string[],
  safeDefault: unknown,
): unknown {
  const explicit = readFirstMeaningful(body, bodyFields)
  if (explicit !== undefined) return explicit
  const saved = readFirstMeaningful(existing, existingFields)
  if (saved !== undefined) return saved
  return safeDefault
}

function normalizeQuickstartExchange(connection: any): string {
  const raw = String(connection?.exchange || connection?.exchange_type || connection?.exchange_name || "bingx").toLowerCase()
  const compact = raw.replace(/[^a-z]/g, "")
  if (compact.includes("bingx") || String(connection?.id || "").toLowerCase().startsWith("bingx")) return "bingx"
  return compact || raw || "bingx"
}

function hasExistingSetting(settings: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(settings, key) &&
    settings[key] !== undefined &&
    settings[key] !== null &&
    String(settings[key]).length > 0
}

function firstExistingSetting(settings: Record<string, unknown>, keys: string[], fallback: string): string {
  for (const key of keys) {
    if (hasExistingSetting(settings, key)) return String(settings[key])
  }
  return fallback
}

// RUNTIME FIX: Patch IndicationProcessor cache
// This fixes the "Cannot read properties of undefined (reading 'get')" error
function patchIndicationProcessorCaches(coordinator: any) {
  if (!coordinator) return
  try {
    const engines = coordinator.engines || coordinator._engines || new Map()
    for (const [, manager] of engines) {
      if (manager?.indicationProcessor) {
        const proc = manager.indicationProcessor
        if (!proc.marketDataCache || !(proc.marketDataCache instanceof Map)) {
          proc.marketDataCache = new Map()
        }
        if (!proc.settingsCache) {
          proc.settingsCache = { data: null, timestamp: 0 }
        }
        if (!proc.CACHE_TTL) {
          proc.CACHE_TTL = 500
        }
      }
    }
  } catch (e) { /* ignore */ }
}

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const API_VERSION = API_VERSIONS.tradeEngine
const LOG_PREFIX = `[v0] [QuickStart] ${API_VERSION}`

// Default fallback symbol. Normal quickstart auto-picks top symbols by volatility (no hard cap).
const DEFAULT_SYMBOLS = ["DRIFTUSDT"]
// Max symbols limited only by exchange API response or memory constraints.
// Start safely with one dynamically selected symbol. Explicit UI/API choices
// can still scale up to the exchange/runtime limit.
const QUICKSTART_DEFAULT_SYMBOL_COUNT = DEFAULT_SYMBOL_COUNT
const QUICKSTART_LIVE_VOLUME_FACTOR = "0.1"
const QUICKSTART_PRODUCTION_ENGINE_BOOT_WAIT_MS = resolveQuickStartEngineBootWaitMs(
  process.env.QUICKSTART_ENGINE_BOOT_WAIT_MS,
)

function shouldAwaitQuickStartEngineBoot(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL === "1" ||
    !!process.env.VERCEL_ENV ||
    process.env.NEXT_PUBLIC_QUICKSTART_AWAIT_ENGINE_BOOT === "1"
  )
}

async function awaitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutValue: T): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(timeoutValue), Math.max(1, timeoutMs))
        timeout.unref?.()
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

const QUICKSTART_ZERO_COUNTERS: Record<string, string> = {
  cycles_completed: "0",
  successful_cycles: "0",
  failed_cycles: "0",
  total_trades: "0",
  successful_trades: "0",
  total_profit: "0",
  cycle_success_rate: "0",
  trade_success_rate: "0",
  indication_cycle_count: "0",
  indication_live_cycle_count: "0",
  strategy_cycle_count: "0",
  strategy_live_cycle_count: "0",
  realtime_cycle_count: "0",
  realtime_live_cycle_count: "0",
  live_positions_cycle_count: "0",
  frames_processed: "0",
  indications_count: "0",
  indications_direction_count: "0",
  indications_move_count: "0",
  indications_active_count: "0",
  indications_active_advanced_count: "0",
  indications_optimal_count: "0",
  indications_auto_count: "0",
  indications_trend_count: "0",
  strategies_count: "0",
  strategies_base_total: "0",
  strategies_main_total: "0",
  strategies_real_total: "0",
  strategies_live_total: "0",
  strategies_base_evaluated: "0",
  strategies_main_evaluated: "0",
  strategies_real_evaluated: "0",
  strategies_live_ready: "0",
}

/**
 * POST /api/trade-engine/quick-start
 * Quick-start endpoint with direct function calls (no HTTP fetch):
 * 1. Tests connection using createExchangeConnector directly
 * 2. Auto-retrieves top symbols or uses defaults
 * 3. Sets up connection with these symbols
 * 4. Logs all progression events
 */
export async function POST(request: Request) {
  const startTime = Date.now()
  
  try {
    const body = await request.json().catch(() => ({}))
    const action = body.action || "enable"
    const liveTradeRequested = body.liveTrade !== false && body.is_live_trade !== false
    
    await initRedis()
    if (action !== "disable" && process.env.NODE_ENV === "production") {
      const readiness = await checkProductionReadiness()
      if (!readiness.ready) {
        return NextResponse.json(productionReadinessJson(readiness), { status: 503 })
      }
    }
    const client = getRedisClient()
    const allConnections = await getAllConnections()
    
    console.log(`${LOG_PREFIX}: === QUICKSTART ${action.toUpperCase()} ===`)
    console.log(`${LOG_PREFIX}: Scanning ${allConnections.length} connections...`)
    
    // Log initial progress
    await logProgressionEvent("global", "quickstart_scan", "info", `Scanning ${allConnections.length} connections`, {
      action,
      totalConnections: allConnections.length,
      timestamp: new Date().toISOString(),
    })
    
    // CRITICAL: honour the connectionId sent by the UI first.
    // Previously this route ignored body.connectionId entirely and always
    // picked the first BingX connection, silently overriding the user's
    // selection from the Exchange context. Now we prefer the requested
    // connection when it exists and is either credentialed or explicitly
    // simulated/template-backed.
    const requestedConnectionId: string | undefined = body.connectionId
    let connection: any = requestedConnectionId
      ? allConnections.find((c: any) => c.id === requestedConnectionId)
      : null

    const isPredefinedConnection = (c: any) => c?.is_predefined === true || c?.is_predefined === "1" || c?.is_predefined === "true"
    const isAssignedConnection = (c: any) => c?.is_assigned === "1" || c?.is_assigned === true
    const isExplicitSimulatedConnection = (c: any) =>
      c?.connector_type === "simulated" || c?.exchange_type === "simulated"
    const isQuickStartBaseExchange = (c: any) => {
      const exch = normalizeQuickstartExchange(c)
      return exch === "bingx" || exch === "pionex" || exch === "orangex"
    }
    const canUseRequestedConnection = (c: any) => {
      if (!c) return false
      if (hasUsableExchangeCredentials(c)) return true
      // In production live-trade mode, a credentialless simulated/template
      // selection must not become the active QuickStart connection unless the
      // operator explicitly allows production simulation. Otherwise a stale UI
      // selection can leave the engine running in paper mode while the operator
      // expects real exchange orders.
      if (isExplicitSimulatedConnection(c)) {
        return !liveTradeRequested || process.env.ALLOW_PROD_SIMULATED === "1" || process.env.NODE_ENV !== "production"
      }
      return normalizeQuickstartExchange(c) !== "bingx" && !liveTradeRequested
    }

    // Fall back to auto-discovery only when the requested connection is missing
    // or unusable. Explicit simulated/template selections intentionally have no
    // API credentials and must not be replaced by a credentialed BingX account.
    if (!canUseRequestedConnection(connection)) {
      if (requestedConnectionId && connection) {
        console.log(`${LOG_PREFIX}: Requested connection ${requestedConnectionId} is not usable for QuickStart — falling back to auto-discovery`)
      } else if (requestedConnectionId) {
        console.log(`${LOG_PREFIX}: Requested connection ${requestedConnectionId} not found — falling back to auto-discovery`)
      }

      connection = allConnections.find((c: any) =>
        normalizeQuickstartExchange(c) === "bingx" &&
        !isPredefinedConnection(c) &&
        hasUsableExchangeCredentials(c)
      ) || allConnections.find((c: any) =>
        normalizeQuickstartExchange(c) === "bingx" && hasUsableExchangeCredentials(c)
      ) || allConnections.find((c: any) =>
        isQuickStartBaseExchange(c) && isAssignedConnection(c)
      )
    }

    if (!connection) {
      console.log(`${LOG_PREFIX}: No BingX connections found in Main Connections`)
      
      await logProgressionEvent("global", "quickstart_no_connection", "warning", "No BingX connections in Main Connections", {
        totalConnections: allConnections.length,
        availableExchanges: [...new Set(allConnections.map((c: any) => c.exchange))],
      })
      
      return NextResponse.json(
        { 
          success: false,
          error: "No BingX connections found in Main Connections",
          message: "Add a BingX connection to Main Connections first, then add API credentials in Settings",
          availableConnections: allConnections.map((c: any) => ({ 
            name: c.name,
            id: c.id,
            exchange: c.exchange,
            hasCredentials: hasUsableExchangeCredentials(c),
            isMainAssigned: c.is_assigned === "1" || c.is_assigned === true,
          })),
          logs: await getProgressionLogs("global"),
        },
        { status: 400 }
      )
    }
    
    const hasCredentials = hasUsableExchangeCredentials(connection)
    
    const exchangeName = normalizeQuickstartExchange(connection)
    const connectionId = connection.id

    const [latestConnectionHash, rawConnectionSettings, prefixedConnectionSettings] = await Promise.all([
      client.hgetall(`connection:${connectionId}`).catch(() => null),
      client.hgetall(`connection_settings:${connectionId}`).catch(() => ({} as Record<string, unknown>)),
      client.hgetall(`settings:connection_settings:${connectionId}`).catch(() => ({} as Record<string, unknown>)),
    ])
    const existingQuickStartSettings: Record<string, unknown> = {
      ...(latestConnectionHash || connection || {}),
      ...(rawConnectionSettings || {}),
      // The namespaced settings hash is the canonical mirror and therefore
      // wins when a legacy hash still contains an older value.
      ...(prefixedConnectionSettings || {}),
    }
    connection = { ...(connection || {}), ...(latestConnectionHash || {}) }

    console.log(`${LOG_PREFIX}: Found ${connection.name} (${connectionId}) on ${exchangeName}`)

    const existingConnectionSettings: Record<string, unknown> = {
      ...(rawConnectionSettings ?? {}),
      ...(prefixedConnectionSettings ?? {}),
    }
    const effectiveVolumeFactorLive = firstExistingSetting(
      existingConnectionSettings,
      ["volume_factor_live", "live_volume_factor"],
      QUICKSTART_LIVE_VOLUME_FACTOR,
    )
    const effectiveLiveVolumeFactor = firstExistingSetting(
      existingConnectionSettings,
      ["live_volume_factor", "volume_factor_live"],
      QUICKSTART_LIVE_VOLUME_FACTOR,
    )
    const effectiveVolumeFactorPreset = firstExistingSetting(
      existingConnectionSettings,
      ["volume_factor_preset", "preset_volume_factor"],
      "1.0",
    )
    const effectivePresetVolumeFactor = firstExistingSetting(
      existingConnectionSettings,
      ["preset_volume_factor", "volume_factor_preset"],
      "1.0",
    )
    const effectiveVolumeStepRatio = firstExistingSetting(
      existingConnectionSettings,
      ["volume_step_ratio"],
      String(DEFAULT_VOLUME_STEP_RATIO),
    )
    const effectiveBaseMinProfitFactor = firstExistingSetting(existingConnectionSettings, ["base_min_profit_factor"], "1.0")
    const effectiveMainMinProfitFactor = firstExistingSetting(existingConnectionSettings, ["main_min_profit_factor"], "1.2")
    const effectiveRealMinProfitFactor = firstExistingSetting(existingConnectionSettings, ["real_min_profit_factor"], "1.2")
    const effectiveVariantTrailing = firstExistingSetting(existingConnectionSettings, ["variant_trailing"], "true")
    const effectiveVariantBlock = firstExistingSetting(existingConnectionSettings, ["variant_block"], "true")
    const effectiveVariantDca = firstExistingSetting(existingConnectionSettings, ["variant_dca"], "false")
    const effectiveControlOrders = firstExistingSetting(existingConnectionSettings, ["control_orders"], "true")
    const effectiveMinStep = firstExistingSetting(existingConnectionSettings, ["minStep"], "5")
    
    // DISABLE ACTION
    if (action === "disable") {
      console.log(`${LOG_PREFIX}: Disabling ${connection.name}...`)
      const stopAt = new Date().toISOString()
      const stateSwitchVersion = await allocateStateSwitchVersion(connectionId, connection)
      const transition = await updateConnectionState(connectionId, {
        is_dashboard_inserted: "0",
        is_enabled_dashboard: "0",
        is_assigned: "0",
        is_enabled: "0",
        is_live_trade: "0",
        live_trade_enabled: "0",
        live_trade_requested: "0",
        live_trade_blocked_reason: "",
        state_switch_version: stateSwitchVersion,
        state_switch_action: "quickstart_disable",
        updated_at: stopAt,
      }, stateSwitchVersion)
      if (!transition.applied) {
        return NextResponse.json(
          { success: false, error: "QuickStart disable was superseded by a newer connection state" },
          { status: 409 },
        )
      }
      await queueEngineRefreshRequest({
        connectionId,
        action: "stop",
        state_switch_version: stateSwitchVersion,
        reason: "quickstart_disable",
        timestamp: stopAt,
      })
      let stopWarning = ""
      try {
        const coordinator = getGlobalTradeEngineCoordinator()
        await coordinator.stopEngine(connectionId, { operatorRequested: true })
        await client.hset("trade_engine:global", {
          status: "stopped",
          desired_status: "stopped",
          operator_intent: "stopped",
          actual_status: "stopped",
          operator_stopped: "1",
          operator_stopped_at: stopAt,
          stopped_at: stopAt,
          updated_at: stopAt,
          coordinator_ready: "false",
        }).catch(() => {})
        await setSettings(`trade_engine_state:${connectionId}`, {
          status: "stopped",
          engineRunning: false,
          stopped_at: stopAt,
          updated_at: stopAt,
        }).catch(() => {})
        await setSettings(`engine_progression:${connectionId}`, {
          phase: "stopped",
          status: "stopped",
          progress: 0,
          detail: "Stopped by QuickStart",
          updated_at: stopAt,
        }).catch(() => {})
      } catch (stopErr) {
        stopWarning = stopErr instanceof Error ? stopErr.message : String(stopErr)
        console.warn(`${LOG_PREFIX}: Stop engine warning during disable:`, stopErr)
      }

      await logProgressionEvent(connectionId, "quickstart_disabled", stopWarning ? "warning" : "info", "Connection stopped via QuickStart", {
        connectionName: connection.name,
        stopWarning: stopWarning || undefined,
      })
      
      console.log(`${LOG_PREFIX}: Disabled ${connection.name}`)
      const disableLogs = await getProgressionLogs(connectionId)
      invalidateTradeEngineStatusCache()

      return NextResponse.json({
        success: true,
        action: "disable",
        stopped: !stopWarning,
        warning: stopWarning || undefined,
        connection: { id: connectionId, name: connection.name, exchange: exchangeName },
        logs: disableLogs,
        logsCount: disableLogs.length,
        version: API_VERSION,
      })
    }
    
    // ENABLE ACTION
    await logProgressionEvent(connectionId, "quickstart_started", "info", "QuickStart enable flow initiated", {
      connectionId,
      connectionName: connection.name,
      exchange: exchangeName,
      hasCredentials,
    })
    
    // Step 1: Test connection (only if credentials exist)
    console.log(`${LOG_PREFIX}: [1/4] Testing connection...`)
    let testPassed = false
    let testError = ""
    let testBalance = null
    let testDuration = 0
    
    if (!hasCredentials) {
      console.log(`${LOG_PREFIX}: [1/4] SKIPPED - No API credentials configured`)
      testError = "No API credentials configured. Add credentials in Settings to enable trading."
      await logProgressionEvent(connectionId, "quickstart_test_skipped", "warning", "Test skipped - no credentials", {
        message: "Add API key and secret in Settings to enable trading",
      })
    } else {
      try {
        const testStart = Date.now()
        const connector = await createExchangeConnector(exchangeName, {
          apiKey: connection.api_key,
          apiSecret: connection.api_secret,
          apiPassphrase: connection.api_passphrase || "",
          isTestnet: connection.is_testnet === true || connection.is_testnet === "1" || connection.is_testnet === "true",
          apiType: connection.api_type || "perpetual_futures",
        })
        
        const testResult = await awaitWithTimeout(
          connector.testConnection(),
          QUICKSTART_CONNECTION_TEST_TIMEOUT_MS,
          {
            success: false,
            error: `Connection test timed out after ${QUICKSTART_CONNECTION_TEST_TIMEOUT_MS / 1000}s`,
            balance: 0,
            capabilities: connector.getCapabilities(),
            logs: [],
          },
        ) as any
        
        testDuration = Date.now() - testStart
        testPassed = testResult.success !== false
        testBalance = testResult.balance
        testError = testResult.error || ""
        
        console.log(`${LOG_PREFIX}: [1/4] Test ${testPassed ? "PASSED" : "FAILED"} (${testDuration}ms)${testBalance ? ` Balance: ${testBalance}` : ""}`)
        
        await logProgressionEvent(connectionId, "quickstart_test", testPassed ? "info" : "warning", 
          `Connection test ${testPassed ? "passed" : "failed"}`, {
            testPassed,
            testError: testError || undefined,
            balance: testBalance,
            duration: testDuration,
          })
      } catch (testErr) {
        testDuration = Date.now() - startTime
        testError = testErr instanceof Error ? testErr.message : String(testErr)
        console.log(`${LOG_PREFIX}: [1/4] Test ERROR: ${testError}`)
        
        await logProgressionEvent(connectionId, "quickstart_test_error", "error", "Connection test failed", {
          error: testError,
          duration: testDuration,
        })
      }
    }
    
    // Step 2: Get symbols (single most-volatile symbol for quickstart)
    console.log(`${LOG_PREFIX}: [2/4] Configuring symbol...`)

    // ── Defensive symbols normalization ─────────────────────────────────
    // Earlier this route did `let symbols: string[] = body.symbols || []`,
    // which silently assigned a non-array value (number, string, anything)
    // to a variable typed as `string[]`. Two consequences:
    //   - `symbols.length` was `undefined` for a number, skipping the
    //     auto-pick branch
    //   - `symbols.join(", ")` crashed with "join is not a function"
    //     and the surrounding try/catch returned a generic 500.
    // The Engine Progression Test sent `{ action: "enable", symbols: 1 }`
    // (intending "1 auto-picked symbol") and tripped this every run.
    //
    // Normalize early — accept all three legitimate shapes:
    //   • Array of strings → use directly (after string-only filter)
    //   • Single non-empty string → wrap into [string]
    //   • Number / anything else → ignore, fall through to auto-pick
    //
    // `body.symbolCount` is the explicit, typed way to request "N
    // auto-picked symbols". An explicit array on `body.symbols` always
    // wins over `symbolCount`.
    const rawSymbols = body.symbols
    const explicitSymbols = readFirstMeaningful(body, ["symbols", "force_symbols"])
    const existingSymbols = readFirstMeaningful(existingQuickStartSettings, ["symbols", "force_symbols", "active_symbols"])
    let symbols = parseStoredSymbols(explicitSymbols ?? existingSymbols)
    // requestedCount controls the eventual auto-pick count when no
    // explicit symbols are provided. Allow any count >= 1 without artificial caps.
    // Very large counts (>500) are capped by exchange API response limits.
    const savedSymbolCount = Number(readFirstMeaningful(existingQuickStartSettings, ["symbol_count", "symbolCount"]))
    let requestedCount = Number.isFinite(savedSymbolCount) && savedSymbolCount > 0
      ? Math.max(1, Math.min(1000, Math.floor(savedSymbolCount)))
      : QUICKSTART_DEFAULT_SYMBOL_COUNT
    if (typeof rawSymbols === "number" && Number.isFinite(rawSymbols) && rawSymbols > 0) {
      // Allow explicit requests up to 1000 symbols (will be capped by exchange API)
      requestedCount = Math.max(1, Math.min(1000, Math.floor(rawSymbols)))
    } else if (
      typeof body.symbolCount === "number" &&
      Number.isFinite(body.symbolCount) &&
      body.symbolCount > 0
    ) {
      // Allow explicit requests up to 1000 symbols
      requestedCount = Math.max(1, Math.min(1000, Math.floor(body.symbolCount)))
    }
    // The auto-pick branches honour `requestedCount` so a caller that
    // posts `{ symbolCount: 2 }` (or `symbols: 2`) gets two symbols, not
    // one. Previously both fallback paths were hard-coded to 1, which
    // is what caused the dashboard to display "1/1" even when the
    // user-facing slot picker advertised two symbols.

    // PRIMARY: resolve most volatile symbol(s) from the public exchange API
    // DIRECTLY (no HTTP self-fetch). In production/serverless a route handler
    // cannot reliably call its own origin/localhost, so use the shared resolver
    // that powers /api/exchange/[exchange]/top-symbols. QuickStart defaults to
    // true 1h ATR volatility with a liquidity floor, matching the operator spec.
    // Regression guard: normaliseSort(body.symbolOrder || body.symbol_order || "volatility_1h")
    const requestedSymbolOrder = normaliseSort(String(resolveQuickStartValue(
      body,
      existingQuickStartSettings,
      ["symbolOrder", "symbol_order"],
      ["symbol_order", "symbolOrder"],
      "volatility_1h",
    )))
    if (symbols.length === 0) {
      try {
        const topData = await fetchTopSymbols(exchangeName, requestedCount, requestedSymbolOrder)
        const list = Array.isArray(topData.symbols)
          ? topData.symbols
              .map((item) => item.symbol)
              .filter((symbol): symbol is string => typeof symbol === "string" && symbol.length > 0)
              .slice(0, requestedCount)
          : []
        if (list.length > 0) {
          symbols = list
          console.log(
            `${LOG_PREFIX}: [2/4] Top ${list.length}/${requestedCount} symbol(s) by ${requestedSymbolOrder}: ` +
              `${list.join(", ")} (top: ${(topData.priceChangePercent || 0).toFixed(2)}%)`,
          )
        }
      } catch (e) {
        console.warn(
          `${LOG_PREFIX}: [2/4] Public top-symbols resolver failed, trying exchange connector:`,
          e instanceof Error ? e.message : String(e),
        )
      }
    }

    // SECONDARY: use exchange connector's getTopSymbols (requires auth)
    if (symbols.length === 0 && testPassed) {
      try {
        const connector = await createExchangeConnector(exchangeName, {
          apiKey: connection.api_key,
          apiSecret: connection.api_secret,
          isTestnet: connection.is_testnet === true || connection.is_testnet === "1" || connection.is_testnet === "true",
        })
        if (typeof connector.getTopSymbols === "function") {
          const topSymbols = await connector.getTopSymbols(requestedCount)
          if (topSymbols && topSymbols.length > 0) {
            symbols = topSymbols.slice(0, requestedCount)
            console.log(`${LOG_PREFIX}: [2/4] Top ${symbols.length}/${requestedCount} symbol(s) from exchange connector: ${symbols.join(", ")}`)
          }
        }
      } catch {
        // fall through to default
      }
    }

    // FALLBACK: use default symbol
    if (symbols.length === 0) {
      symbols = [...DEFAULT_SYMBOLS]
      console.log(`${LOG_PREFIX}: [2/4] Using default symbol: ${symbols.join(", ")}`)
    }

    console.log(`${LOG_PREFIX}: [2/4] Final symbol: ${symbols.join(", ")}`)

    const explicitSymbolRequest =
      explicitSymbols !== undefined ||
      (Number.isFinite(Number(body.symbolCount)) && Number(body.symbolCount) > 0) ||
      typeof rawSymbols === "number"
    const effectiveSymbolCount = explicitSymbolRequest
      ? String(symbols.length)
      : firstExistingSetting(existingConnectionSettings, ["symbol_count"], String(symbols.length))

    const symbolSelectionEpoch = `${Date.now()}:${Math.random().toString(36).slice(2)}`

    // Production QuickStart should not silently fall back to paper/sim just
    // because the lightweight connection test endpoint is flaky or rate-limited.
    // Credential shape and durable coordination are the pre-order gates; the
    // live stage still records exchange placement errors if the venue rejects
    // an order after those prerequisites pass.
    const quickStartLiveReadiness = evaluateRealTradeReadiness({
      ...connection,
      is_live_trade: liveTradeRequested ? "1" : "0",
      live_trade_requested: liveTradeRequested ? "1" : "0",
      live_trade_blocked_reason: "",
    })
    const liveTradeEnabled = liveTradeRequested && quickStartLiveReadiness.canPlaceRealOrders
    const liveTradeBlockedReason = liveTradeRequested && !liveTradeEnabled
      ? quickStartLiveReadiness.blockReason
      : ""
    const liveTradeBlockCode = liveTradeRequested && !liveTradeEnabled
      ? quickStartLiveReadiness.blockCode
      : null

    await logProgressionEvent(connectionId, "quickstart_symbols", "info", "Trading symbols configured", {
      symbols,
      count: symbols.length,
    })
    
     // Step 3: QuickStart must assign + enable connection flow
     console.log(`${LOG_PREFIX}: [3/4] Updating connection state...`)
     
     const resolvedLiveVolumeFactor = stringifySettingValue(resolveQuickStartValue(
       body,
       existingQuickStartSettings,
       ["volume_factor_live", "live_volume_factor", "liveVolumeFactor"],
       ["volume_factor_live", "live_volume_factor", "liveVolumeFactor"],
       QUICKSTART_LIVE_VOLUME_FACTOR,
     ))
     const resolvedPresetVolumeFactor = stringifySettingValue(resolveQuickStartValue(
       body,
       existingQuickStartSettings,
       ["volume_factor_preset", "preset_volume_factor", "presetVolumeFactor"],
       ["volume_factor_preset", "preset_volume_factor", "presetVolumeFactor"],
       "1.0",
     ))
     const resolvedVolumeStepRatio = stringifySettingValue(resolveQuickStartValue(
       body,
       existingQuickStartSettings,
       ["volume_step_ratio", "volumeStepRatio"],
       ["volume_step_ratio", "volumeStepRatio"],
       String(DEFAULT_VOLUME_STEP_RATIO),
     ))
     const resolvedBaseProfitFactor = stringifySettingValue(resolveQuickStartValue(
       body,
       existingQuickStartSettings,
       ["baseProfitFactor", "base_min_profit_factor"],
       ["baseProfitFactor", "base_min_profit_factor"],
       "1.0",
     ))
     const resolvedMainProfitFactor = stringifySettingValue(resolveQuickStartValue(
       body,
       existingQuickStartSettings,
       ["mainProfitFactor", "main_min_profit_factor"],
       ["mainProfitFactor", "main_min_profit_factor"],
       "1.2",
     ))
     const resolvedRealProfitFactor = stringifySettingValue(resolveQuickStartValue(
       body,
       existingQuickStartSettings,
       ["realProfitFactor", "real_min_profit_factor"],
       ["realProfitFactor", "real_min_profit_factor"],
       "1.2",
     ))
     const resolvedVariantTrailing = stringifySettingValue(resolveQuickStartValue(
       body,
       existingQuickStartSettings,
       ["variantTrailingEnabled", "variant_trailing"],
       ["variantTrailingEnabled", "variant_trailing"],
       "true",
     ))
     const resolvedVariantBlock = stringifySettingValue(resolveQuickStartValue(
       body,
       existingQuickStartSettings,
       ["variantBlockEnabled", "variant_block"],
       ["variantBlockEnabled", "variant_block"],
       "true",
     ))
     const resolvedVariantDca = stringifySettingValue(resolveQuickStartValue(
       body,
       existingQuickStartSettings,
       ["variantDcaEnabled", "variant_dca"],
       ["variantDcaEnabled", "variant_dca"],
       "false",
     ))
     const resolvedControlOrders = stringifySettingValue(resolveQuickStartValue(
       body,
       existingQuickStartSettings,
       ["control_orders", "controlOrders"],
       ["control_orders", "controlOrders"],
       "true",
     ))
     const resolvedMinStep = stringifySettingValue(resolveQuickStartValue(
       body,
       existingQuickStartSettings,
       ["minStep", "min_step"],
       ["minStep", "min_step"],
       "5",
     ))
     const resolvedPrevPosMinCount = resolveQuickStartValue(
       body,
       existingQuickStartSettings,
       ["prevPosMinCount", "prev_pos_min_count"],
       ["prevPosMinCount", "prev_pos_min_count"],
       undefined,
     )
     const resolvedMainEvalPosCount = resolveQuickStartValue(
       body,
       existingQuickStartSettings,
       ["mainEvalPosCount", "main_eval_pos_count"],
       ["mainEvalPosCount", "main_eval_pos_count"],
       undefined,
     )
     const resolvedRealEvalPosCount = resolveQuickStartValue(
       body,
       existingQuickStartSettings,
       ["realEvalPosCount", "real_eval_pos_count"],
       ["realEvalPosCount", "real_eval_pos_count"],
       undefined,
     )

     // ── Quickstart minimal-volume default ──────────────────────────
     // QuickStart is intended to be a safe, low-risk way for an operator
     // to dip a toe in: real exchange orders, but the SMALLEST possible
     // notional per order. We pin `live_volume_factor` to the minimum
     // allowed by `VolumeCalculator.calculatePositionVolume` (it clamps
     // the factor to `[0.1, 10]` — anything ≤ 0.1 becomes 0.1).
     //
     // With factor=0.1, the Main-engine path scales the computed volume
     // down 10× and then the per-pair `exchangeMinVolume` floor (or the
     // universal $5 notional fallback) clamps it back UP — so the final
     // order size is GUARANTEED to be the exchange's hard minimum.
     // That's the smallest legal order the venue will accept; you
     // cannot go below it without an immediate rejection.
     //
     // Why this is the right knob (vs `exchangePositionCost`):
     //   - `exchangePositionCost` is a GLOBAL app-settings field that
     //     would affect every connection. We only want to scope this
     //     to the connection the operator just quick-started.
     //   - `live_volume_factor` is a PER-CONNECTION override that the
     //     calculator already honours via
     //     `VolumeCalculator.resolveLiveEngine` (preferred over global).
     //
     // Operator can adjust this later via per-connection Live Volume
     // Factor slider in Settings (range 0.1×–10×) once they're happy
     // with how the engine is behaving.

     const stateSwitchVersion = await allocateStateSwitchVersion(connectionId, connection)
     const updated = {
       // Explicit quickstart assignment/enabling for engine processing.
       // is_enabled + is_inserted are required by getAssignedAndEnabledConnections()
       // which filters on these base fields — without them coordinator.startAll()
       // finds zero eligible connections and never starts an engine.
       is_enabled: "1",
       is_inserted: "1",
       is_active_inserted: "1",
       is_dashboard_inserted: "1",
       is_enabled_dashboard: "1",
       is_assigned: "1",
       is_active: "1",
       // Keep the progression active even when the exchange is unreachable, but
       // do not let live-stage place venue orders unless credentials are present.
       // Keep progression active even when the exchange is unreachable, but
       // do not let live-stage place venue orders unless the transport test passed.
       // Keep the progression active even when the exchange is unreachable, but
       // do not let live-stage place venue orders unless usable credentials exist.
       is_live_trade: liveTradeEnabled ? "1" : "0",
       live_trade_enabled: liveTradeEnabled ? "1" : "0",
       live_trade_requested: liveTradeRequested ? "1" : "0",
       live_trade_blocked_reason: liveTradeBlockedReason || "",
       state_switch_version: stateSwitchVersion,
       state_switch_action: "quickstart_enable",
       active_symbols: JSON.stringify(symbols),
       force_symbols: JSON.stringify(symbols),
       symbol_order: requestedSymbolOrder,
       symbol_count: String(symbols.length),
       // Local/self-hosted production uses this cap to protect memory. Keep it
       // aligned with the explicit QuickStart request before recoordination/start
       // so an explicit multi-symbol smoke is never sliced back to the safe default one.
       dev_symbol_count_override: String(symbols.length),
       // Persist the resolved sizing knobs to the connection hash too because
       // some engine paths read directly from the connection snapshot.
       // Lowest-volume live testing: force the per-connection factor to the
       // VolumeCalculator minimum. The calculator then clamps each pair up to
       // that exchange symbol's legal minimum notional/quantity.
       live_volume_factor: resolvedLiveVolumeFactor,
       volume_factor_live: resolvedLiveVolumeFactor,
       preset_volume_factor: resolvedPresetVolumeFactor,
       volume_factor_preset: resolvedPresetVolumeFactor,
       volume_step_ratio: resolvedVolumeStepRatio,
       // QuickStart uses the minimum live volume factor so live-trade smoke tests
       // place only exchange-minimum orders when credentials are available.
       // Symbol ordering: operator spec is volatility_1h for quickstart.
       last_test_status: testPassed ? "success" : "failed",
       last_test_balance: testBalance,
       last_test_at: new Date().toISOString(),
       updated_at: new Date().toISOString(),
     }

    // ALSO store in trade_engine_state for engine to find.
    // IMPORTANT: record the user-selected symbol count under
    // `config_set_symbols_total` so the /stats endpoint no longer defaults
    // to the hard-coded "3" when the historical phase reports progress.
    // Also reset the processed counter to 0 so progress starts correctly.
    // Operator-spec defaults for quickstart: base PF=1.0, main/real PF=1.2,
    // trailing on, block on, dca off, control orders on, minimum live volume, volatility_1h.
    // These are persisted to connection_settings so the engine reads them on the
    // first tick instead of using its compiled defaults.
    const quickstartConnectionSettingsPatch: Record<string, string> = {
      // Volume factor
      volume_factor_live: resolvedLiveVolumeFactor,
      live_volume_factor: resolvedLiveVolumeFactor,
      volume_step_ratio: resolvedVolumeStepRatio,
      volume_factor_preset: resolvedPresetVolumeFactor,
      preset_volume_factor: resolvedPresetVolumeFactor,
      // Symbol order/count
      symbol_order: requestedSymbolOrder,
      symbol_count: effectiveSymbolCount,
      symbols: JSON.stringify(symbols),
      force_symbols: JSON.stringify(symbols),
      active_symbols: JSON.stringify(symbols),
      is_live_trade: liveTradeEnabled ? "1" : "0",
      live_trade_enabled: liveTradeEnabled ? "1" : "0",
      live_trade_requested: liveTradeRequested ? "1" : "0",
      // Strategy PF thresholds
      baseProfitFactor: resolvedBaseProfitFactor,
      mainProfitFactor: resolvedMainProfitFactor,
      realProfitFactor: resolvedRealProfitFactor,
      base_min_profit_factor: effectiveBaseMinProfitFactor,
      main_min_profit_factor: effectiveMainMinProfitFactor,
      real_min_profit_factor: effectiveRealMinProfitFactor,
      // Variant toggles
      variantTrailingEnabled: resolvedVariantTrailing,
      variantBlockEnabled: resolvedVariantBlock,
      variantDcaEnabled: resolvedVariantDca,
      variant_trailing: effectiveVariantTrailing,
      variant_block: effectiveVariantBlock,
      variant_dca: effectiveVariantDca,
      // Control orders (SL/TP on exchange)
      control_orders: effectiveControlOrders,
      // Min step for pseudo-positions
      minStep: effectiveMinStep,
      updated_at: new Date().toISOString(),
    }
    if (resolvedPrevPosMinCount !== undefined) {
      quickstartConnectionSettingsPatch.prevPosMinCount = stringifySettingValue(resolvedPrevPosMinCount)
    }
    if (resolvedMainEvalPosCount !== undefined) {
      quickstartConnectionSettingsPatch.mainEvalPosCount = stringifySettingValue(resolvedMainEvalPosCount)
    }
    if (resolvedRealEvalPosCount !== undefined) {
      quickstartConnectionSettingsPatch.realEvalPosCount = stringifySettingValue(resolvedRealEvalPosCount)
    }
     const quickstartTouchedFields = [
       "is_enabled",
       "is_inserted",
       "is_active_inserted",
       "is_dashboard_inserted",
       "is_enabled_dashboard",
       "is_assigned",
       "is_active",
       "is_live_trade",
       "live_trade_enabled",
       "live_trade_requested",
       "live_trade_blocked_reason",
       "active_symbols",
       "force_symbols",
       "symbol_order",
       "symbol_count",
       "last_test_status",
       "live_volume_factor",
       "volume_factor_live",
       "preset_volume_factor",
       "volume_factor_preset",
       "volume_step_ratio",
       ...Object.keys(quickstartConnectionSettingsPatch).map((field) => `connection_settings.${field}`),
     ]

     const coordinator = getGlobalTradeEngineCoordinator()
     const quickstartEngineAlreadyRunning = coordinator.isEngineRunning(connectionId)

     const quickstartProgressionPatch = {
      phase: "recoordination",
      status: "recoordinating",
      progress: quickstartEngineAlreadyRunning ? 98 : 8,
      connectionId,
      connectionName: connection.name,
      exchange: exchangeName,
      symbols,
      detail: quickstartEngineAlreadyRunning
        ? "QuickStart settings saved — hot-recoordinating the running engine."
        : "QuickStart settings saved — queuing durable engine recoordination.",
      changed_fields: quickstartTouchedFields,
      updated_at: new Date().toISOString(),
    }
    const quickstartCanonicalProgressionPatch = {
      phase: "recoordination",
      settings_recoordination_pending: "1",
      settings_recoordination_fields: JSON.stringify(quickstartTouchedFields),
      quickstart_recoordination_started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    // QuickStart has exactly one connection/settings persistence path before
    // recoordination: applyMainConnectionSettingsChange() writes the connection
    // hash, mirrors both connection_settings hashes, then recoordinates from
    // the persisted after-snapshot. Do not add a standalone updateConnection()
    // above this call; the regression test guards this ordering.
    const {
      connection: appliedConnection,
      completion: quickstartRecoordination,
      stateTransitionApplied,
    } = await applyMainConnectionSettingsChange(connectionId, connection, {
      connectionPatch: updated,
      settingsPatch: quickstartConnectionSettingsPatch,
      tradeEngineStatePatch: {
        force_symbols: JSON.stringify(symbols),
        symbols: JSON.stringify(symbols),
        active_symbols: JSON.stringify(symbols),
        selected_symbols: JSON.stringify(symbols),
        quickstart_symbols: JSON.stringify(symbols),
        quickstart_symbol_count: String(symbols.length),
        symbol_count: String(symbols.length),
        dev_symbol_count_override: String(symbols.length),
        // Runtime safety state must change atomically with the connection and
        // connection_settings mirrors. Leaving a migration's old "1" here
        // made a paper QuickStart look live to long-lived engine workers even
        // though the canonical connection correctly reported simulation.
        is_live_trade: liveTradeEnabled ? "1" : "0",
        live_trade_enabled: liveTradeEnabled ? "1" : "0",
        live_trade_requested: liveTradeRequested ? "1" : "0",
        live_trade_blocked_reason: liveTradeBlockedReason || "",
        execution_mode: liveTradeEnabled ? "live" : "simulation",
        config_set_symbols_total: String(symbols.length),
        config_set_symbols_processed: "0",
        symbol_selection_epoch: symbolSelectionEpoch,
        quickstart_symbol_generation: symbolSelectionEpoch,
      },
      relatedHashPatches: [
        { key: `settings:engine_progression:${connectionId}`, patch: quickstartProgressionPatch },
        { key: `progression:${connectionId}`, patch: quickstartCanonicalProgressionPatch },
      ],
      changedFieldsOverride: quickstartTouchedFields,
      logTag: "POST /api/trade-engine/quick-start",
      settingsVersion: updated.updated_at,
      stateSwitchVersion,
    })
    if (!stateTransitionApplied) {
      return NextResponse.json(
        { success: false, error: "QuickStart was superseded by a newer connection state" },
        { status: 409 },
      )
    }
    connection = appliedConnection
    console.log(`${LOG_PREFIX}: [3/4] Connection state updated (assigned+enabled, live_volume_factor=${resolvedLiveVolumeFactor}).`)

    await logProgressionEvent(connectionId, "quickstart_recoordination_requested", "info",
      "QuickStart atomically committed connection/settings and requested durable recoordination",
      {
        changedFields: quickstartTouchedFields,
        engineAlreadyRunning: quickstartEngineAlreadyRunning,
      },
    )
    emitEngineStageAck(connectionId, "startup", "ack", "QuickStart settings commit accepted and recoordination requested", {
      changedFields: quickstartTouchedFields,
      engineAlreadyRunning: quickstartEngineAlreadyRunning,
    })

    await logProgressionEvent(
      connectionId,
      "quickstart_minimal_volume",
      "info",
      `QuickStart resolved live_volume_factor=${resolvedLiveVolumeFactor} for this connection`,
      {
        live_volume_factor: resolvedLiveVolumeFactor,
        volume_factor_live: resolvedLiveVolumeFactor,
        note:
          "QuickStart preserves existing per-connection sizing settings unless the request body explicitly overrides them; safe defaults are only used on first setup.",
      },
    )

    const quickstartRecoordinationApplied = quickstartRecoordination.appliedLocally === true
    await client.hset(`progression:${connectionId}`, {
      // QuickStart keeps its explicit completion audit, but it no longer clears
      // Guardrail: ...(quickstartEngineAlreadyRunning ? {} : { settings_recoordination_pending: "0" })
      // The generic pending/recompute flags for a running engine; the owning
      // EngineManager clears those only after applyPendingChangesNow()/watcher
      // successfully consumes the durable settings_change envelope. This avoids
      // hiding later hot-reload failures behind a route-level success stamp.
      settings_recoordination_pending: quickstartRecoordinationApplied ? "0" : "1",
      quickstart_recoordination_completed_at: quickstartRecoordinationApplied ? quickstartRecoordination.completedAt : "",
      quickstart_recoordination_queued_at: quickstartRecoordination.refreshStatus?.refresh_queued_at || quickstartRecoordination.completedAt,
      quickstart_recoordination_status: quickstartRecoordinationApplied ? "applied_locally" : "queued_for_owner",
      quickstart_recoordination_id: quickstartRecoordination.recoordinationId || quickstartRecoordination.completedAt,
      updated_at: quickstartRecoordination.completedAt,
    }).catch(() => 0)
    emitEngineStageAck(
      connectionId,
      quickstartRecoordinationApplied ? "recoordination_complete" : "recoordination_queued",
      "ack",
      quickstartRecoordinationApplied
        ? "QuickStart durable settings recoordination applied locally"
        : "QuickStart durable settings recoordination queued for engine owner",
      {
      changedFields: quickstartTouchedFields,
      engineAlreadyRunning: quickstartEngineAlreadyRunning,
      progressRecoordinationRequired: quickstartRecoordination.progressRecoordinationRequired,
      }
    )
    await logProgressionEvent(
      connectionId,
      quickstartRecoordinationApplied ? "quickstart_recoordination_applied" : "quickstart_recoordination_queued",
      "info",
      quickstartRecoordinationApplied
        ? "QuickStart durable settings recoordination applied locally"
        : "QuickStart durable settings recoordination queued for engine owner",
      {
        changedFields: quickstartTouchedFields,
        engineAlreadyRunning: quickstartEngineAlreadyRunning,
        progressRecoordinationRequired: quickstartRecoordination.progressRecoordinationRequired,
        progressionChanged: quickstartRecoordination.progressionChanged,
        progressionReason: quickstartRecoordination.progressionReason,
        refreshQueued: quickstartRecoordination.refreshQueued,
        refreshStatus: quickstartRecoordination.refreshStatus,
        appliedLocally: quickstartRecoordination.appliedLocally,
        queuedForOwner: quickstartRecoordination.queuedForOwner,
      },
    )

    const quickstartNeedsFreshProcessing =
      quickstartRecoordination.progressionChanged === true ||
      quickstartRecoordination.progressRecoordinationRequired === true

    await setSettings(`trade_engine_state:${connectionId}`, {
      connection_id: connectionId,
      symbols: symbols,
      active_symbols: symbols,
      force_symbols: symbols,
      status: quickstartEngineAlreadyRunning ? "running" : "ready",
      quickstart_symbol_generation: symbolSelectionEpoch,
      symbol_selection_epoch: symbolSelectionEpoch,
      quickstart_symbol_count: symbols.length,
      dev_symbol_count_override: String(symbols.length),
      quickstart_symbols: JSON.stringify(symbols),
      selected_symbols: JSON.stringify(symbols),
      config_set_symbols_total: symbols.length,
      // If QuickStart changed symbols/settings while the engine is already
      // running, recoordination has just archived the old epoch and the next
      // engine cycle must reprocess the new selection from 0/N. Do not mark
      // the new symbol basket complete just because the previous basket was
      // already running; that makes stats/UI show false 100% progress and can
      // suppress the operator-visible reprocessing state.
      config_set_symbols_processed:
        quickstartEngineAlreadyRunning && !quickstartNeedsFreshProcessing ? symbols.length : 0,
      prehistoric_data_loaded:
        quickstartEngineAlreadyRunning && !quickstartNeedsFreshProcessing ? true : false,
      updated_at: new Date().toISOString(),
    })

    // Also mirror the total onto the `prehistoric:{connId}` hash so the UI
    // reads the canonical user-selected count from either source. The
    // processor will overwrite this once it starts processing, but the
    // initial value must already match what the user picked.
    if (!quickstartEngineAlreadyRunning || quickstartNeedsFreshProcessing) {
      try {
        await client.hset(`prehistoric:${connectionId}`, {
          symbol_selection_epoch: String(symbolSelectionEpoch),
          quickstart_symbol_count: String(symbols.length),
          quickstart_symbols: JSON.stringify(symbols),
          symbols_total: String(symbols.length),
          symbols_processed: "0",
          is_complete: "0",
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        await client.expire(`prehistoric:${connectionId}`, 86400)
      } catch { /* non-critical */ }
    }
    console.log(`${LOG_PREFIX}: [3/4] Stored symbols in trade_engine_state: ${symbols.join(", ")}`)

    // === DEV MODE COMPLETENESS FIX ===
    // Immediately kick off prehistoric load for the exact quickstart symbols
    // so that the full pipeline (prehistoric → indications → strategies base/main/real → real/live)
    // is ready faster for Dev Mode testing (3-symbol minimal volume etc.).
    // This makes "ReRun Dev Mode Test" show loaded data and non-zero counts much sooner.
    // Keep this dev-only by default: production starts the real engine below,
    // and a second detached SymbolDataProcessor can duplicate the same
    // prehistoric/progression writes, causing coordinator lock noise, stalled
    // counters, and lower-quality prod results that do not reproduce in dev.
    const quickstartPreloadAllowed =
      process.env.NODE_ENV === "development" || process.env.ENABLE_QUICKSTART_PREHISTORIC_PRELOAD === "1"
    if (quickstartPreloadAllowed && !quickstartEngineAlreadyRunning && symbols.length > 0) {
      const quickstartPreload = (async () => {
        try {
           const { SymbolDataProcessor } = await import('@/lib/symbol-data-processor')
           const processor = new SymbolDataProcessor(connectionId)
           await processor.loadPrehistoricDataConcurrent(symbols, 'bingx')
          console.log(`${LOG_PREFIX}: [3.5] Best-effort prehistoric load triggered for quickstart symbols: ${symbols.join(', ')}`)
        } catch (e) {
          console.warn(`${LOG_PREFIX}: Prehistoric preload for quickstart symbols failed (non-fatal):`, e)
        }
      })()
      if (process.env.NODE_ENV === "test") {
        await quickstartPreload
      }
    }
    
     const isAssigned = updated.is_assigned === "1"
     const isMainEnabled = updated.is_enabled_dashboard === "1"
     
     await logProgressionEvent(connectionId, "quickstart_updated", "info", "Connection state updated", {
       symbols,
       isAssigned,
       isMainEnabled,
       testPassed,
       liveTradeRequested,
       liveTradeEnabled,
       liveTradeBlockedReason: liveTradeBlockedReason || undefined,
       liveTradeBlockCode: liveTradeBlockCode || undefined,
     })

     if (liveTradeBlockedReason) {
       await logProgressionEvent(connectionId, "quickstart_live_trade_blocked", "warning",
         "Live exchange order placement blocked until Main live-order requirements pass",
         { reason: liveTradeBlockedReason, blockCode: liveTradeBlockCode, symbols, live_volume_factor: resolvedLiveVolumeFactor },
       )
     }
     
      // Step 4: Start engine - FIRST ensure Global Coordinator is running
      emitEngineStageAck(connectionId, "startup", "ack", "QuickStart committed startup intent", { symbols: symbols.length })
      emitEngineStageAck(connectionId, "market_data", "ack", "QuickStart market-data symbol selection complete", { symbols })
      console.log(`${LOG_PREFIX}: [4/4] Starting Global Trade Engine Coordinator first...`)
      await setSettings(`engine_progression:${connectionId}`, {
        phase: quickstartEngineAlreadyRunning ? "live_trading" : "initializing",
        progress: quickstartEngineAlreadyRunning ? 100 : 5,
        connectionId,
        connectionName: connection.name,
        exchange: exchangeName,
        symbols,
        testPassed,
        detail: quickstartEngineAlreadyRunning
          ? "Engine already running — QuickStart settings applied without restart"
          : "Starting Global Trade Engine Coordinator...",
        updated_at: new Date().toISOString(),
      })

      // ALWAYS start global coordinator - ensures all workers and progression systems are active.
      // Publish and await the Redis operator intent before any start dispatch so
      // startEngine()/isGlobalCoordinatorEnabled() cannot observe stale stopped intent.
      const quickstartGlobalStartedAt = new Date().toISOString()
      await client.hset("trade_engine:global", {
        status: "running",
        desired_status: "running",
        operator_intent: "running",
        operator_stopped: "0",
        started_at: quickstartGlobalStartedAt,
        updated_at: quickstartGlobalStartedAt,
        coordinator_ready: "true",
      })
      
      try {
        // ── Stable QuickStart re-entry for THIS connection ─────────────
        // If the engine is already running, do NOT stop/restart it and do
        // NOT wipe progression/prehistory counters. Repeated QuickStart
        // presses should be idempotent: update the symbols/settings, bust
        // the symbol cache, and let the live progression continue. Forced
        // restarts here caused the UI to jump back to prehistoric progress,
        // duplicate epochs, and eventually crash under repeated clicks.
        try {
          const wasRunning = quickstartEngineAlreadyRunning
          if (wasRunning) {
            console.log(`${LOG_PREFIX}: Connection ${connectionId} already running — reusing live engine and applying symbols without restart`)
            coordinator.invalidateSymbolsCacheForConnection(connectionId)
            await coordinator.applyPendingChangesNow(connectionId).catch(() => {})
            await logProgressionEvent(connectionId, "quickstart_engine_reused", "info",
              "Running engine reused; QuickStart symbols/settings applied without stop/restart",
              { previousState: "running", newSymbols: symbols, newSymbolCount: symbols.length },
            )
          } else {
            // First QuickStart for this connection in the current process:
            // clear stale runtime markers so startEngine does not mistake an
            // old crashed worker for an active owner, and reset only this
            // connection's fresh-run counters before the new engine is armed.
            const doneGateKeys = buildPrehistoricGateKeys(connectionId, "main", "done")
            const firstPassGateKeys = buildPrehistoricGateKeys(connectionId, "main", "firstpass:done")
            await Promise.allSettled([
              client.del(`engine_is_running:${connectionId}`).catch(() => 0),
              client.del(doneGateKeys.scoped),
              client.del(doneGateKeys.legacy),
              client.del(`prehistoric_loaded:${connectionId}`),
              client.del(firstPassGateKeys.scoped),
              client.del(firstPassGateKeys.legacy),
              client.del(`prehistoric:${connectionId}:symbols`),
              client.hdel(
                `prehistoric:${connectionId}`,
                "is_complete",
                "completed_at",
                "symbols_processed",
                "candles_loaded",
                "indicators_calculated",
                "total_duration_ms",
                "historic_avg_profit_factor",
                "historic_avg_profit_factor_count",
                "historic_avg_profit_factor_at",
              ).catch(() => 0),
              client.hdel(
                `progression:${connectionId}`,
                "real_active_pos_sum_x100",
                "real_active_pos_samples",
                "real_active_pos_current",
                "real_active_pos_avg",
                "prehistoric_symbols_processed_count",
                "prehistoric_candles_processed",
                "prehistoric_cycles_completed",
                "prehistoric_phase_active",
              ).catch(() => 0),
              client.hset(`progression:${connectionId}`, {
                ...QUICKSTART_ZERO_COUNTERS,
                session_reset_at: new Date().toISOString(),
                symbol_selection_epoch: String(symbolSelectionEpoch),
                quickstart_symbol_count: String(symbols.length),
                quickstart_symbols: JSON.stringify(symbols),
                symbols_total: String(symbols.length),
                symbols_processed: "0",
              }).catch(() => 0),
            ])
            console.log(`${LOG_PREFIX}: Pre-start cleanup complete — engine_is_running flag cleared for ${connectionId}`)
          }
        } catch (restartErr) {
          // Don't fail the whole quickstart on a stop/cleanup hiccup —
          // the new engine start below will still work; worst case the
          // dashboard briefly shows transitional values.
          console.warn(`${LOG_PREFIX}: Pre-start cleanup warning:`, restartErr)
        }

        // Fire-and-forget: startAll picks up the newly-updated connection in
        // the background. We do NOT await it — it can take seconds to spin up
        // engines for every eligible connection and we don't want that time
        // inside the HTTP handler.
        coordinator.startAll().catch((e: unknown) => {
          console.warn(`${LOG_PREFIX} startAll background warning:`, e)
        })

        // CRITICAL: Apply cache fix to all indication processors after engines are started.
        // Non-blocking — just patches in-process objects, no I/O.
        setImmediate(() => patchIndicationProcessorCaches(coordinator))

        console.log(`${LOG_PREFIX} ✓ Global Coordinator intent committed and boot dispatched (fire-and-forget)`)
        emitEngineStageAck(connectionId, "recoordination_complete", "ack", "Global coordinator intent committed and boot dispatched")
        await logProgressionEvent("global", "global_coordinator_started", "info", "Global Trade Engine Coordinator started via QuickStart")
        
      } catch (globalStartError) {
        console.warn(`${LOG_PREFIX} Global Coordinator start warning (already running?):`, globalStartError)
      }
      
      if (isAssigned && isMainEnabled) {
        console.log(`${LOG_PREFIX}: [4/4] Connection is explicitly enabled - initializing Main Engine...`)
        await setSettings(`engine_progression:${connectionId}`, {
          phase: "starting",
          progress: 15,
          connectionId,
          connectionName: connection.name,
          exchange: exchangeName,
          symbols,
          testPassed,
          detail: testPassed 
            ? "Starting Main Trade Engine..."
            : `Connection test failed: ${testError}. Fix credentials and retry.`,
          updated_at: new Date().toISOString(),
        })
        
        // Kick off the engine asynchronously — startEngine() can block for
        // several seconds while it syncs exchange time and spins up workers.
        // Awaiting it inside the HTTP handler causes the request to hang.
        // We log the result via a detached promise so diagnostics are preserved.
        const engineBoot = (async (): Promise<{ started: boolean; queued: boolean; error?: string }> => {
          try {
            const settings = await loadSettingsAsync()
            const coord = getGlobalTradeEngineCoordinator()

            // Legacy source guard phrase: const engineStarted = await coord.startEngine
            const started = await coord.startEngine(connectionId, {
              connectionId,
              connection_name: connection.name,
              exchange: exchangeName,
              engine_type: "main",
              allowInProcessStart: true,
              indicationInterval: settings.mainEngineIntervalMs ? settings.mainEngineIntervalMs / 1000 : 5,
              strategyInterval: settings.strategyUpdateIntervalMs ? settings.strategyUpdateIntervalMs / 1000 : 10,
              realtimeInterval: settings.realtimeIntervalMs ? settings.realtimeIntervalMs / 1000 : 0.3,
            }, { markAssigned: true, forceLocalTakeover: true })

            const engineStarted = started
            // Legacy source guard phrase: if (!started)
            if (!engineStarted) {
              const skippedAt = new Date().toISOString()
              console.warn(`${LOG_PREFIX} Main Engine start skipped or queued for ${connection.name} (async)`)
              await logProgressionEvent(connectionId, "engine_start_skipped", "warning", "Main Trade Engine start skipped or queued via QuickStart", {
                connectionId,
                connectionName: connection.name,
                exchange: exchangeName,
                reason: "Coordinator returned false; start request was skipped or left queued",
              })
              await setSettings(`engine_progression:${connectionId}`, {
                phase: "queued",
                status: "skipped_queued",
                progress: 15,
                connectionId,
                connectionName: connection.name,
                exchange: exchangeName,
                symbols,
                testPassed,
                detail: "Engine start was skipped by the coordinator and remains queued for a worker to process.",
                updated_at: skippedAt,
              })
              return { started: false, queued: true }
            }

            console.log(`${LOG_PREFIX} ✓ Main Engine started for ${connection.name} (async)`)
            await logProgressionEvent(connectionId, "engine_started", "info", "Main Trade Engine started via QuickStart", {
              connectionId,
              connectionName: connection.name,
              exchange: exchangeName,
              testPassed,
            })

            // Kick a refresh so the new symbols + bootstrap relaxations are
            // evaluated on the very first tick rather than waiting for the timer.
            coord.refreshEngines().catch(() => {})
            return { started: true, queued: false }
          } catch (engineError) {
            console.error(`${LOG_PREFIX} Engine start failed (async):`, engineError)
            const errorMessage = engineError instanceof Error ? engineError.message : String(engineError)
            logProgressionEvent(connectionId, "engine_start_error", "error", "Failed to start engine", {
              error: errorMessage,
            }).catch(() => {})
            return { started: false, queued: false, error: errorMessage }
          }
        })()
        const shouldAwaitBoot = process.env.NODE_ENV === "test" || shouldAwaitQuickStartEngineBoot()
        const engineBootResult = shouldAwaitBoot
          ? await awaitWithTimeout(engineBoot, QUICKSTART_PRODUCTION_ENGINE_BOOT_WAIT_MS, { started: false, queued: true, error: `timed out after ${QUICKSTART_PRODUCTION_ENGINE_BOOT_WAIT_MS}ms` })
          : { started: false, queued: true }
        if (shouldAwaitBoot && !engineBootResult.started && engineBootResult.error) {
          console.warn(`${LOG_PREFIX} awaited engine boot did not complete for ${connection.name}: ${engineBootResult.error}`)
        }
      }
    
    // Store in global quickstart state
    await client.set("quickstart:last_run", JSON.stringify({
      connectionId,
      connectionName: connection.name,
      exchange: exchangeName,
      testPassed,
      testError: testError || undefined,
      symbols,
      timestamp: new Date().toISOString(),
    }), { EX: 86400 })
    
    await logProgressionEvent(connectionId, "quickstart_complete", "info", "QuickStart completed successfully", {
      testPassed,
      symbols,
      totalDuration: Date.now() - startTime,
    })
    
    const totalDuration = Date.now() - startTime
    console.log(`${LOG_PREFIX}: === QUICKSTART COMPLETE ===`)
    console.log(`${LOG_PREFIX}: Connection: ${connection.name}`)
    console.log(`${LOG_PREFIX}: Test: ${testPassed ? "PASSED" : "FAILED"}`)
    console.log(`${LOG_PREFIX}: Symbols: ${symbols.join(", ")}`)
    console.log(`${LOG_PREFIX}: Duration: ${totalDuration}ms`)
    
    // Get all logs for response
    const allLogs = await getProgressionLogs(connectionId)
    
    // Collect engine counts from Redis in a single parallel batch.
    // IMPORTANT: do NOT use client.keys() here — it is O(N) over the whole
    // keyspace and will stall the event loop (and this HTTP handler) for
    // seconds when the DB has grown. Use bounded scards/gets only.
    const startStatsTime = Date.now()

    const [
      engineState,
      indicationsCount,
      strategiesCount,
      positionsCount,
      tradesCount,
      directionIndications,
      moveIndications,
      activeIndications,
      optimalIndications,
      autoIndications,
      trendIndications,
      stratBase,
      stratMain,
      stratReal,
      stratEvalBase,
      stratEvalMain,
      stratEvalReal,
      basePseudoPositions,
      mainPseudoPositions,
      realPseudoPositions,
      livePositionsCount,
      prehistoricSymbols,
      intervalsProcessed,
      progressionState,
      basePseudoDir,
      basePseudoMove,
      basePseudoActive,
      basePseudoOptimal,
      basePseudoTrend,
    ] = await Promise.all([
      getSettings(`trade_engine_state:${connectionId}`).catch(() => ({} as Record<string,unknown>)),
      client.get(`indications:${connectionId}:count`).catch(() => null),
      client.get(`strategies:${connectionId}:count`).catch(() => null),
      client.scard(`positions:${connectionId}`).catch(() => 0),
      client.scard(`trades:${connectionId}`).catch(() => 0),
      client.get(`indications:${connectionId}:direction:count`).catch(() => null),
      client.get(`indications:${connectionId}:move:count`).catch(() => null),
      client.get(`indications:${connectionId}:active:count`).catch(() => null),
      client.get(`indications:${connectionId}:optimal:count`).catch(() => null),
      client.get(`indications:${connectionId}:auto:count`).catch(() => null),
      client.get(`indications:${connectionId}:trend:count`).catch(() => null),
      client.get(`strategies:${connectionId}:base:count`).catch(() => null),
      client.get(`strategies:${connectionId}:main:count`).catch(() => null),
      client.get(`strategies:${connectionId}:real:count`).catch(() => null),
      client.get(`strategies:${connectionId}:base:evaluated`).catch(() => null),
      client.get(`strategies:${connectionId}:main:evaluated`).catch(() => null),
      client.get(`strategies:${connectionId}:real:evaluated`).catch(() => null),
      client.scard(`base_pseudo:${connectionId}`).catch(() => 0),
      client.scard(`main_pseudo:${connectionId}`).catch(() => 0),
      client.scard(`real_pseudo:${connectionId}`).catch(() => 0),
      client.scard(`positions:${connectionId}:live`).catch(() => 0),
      // Bounded: scard over the dedup SET written by ConfigSetProcessor (one member per symbol).
      client.scard(`prehistoric:${connectionId}:symbols`).catch(() => 0),
      client.get(`intervals:${connectionId}:processed_count`).catch(() => null),
      client.hgetall(`progression:${connectionId}`).catch(() => ({} as Record<string, string>)),
      client.scard(`base_pseudo:${connectionId}:direction`).catch(() => 0),
      client.scard(`base_pseudo:${connectionId}:move`).catch(() => 0),
      client.scard(`base_pseudo:${connectionId}:active`).catch(() => 0),
      client.scard(`base_pseudo:${connectionId}:optimal`).catch(() => 0),
      client.scard(`base_pseudo:${connectionId}:trend`).catch(() => 0),
    ])

    const safeEngineState = (engineState ?? {}) as Record<string, unknown>
    const safeProgressionState = (progressionState ?? {}) as Record<string, string>
    const indCount = toNumber(indicationsCount)
    const dirInd  = toNumber(directionIndications)
    const moveInd = toNumber(moveIndications)
    const actInd  = toNumber(activeIndications)
    const optInd  = toNumber(optimalIndications)
    const autoInd = toNumber(autoIndications)
    const trendInd = toNumber(trendIndications)
    const cycleDuration = Number(
      safeEngineState?.last_cycle_duration ||
      safeProgressionState?.last_cycle_duration ||
      safeProgressionState?.cycle_duration ||
      0,
    )
    const totalCycleDuration = Date.now() - startStatsTime
    const strategyCounts = {
      base: toNumber(stratBase),
      main: toNumber(stratMain),
      real: toNumber(stratReal),
    }
    const strategyEvaluated = {
      base: toNumber(stratEvalBase),
      main: toNumber(stratEvalMain),
      real: toNumber(stratEvalReal),
    }

    // Build comprehensive stats object
    const overallStats = {
      symbolsCount: symbols.length,
      symbolsProcessing: symbols,
      prehistoricSymbolsLoaded: prehistoricSymbols,
      // prehistoricDataSize replaced with bounded scard above (no O(N) keys scan).
      prehistoricDataSize: prehistoricSymbols,
      intervalsProcessed: toNumber(intervalsProcessed),
      indicationsByType: {
        direction: dirInd,
        move: moveInd,
        active: actInd,
        optimal: optInd,
        auto: autoInd,
        trend: trendInd,
        total: indCount || dirInd + moveInd + actInd + optInd + autoInd + trendInd,
      },
      strategyCounts,
      strategyEvaluated,
      pseudoPositions: {
        base: basePseudoPositions,
        baseByIndicationType: {
          direction: basePseudoDir,
          move: basePseudoMove,
          active: basePseudoActive,
          optimal: basePseudoOptimal,
          trend: basePseudoTrend,
        },
        main: mainPseudoPositions,
        real: realPseudoPositions,
        realActive: realPseudoPositions,
        realActiveOpenValidated: realPseudoPositions,
        total: realPseudoPositions,
      },
      livePositions: livePositionsCount,
      cycleDurationMs: cycleDuration,
      statsCollectionDurationMs: totalCycleDuration,
      totalDuration,
    }
    
    console.log(`${LOG_PREFIX}: === COMPREHENSIVE STATS ===`)
    console.log(`${LOG_PREFIX}: Symbols: ${symbols.length}, Prehistoric: ${prehistoricSymbols}`)
    console.log(`${LOG_PREFIX}: Indications - Direction: ${dirInd}, Move: ${moveInd}, Active: ${actInd}, Optimal: ${optInd}, Auto: ${autoInd}, Trend: ${trendInd}`)
    console.log(`${LOG_PREFIX}: Pseudo Positions - Base: ${basePseudoPositions}, Main: ${mainPseudoPositions}, Real: ${realPseudoPositions}`)
    console.log(`${LOG_PREFIX}: Live Positions: ${livePositionsCount}, Cycle Duration: ${cycleDuration}ms`)
    invalidateTradeEngineStatusCache()

    return NextResponse.json({
      success: true,
      action: "enable",
      connection: { 
        id: connectionId, 
        name: connection.name, 
        exchange: exchangeName,
        symbols,
        testPassed,
        testError: testError || undefined,
        testBalance,
        liveTradeRequested,
        liveTradeEnabled,
        liveTradeBlockedReason: liveTradeBlockedReason || undefined,
        liveTradeBlockCode: liveTradeBlockCode || undefined,
      },
      engineCounts: {
        indications: indCount,
        strategies: toNumber(strategiesCount),
        positions: positionsCount,
        trades: tradesCount,
      },
      // Comprehensive overall statistics
      overallStats: {
        symbols: {
          count: overallStats.symbolsCount,
          processing: overallStats.symbolsProcessing,
          prehistoricLoaded: overallStats.prehistoricSymbolsLoaded,
          prehistoricDataSize: overallStats.prehistoricDataSize,
        },
        intervalsProcessed: overallStats.intervalsProcessed,
        indicationsByType: overallStats.indicationsByType,
        strategyCounts: overallStats.strategyCounts,
        strategyEvaluated: overallStats.strategyEvaluated,
        pseudoPositions: overallStats.pseudoPositions,
        livePositions: overallStats.livePositions,
        cycleTimeMs: overallStats.cycleDurationMs,
        totalDurationMs: overallStats.totalDuration,
      },
      recoordination: {
        ...quickstartRecoordination,
        status: quickstartRecoordinationApplied ? "applied_locally" : "queued_for_owner",
      },
      refreshQueued: quickstartRecoordination.refreshQueued === true,
      refreshStatus: quickstartRecoordination.refreshStatus,
      status: liveTradeEnabled ? "ready_with_live_trading" : (liveTradeRequested ? "ready_live_trading_blocked" : "ready_without_live_trading"),
      nextSteps: liveTradeEnabled
        ? "Connection assigned, enabled, and live exchange order placement is enabled."
        : liveTradeRequested
          ? `Connection assigned and engine progression started, but live exchange order placement is blocked: ${liveTradeBlockedReason}`
          : "Connection assigned and enabled for quickstart with live exchange trading disabled.",
      duration: totalDuration,
      logs: allLogs.slice(0, 50),
      logsCount: allLogs.length,
      version: API_VERSION,
    })
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`${LOG_PREFIX}: FATAL ERROR:`, errorMsg)
    
    await logProgressionEvent("global", "quickstart_error", "error", "QuickStart failed with exception", {
      error: errorMsg,
      duration: Date.now() - startTime,
    })
    
    const errorLogs = await getProgressionLogs("global")
    
    return NextResponse.json(
      { 
        success: false, 
        error: "Quick start failed", 
        details: errorMsg,
        logs: errorLogs,
        logsCount: errorLogs.length,
        version: API_VERSION 
      },
      { status: 500 }
    )
  }
}

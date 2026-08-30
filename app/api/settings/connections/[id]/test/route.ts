import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { createExchangeConnector } from "@/lib/exchange-connectors"
import { initRedis, getConnection, updateConnection, getSettings, getAllConnections } from "@/lib/redis-db"
import { testConnectionLimiter } from "@/lib/connection-rate-limiter"
import { RateLimiter } from "@/lib/rate-limiter"
import { apiErrorHandler, ApiError } from "@/lib/api-error-handler"
import { isMaskedOrEmptyConnectionSecret } from "@/lib/connection-secrets"
import { isTruthyFlag } from "@/lib/connection-state-utils"
import { normalizeExchangeId, normalizeMarketType } from "@/lib/market-types"
import {
  isForexBridgeSelected,
  isValidForexBridgeUrl,
  normalizeForexExecutionMode,
} from "@/lib/forex-market"

const TEST_TIMEOUT_MS = 30000
const MAX_RETRIES = 3
const RETRY_INTERVAL_MS = 1000

function finiteOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : undefined
}

// Deadline wrapper. Connector transports enforce their own request aborts;
// this outer deadline bounds the API response and retry contract.
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => 
        controller.signal.addEventListener('abort', () => 
          reject(new Error(`Timeout: ${label} exceeded ${timeoutMs}ms`))
        )
      ),
    ])
  } finally {
    clearTimeout(timeoutId)
  }
}

// Retry handler with configurable attempts and interval
async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = MAX_RETRIES,
  intervalMs: number = RETRY_INTERVAL_MS,
  onRetry?: (attempt: number, error: Error) => void
): Promise<T> {
  let lastError: Error | null = null
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      
      if (attempt < maxRetries) {
        onRetry?.(attempt, lastError)
        await new Promise(resolve => setTimeout(resolve, intervalMs))
      }
    }
  }
  
  throw lastError || new Error("Max retries exceeded")
}

export const dynamic = "force-dynamic"
// Three bounded exchange attempts plus retry spacing can take just over 90s on
// a degraded venue. Keep the route budget aligned with its own retry contract.
export const maxDuration = 120
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const testLog: string[] = []
  const startTime = Date.now()
  const { id } = await params

  try {
    const body = await request.json().catch(() => ({})) as Record<string, any>
    // Check rate limit using systemwide limiter (includes timeout config)
    const limitResult = await testConnectionLimiter.checkLimit(id)
    
    if (!limitResult.allowed) {
      testLog.push(`[${new Date().toISOString()}] ERROR: Rate limit exceeded`)
      return NextResponse.json(
        {
          error: "Rate limit exceeded",
          details: `Maximum 50 tests per minute. Retry after ${limitResult.retryAfter} seconds.`,
          retryAfter: limitResult.retryAfter,
          resetTime: limitResult.resetTime,
          log: testLog,
        },
        { status: 429, headers: { "Retry-After": String(limitResult.retryAfter) } }
      )
    }

    const timeoutMs = limitResult.timeoutMs || 30000
    testLog.push(`[${new Date().toISOString()}] Starting connection test for ID: ${id}`)
    testLog.push(`[${new Date().toISOString()}] Using API Type: ${body.api_type || "perpetual_futures"}`)
    testLog.push(`[${new Date().toISOString()}] Rate limit remaining: ${limitResult.remaining}`)
    testLog.push(`[${new Date().toISOString()}] Timeout: ${timeoutMs}ms`)

    // CRITICAL: Initialize Redis first and verify it's ready with timeout
    await withTimeout(initRedis(), timeoutMs / 3, "Redis initialization")
    
    // Small delay to ensure Redis client is fully initialized
    await new Promise(resolve => setTimeout(resolve, 100))

    const connection = await getConnection(id)

    if (!connection) {
      // Debug: try to get all connections to verify they exist
      const allConns = await getAllConnections()
      const availableIds = allConns.map((c: any) => c.id)
      console.log("[v0] [Test] Connection not found. Available IDs:", availableIds)
      console.log("[v0] [Test] Looking for ID:", id)
      console.log("[v0] [Test] ID exists in available IDs:", availableIds.includes(id))
      
      testLog.push(`[${new Date().toISOString()}] ERROR: Connection not found (ID: ${id})`)
      testLog.push(`[${new Date().toISOString()}] Available connection IDs: ${availableIds.join(", ")}`)
      throw new ApiError(`Connection not found with ID: ${id}`, {
        statusCode: 404,
        code: "CONNECTION_NOT_FOUND",
        details: { connectionId: id, availableIds },
        context: { operation: "test_connection" },
      })
    }

    testLog.push(`[${new Date().toISOString()}] Connection found: ${connection.name} (${connection.exchange})`)
    const normalizedExchange = normalizeExchangeId(connection.exchange)
    const isInstaForex = normalizedExchange === "instaforex" || normalizedExchange === "instafx"
    const forexExecutionMode = isInstaForex
      ? normalizeForexExecutionMode(
          body.forex_execution_mode ?? body.forexExecutionMode ?? body.execution_mode ??
          connection.forex_execution_mode ?? connection.execution_mode ?? connection.connection_method,
        )
      : "read_only"
    const bridgeSelected = isInstaForex && forexExecutionMode === "mt5_bridge" && isForexBridgeSelected({
      ...connection,
      ...body,
      forex_execution_mode: forexExecutionMode,
    })
    const marketType = isInstaForex
      ? "forex"
      : normalizeMarketType(body.market_type ?? body.asset_class ?? connection.market_type ?? connection.asset_class, normalizedExchange)
    if (marketType === "forex" && !isInstaForex) {
      throw new ApiError("Forex connections currently support InstaForex read-only data only", {
        statusCode: 400,
        code: "UNSUPPORTED_FOREX_CONNECTION",
        context: { operation: "test_connection", connectionId: id },
      })
    }

    // Validate credentials - check for placeholder/test/demo values
    const requestedApiKey = isMaskedOrEmptyConnectionSecret(body.api_key) ? "" : String(body.api_key || "")
    const requestedApiSecret = isMaskedOrEmptyConnectionSecret(body.api_secret) ? "" : String(body.api_secret || "")
    const requestedPassphrase = isMaskedOrEmptyConnectionSecret(body.api_passphrase) ? "" : String(body.api_passphrase || "")
    const accountId = String(body.account_id ?? body.login ?? connection.account_id ?? (isInstaForex ? (requestedApiKey || connection.api_key || "") : "")).trim()
    const apiKey = isInstaForex ? accountId : (requestedApiKey || connection.api_key || "")
    const apiSecret = requestedApiSecret || connection.api_secret || ""
    const requestedAccountPassword = isMaskedOrEmptyConnectionSecret(body.account_password ?? body.trader_password ?? body.mt5_password)
      ? ""
      : String(body.account_password ?? body.trader_password ?? body.mt5_password ?? "").trim()
    const accountPassword = requestedAccountPassword || String(connection.account_password ?? connection.trader_password ?? connection.mt5_password ?? "").trim()
    const bridgeUrl = String(body.bridge_url ?? body.bridgeUrl ?? connection.bridge_url ?? "").trim()
    if (bridgeSelected && (!accountPassword || !isValidForexBridgeUrl(bridgeUrl))) {
      throw new ApiError("Private InstaForex bridge requires a trader password and a valid HTTP(S) bridge URL", {
        statusCode: 400,
        code: "INCOMPLETE_FOREX_BRIDGE",
        context: { operation: "test_connection", connectionId: id },
      })
    }
    const isPredefined = connection.is_predefined === "1" || connection.is_predefined === true
    
    // Check for various placeholder patterns
    const placeholderPattern = /PLACEHOLDER|00998877|^replace_me|^sample$|^example$|^[•*]+$/i
    const isPlaceholder = isInstaForex
      ? !/^[0-9]{4,12}$/.test(accountId) || placeholderPattern.test(accountId)
      : !apiKey ||
        apiKey === "" ||
        placeholderPattern.test(apiKey) ||
        apiKey.length < 20 ||
        !apiSecret ||
        apiSecret === "" ||
        placeholderPattern.test(apiSecret) ||
        apiSecret.length < 20

    if (isPlaceholder) {
      testLog.push(`[${new Date().toISOString()}] WARNING: API credentials are missing or appear to be placeholder values`)
      testLog.push(`[${new Date().toISOString()}] ${isInstaForex ? "Please configure a numeric InstaForex account id/login before testing" : (isPredefined ? "This is a predefined template - please add your real API credentials" : "Please configure valid API credentials for this exchange before testing")}`)

      await updateConnection(id, {
        last_test_status: "warning",
        last_test_log: JSON.stringify(testLog),
        last_test_at: new Date().toISOString(),
        last_test_time: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Connection already updated above with last_test_status: "warning"

      return NextResponse.json(
        {
          error: "Credentials not configured",
          details: `This connection is using placeholder credentials. Please enter your real ${connection.exchange.toUpperCase()} API credentials in the Settings page to test the connection.`,
          log: testLog,
          duration: Date.now() - startTime,
        },
        { status: 400 }
      )
    }

    let minInterval = 200
    try {
      const settings = await getSettings("all_settings")
      minInterval = settings?.minimum_connect_interval || 200
    } catch (settingsError) {
      testLog.push(`[${new Date().toISOString()}] Using default connect interval: ${minInterval}ms`)
    }

    testLog.push(`[${new Date().toISOString()}] Minimum connect interval: ${minInterval}ms`)

    const rateLimiter = new RateLimiter(connection.exchange)
    const isBingX = normalizedExchange.includes("bingx")
    const testedConnectionMethod = isBingX
      ? "library"
      : isInstaForex ? (bridgeSelected ? "bridge" : "rest") : (body.connection_method || connection.connection_method || "rest")
    const testedConnectionLibrary = isBingX
      ? "sdk"
      : isInstaForex ? (bridgeSelected ? "mt5-bridge" : "native-http") : (body.connection_library || connection.connection_library || "native")
    const isProdVst = id === "bingx-x02"
    const requestedTestnet = body.is_testnet !== undefined
      ? isTruthyFlag(body.is_testnet)
      : isTruthyFlag(connection.is_testnet)
    const isTestnet = isInstaForex ? false : (isProdVst || requestedTestnet)
    testLog.push(`[${new Date().toISOString()}] Market: ${marketType}`)
    testLog.push(`[${new Date().toISOString()}] Environment: ${isInstaForex ? (bridgeSelected ? "private terminal bridge" : "official read-only account/quote API") : (isTestnet ? "Prod-VST authenticated demo (virtual funds)" : "Prod-Live (real funds)")}`)

    // Execute with retry system: 3 attempts with 1 second interval
    const testResult = await withRetry(
      async () => {
        return await rateLimiter.execute(async () => {
          await new Promise((resolve) => setTimeout(resolve, minInterval))

          // Use request body values (which may be edited, unsaved values) OR fall back to stored connection
          const connector = await createExchangeConnector(connection.exchange, {
            apiKey,
            apiSecret,
            apiPassphrase: requestedPassphrase || connection.api_passphrase || "",
            accountId: isInstaForex ? accountId : undefined,
            accountPassword: bridgeSelected ? accountPassword : undefined,
            accountServer: bridgeSelected ? String(body.account_server ?? body.server ?? connection.account_server ?? "").trim() || undefined : undefined,
            bridgeUrl: bridgeSelected ? bridgeUrl : undefined,
            bridgeToken: bridgeSelected
              ? (isMaskedOrEmptyConnectionSecret(body.bridge_token ?? body.bridgeToken)
                ? String(connection.bridge_token ?? "").trim() || undefined
                : String(body.bridge_token ?? body.bridgeToken ?? "").trim() || undefined)
              : undefined,
            terminalPath: bridgeSelected ? String(body.terminal_path ?? body.terminalPath ?? connection.terminal_path ?? "").trim() || undefined : undefined,
            apiBaseUrl: isInstaForex ? (body.api_base_url || connection.api_base_url) : undefined,
            quotesBaseUrl: isInstaForex ? (body.quotes_base_url || connection.quotes_base_url) : undefined,
            chartsUrl: isInstaForex ? (body.charts_url || connection.charts_url) : undefined,
            symbolSuffix: isInstaForex ? (body.symbol_suffix || connection.symbol_suffix) : undefined,
            lotSize: isInstaForex ? finiteOrUndefined(body.lot_size ?? connection.lot_size) : undefined,
            positionCostPercent: isInstaForex ? finiteOrUndefined(body.position_cost_percent ?? connection.position_cost_percent) : undefined,
            // Zero is a deliberate, valid safety-buffer/multiplier setting;
            // do not turn it into an accidental connector default with ||.
            spreadBufferPips: isInstaForex ? finiteOrUndefined(body.spread_buffer_pips ?? connection.spread_buffer_pips) : undefined,
            spreadMultiplier: isInstaForex ? finiteOrUndefined(body.spread_multiplier ?? connection.spread_multiplier) : undefined,
            positionsAverage: isInstaForex ? finiteOrUndefined(body.positions_average ?? body.average_count ?? connection.positions_average ?? connection.average_count) : undefined,
            marketType,
            isTestnet,
            apiType: isInstaForex ? "forex" : (body.api_type || connection.api_type),
            connectionMethod: testedConnectionMethod,
            connectionLibrary: testedConnectionLibrary,
            executionMode: isInstaForex ? forexExecutionMode : undefined,
            forexExecutionMode: isInstaForex ? forexExecutionMode : undefined,
            readOnly: isInstaForex ? !bridgeSelected : undefined,
          })

          const connectorResult = await withTimeout(
            connector.testConnection(),
            TEST_TIMEOUT_MS,
            "Exchange connection test",
          )
          return {
            ...connectorResult,
            fastPathStatus: (connector as any).getFastPathStatus?.(),
            environmentInfo: (connector as any).getEnvironmentInfo?.(),
          }
        })
      },
      MAX_RETRIES,
      RETRY_INTERVAL_MS,
      (attempt, error) => {
        testLog.push(`[${new Date().toISOString()}] Retry ${attempt}/${MAX_RETRIES}: ${error.message}`)
      }
    )

    const result = testResult as any

    if (!result.success) {
      throw new Error(result.error || "Connection test failed")
    }

    const duration = Date.now() - startTime
    testLog.push(`[${new Date().toISOString()}] Connection successful!`)
    const normalizedBalance = Number(result.balance)
    testLog.push(
      `[${new Date().toISOString()}] Account Balance: ${result.settlementAsset || (isInstaForex ? "account currency" : "USDT")} ${Number.isFinite(normalizedBalance) ? normalizedBalance.toFixed(4) : "0.0000"}`,
    )
    if (result.btcPrice) {
      testLog.push(`[${new Date().toISOString()}] BTC Price: $${Number(result.btcPrice).toFixed(2)}`)
    }
    const environmentInfo = result.environmentInfo || {
      environment: isTestnet ? "prod-vst" : "prod-live",
      isDemo: isTestnet,
      usesVirtualFunds: isTestnet,
    }

    const testedApiType = isInstaForex ? "forex" : (body.api_type || connection.api_type || "perpetual_futures")
    await updateConnection(id, {
      last_test_status: "success",
      last_test_balance: String(result.balance),
      last_test_settlement_asset: result.settlementAsset || (isInstaForex ? "account currency" : "USDT"),
      last_test_log: JSON.stringify(testLog),
      last_test_at: new Date().toISOString(),
      last_test_time: new Date().toISOString(),
      api_type: testedApiType,
      connection_method: testedConnectionMethod,
      connection_library: testedConnectionLibrary,
     ...(isInstaForex ? {
       account_id: accountId,
       market_type: "forex",
       asset_class: "forex",
       is_testnet: "0",
        forex_execution_mode: forexExecutionMode,
        execution_mode: forexExecutionMode,
        read_only: bridgeSelected ? "0" : "1",
        execution_supported: bridgeSelected,
        connection_method: testedConnectionMethod,
        connection_library: testedConnectionLibrary,
        ...(bridgeSelected ? {
          account_password: accountPassword,
          account_server: String(body.account_server ?? body.server ?? connection.account_server ?? "").trim() || undefined,
          bridge_url: bridgeUrl,
          bridge_token: isMaskedOrEmptyConnectionSecret(body.bridge_token ?? body.bridgeToken)
            ? connection.bridge_token
            : String(body.bridge_token ?? body.bridgeToken ?? "").trim() || undefined,
          terminal_path: String(body.terminal_path ?? body.terminalPath ?? connection.terminal_path ?? "").trim() || undefined,
        } : {
          account_password: "",
          account_server: "",
          bridge_url: "",
          bridge_token: "",
          terminal_path: "",
        }),
      } : {}),
      ...(isProdVst ? { is_testnet: "1", is_predefined: "1" } : {}),
      api_capabilities: JSON.stringify(result.capabilities || []),
      updated_at: new Date().toISOString(),
    })

    await SystemLogger.logConnection(`Connection test successful: ${connection.name}`, id, "info", {
      balance: result.balance,
      btcPrice: result.btcPrice,
      duration,
    })

    return NextResponse.json({
      success: true,
      balance: result.balance,
      btcPrice: result.btcPrice || 0,
      balances: result.balances || [],
      capabilities: result.capabilities || [],
      apiType: body.api_type || connection.api_type,
      apiSubtype: body.api_subtype || connection.api_subtype,
      exchange: connection.exchange,
      marketType,
      connectionMethod: testedConnectionMethod,
      connectionLibrary: testedConnectionLibrary,
      fastPathStatus: result.fastPathStatus || null,
      environment: environmentInfo.environment,
      baseUrl: environmentInfo.baseUrl,
      virtualFunds: environmentInfo.usesVirtualFunds === true,
      executionSupported: isInstaForex ? environmentInfo.executionSupported === true : environmentInfo.executionSupported !== false,
      readOnly: isInstaForex ? environmentInfo.executionSupported !== true : environmentInfo.executionSupported !== true,
      executionMode: environmentInfo.executionMode,
      settlementAsset: result.settlementAsset || (isInstaForex ? "account currency" : "USDT"),
      equity: result.equity,
      availableMargin: result.availableMargin,
      unrealizedProfit: result.unrealizedProfit,
      log: testLog,
      duration,
    })
  } catch (error) {
    const duration = Date.now() - startTime
    
    if (error instanceof ApiError) {
      // Already an API error, log and return
      await SystemLogger.logError(error, "api", "POST /api/settings/connections/[id]/test")
      return await apiErrorHandler.handleError(error, {
        endpoint: "/api/settings/connections/[id]/test",
        method: "POST",
        operation: "test_connection",
        severity: error.severity,
      })
    }

    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    testLog.push(`[${new Date().toISOString()}] Test failed: ${errorMessage}`)

    let userFriendlyError = errorMessage
    let isCredentialError = false
    
    if (errorMessage.includes("JSON")) {
      userFriendlyError = "API returned invalid response. Check your credentials or try again."
    } else if (errorMessage.includes("401") || errorMessage.includes("Unauthorized")) {
      userFriendlyError = "Invalid API credentials. Please verify your API key and secret."
      isCredentialError = true
    } else if (errorMessage.toLowerCase().includes("incorrect apikey") || errorMessage.toLowerCase().includes("invalid api")) {
      userFriendlyError = "Invalid API key. Please verify your API key is correct and has the required permissions."
      isCredentialError = true
    } else if (errorMessage.includes("100413") || errorMessage.includes("apiKey")) {
      userFriendlyError = "API key validation failed. Please check your API key in exchange settings."
      isCredentialError = true
    } else if (errorMessage.includes("timeout")) {
      userFriendlyError = "Connection timeout. Check your network or if the API endpoint is available."
    } else if (errorMessage.includes("ENOTFOUND") || errorMessage.includes("ERR_MODULE_NOT_FOUND")) {
      userFriendlyError = "Network error. Check your internet connection."
    } else if (errorMessage.includes("signature") || errorMessage.includes("Signature")) {
      userFriendlyError = "Invalid API signature. Please verify your API secret is correct."
      isCredentialError = true
    }

    console.error("[v0] Connection test failed:", error)
    await SystemLogger.logError(error instanceof Error ? error : new Error(String(error)), "api", "POST /api/settings/connections/[id]/test")

    // Try to update connection with error status
    try {
      const existingConnection = await getConnection(id)
      if (existingConnection) {
        await updateConnection(id, {
          last_test_status: "failed",
          last_test_log: JSON.stringify(testLog),
          last_test_at: new Date().toISOString(),
          last_test_time: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })

        // Connection already updated above with last_test_status: "error"
      }
    } catch (updateError) {
      console.error("[v0] Failed to update connection error status:", updateError)
    }

    return NextResponse.json(
      {
        success: false,
        error: isCredentialError ? "Invalid credentials" : "Connection test failed",
        details: userFriendlyError,
        isCredentialError,
        log: testLog,
        duration,
      },
      { status: isCredentialError ? 401 : 500 }
    )
  }
}

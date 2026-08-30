import { type NextRequest, NextResponse } from "next/server"
import { getAllConnections, getConnection, initRedis, createConnection } from "@/lib/redis-db"
import { generateConnectionIdFromApiKey, isApiKeyInUse } from "@/lib/connection-id-manager"
import { CONNECTION_PREDEFINITIONS } from "@/lib/connection-predefinitions"
import { API_VERSIONS } from "@/lib/system-version"
import { maskConnectionSecrets } from "@/lib/connection-secrets"
import { normalizeExchangeId, normalizeMarketType } from "@/lib/market-types"
import {
  DEFAULT_FOREX_LOT_SIZE,
  DEFAULT_FOREX_POSITIONS_AVERAGE,
  DEFAULT_FOREX_SPREAD_BUFFER_PIPS,
  DEFAULT_FOREX_SPREAD_MULTIPLIER,
  isForexBridgeSelected,
  isValidForexBridgeUrl,
  normalizeForexExecutionMode,
} from "@/lib/forex-market"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 30

const API_VERSION = API_VERSIONS.connections

function identityVolumeFactor(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(1, Math.min(10, parsed)) : 1
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true"
}

function finiteBounded(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}

export async function GET(request: NextRequest) {
  try {
    // Set explicit cache-control headers to prevent caching
    const headers = {
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
      "X-API-Version": API_VERSION,
    }
    
    const { searchParams } = new URL(request.url)
    const clientVersion = searchParams.get("v")
    const exchange = searchParams.get("exchange")
    const enabled = searchParams.get("enabled")
    const active = searchParams.get("active")

    console.log(`[v0] [API] [Connections] ${API_VERSION} - Client version: ${clientVersion}`)

    await initRedis()

    // STABILITY RULE: defaults are assigned only at startup (via /api/startup/initialize
    // and the base seeder with its persistent marker). This GET MUST NOT trigger
    // re-seeding — otherwise deleting/unassigning a base connection would re-spawn it
    // on the next poll. An empty list is a valid, respected state.
    let connections = await getAllConnections()

    if (exchange) {
      connections = connections.filter((c) => c.exchange?.toLowerCase() === exchange.toLowerCase())
    }

    // Filter by is_enabled for trade engine status (Settings connections)
    if (enabled === "true") {
      connections = connections.filter((c) => {
        // Handle both boolean and string representations
        const isEnabled = c.is_enabled === true || c.is_enabled === "1" || c.is_enabled === "true"
        return isEnabled
      })
    }

    // Filter by is_enabled_dashboard for actively using connections (INDEPENDENT from Settings)
    if (active === "true") {
      connections = connections.filter((c) => {
        // Handle both boolean and string representations
        const isEnabledDash = c.is_enabled_dashboard === true || c.is_enabled_dashboard === "1" || c.is_enabled_dashboard === "true"
        return isEnabledDash
      })
    }

    // Log what we're returning
    const bingxOnly = connections.filter(c => ["bingx"].includes((c.exchange || "").toLowerCase()))
    const inserted = connections.filter(c => c.is_inserted === "1" || c.is_inserted === true)
    const activeInserted = connections.filter(c => c.is_active_inserted === "1" || c.is_active_inserted === true)
    
    console.log(`[v0] [API] [Connections] ${API_VERSION}: Returning ${connections.length} total connections`)
    console.log(`[v0] [API] [Connections] ${API_VERSION}: BingX: ${bingxOnly.length}`)
    console.log(`[v0] [API] [Connections] ${API_VERSION}: Inserted (visible): ${inserted.map(c => c.name).join(', ')}`)
    console.log(`[v0] [API] [Connections] ${API_VERSION}: Active-inserted (in main panel): ${activeInserted.map(c => c.name).join(', ') || 'none'}`)
    console.log(`[v0] [API] [Connections] ${API_VERSION}: Enabled dashboard: ${connections.filter(c => c.is_enabled_dashboard === "1" || c.is_enabled_dashboard === true).map(c => c.name).join(', ') || 'none'}`)
    
    // SECURITY: never return raw credentials. Previous code returned every
    // connection's api_key/api_secret in PLAINTEXT to any caller.
    const safeConnections = connections.map((connection) => maskConnectionSecrets(connection))

    return NextResponse.json({ success: true, count: safeConnections.length, connections: safeConnections, version: API_VERSION }, { headers })
  } catch (error) {
    console.error(`[v0] [API] [Connections] ${API_VERSION}: Error:`, error instanceof Error ? error.message : String(error))
    return NextResponse.json({ success: false, error: "Failed to fetch connections", connections: [], version: API_VERSION }, { status: 500, headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "X-API-Version": API_VERSION,
    }})
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const normalizedExchange = normalizeExchangeId(body.exchange)
    const isInstaForex = normalizedExchange === "instaforex" || normalizedExchange === "instafx"
    const accountId = String(body.account_id ?? body.login ?? (isInstaForex ? body.api_key : "") ?? "").trim()
    const forexExecutionMode = isInstaForex
      ? normalizeForexExecutionMode(body.forex_execution_mode ?? body.execution_mode ?? body.connection_method)
      : "read_only"
    const bridgeSelected = isInstaForex && forexExecutionMode === "mt5_bridge" && isForexBridgeSelected({
      ...body,
      forex_execution_mode: forexExecutionMode,
    })
    const accountPassword = isInstaForex
      ? String(body.account_password ?? body.trader_password ?? body.mt5_password ?? "").trim()
      : ""
    const bridgeUrl = isInstaForex ? String(body.bridge_url ?? body.bridgeUrl ?? "").trim() : ""
    const effectiveApiKey = isInstaForex ? accountId : String(body.api_key ?? "").trim()
    const effectiveApiSecret = String(body.api_secret ?? "").trim()
    // Validate required fields
    if (!body.name || !body.exchange || (isInstaForex
      ? !/^[0-9]{4,12}$/.test(accountId)
      : !effectiveApiKey || !effectiveApiSecret)) {
      return NextResponse.json(
        { error: isInstaForex ? "Missing required fields: name, exchange, account_id (InstaForex login)" : "Missing required fields: name, exchange, api_key, api_secret" },
        { status: 400 }
      )
    }
    if (bridgeSelected && (!accountPassword || !isValidForexBridgeUrl(bridgeUrl))) {
      return NextResponse.json(
        { error: "Private InstaForex bridge requires a trader password and a valid HTTP(S) bridge URL" },
        { status: 400 },
      )
    }

    const marketType = isInstaForex
      ? "forex"
      : normalizeMarketType(body.market_type ?? body.asset_class, normalizedExchange)
    if (marketType === "forex" && !isInstaForex) {
      return NextResponse.json(
        { error: "Forex connections currently support InstaForex read-only data only" },
        { status: 400 },
      )
    }
    await initRedis()

    // Check if API key is already in use
    const exists = await isApiKeyInUse(normalizedExchange, effectiveApiKey)
    if (exists) {
      return NextResponse.json(
        { 
          error: "This API key is already connected",
          details: "Please remove the existing connection first or use a different API key"
        },
        { status: 409 }
      )
    }

    // Generate unique connection ID based on exchange + API key
    const connectionId = generateConnectionIdFromApiKey(normalizedExchange, effectiveApiKey)
    const isBingX = normalizedExchange.includes("bingx")
    const isProdVstTemplate = body.predefinition_id === "bingx-x02"
    const connectionMethod = isInstaForex ? (bridgeSelected ? "bridge" : "rest") : (body.connection_method || (isBingX ? "library" : "rest"))
    const connectionLibrary = isInstaForex ? (bridgeSelected ? "mt5-bridge" : "native-http") : (body.connection_library || (isBingX && connectionMethod === "library" ? "sdk" : "native"))
    const requestedSettings =
      body.connection_settings && typeof body.connection_settings === "object" && !Array.isArray(body.connection_settings)
        ? body.connection_settings
        : {}
    const liveVolumeFactor = identityVolumeFactor(
      requestedSettings.volume_factor_live ??
      requestedSettings.live_volume_factor ??
      requestedSettings.baseVolumeFactorLive,
    )
    const presetVolumeFactor = identityVolumeFactor(
      requestedSettings.volume_factor_preset ??
      requestedSettings.preset_volume_factor ??
      requestedSettings.baseVolumeFactorPreset,
    )
    const signalVolumeFactor = identityVolumeFactor(
      requestedSettings.volume_factor_signal ??
      requestedSettings.signal_volume_factor ??
      requestedSettings.baseVolumeFactorSignal,
    )

    // Create connection object with all required fields
    const connection = {
      id: connectionId,
      name: body.name,
      exchange: normalizedExchange,
      market_type: marketType,
      asset_class: marketType,
      account_id: isInstaForex ? accountId : undefined,
      account_server: isInstaForex ? (body.account_server ?? body.server ?? undefined) : undefined,
      account_password: isInstaForex && accountPassword ? accountPassword : undefined,
      bridge_url: bridgeSelected ? bridgeUrl : undefined,
      bridge_token: bridgeSelected ? String(body.bridge_token ?? body.bridgeToken ?? "").trim() || undefined : undefined,
      terminal_path: bridgeSelected ? String(body.terminal_path ?? body.terminalPath ?? "").trim() || undefined : undefined,
      api_key: effectiveApiKey,
      api_secret: isInstaForex ? "" : effectiveApiSecret,
      api_passphrase: body.api_passphrase || "",
      api_base_url: isInstaForex ? (body.api_base_url || undefined) : undefined,
      quotes_base_url: isInstaForex ? (body.quotes_base_url || undefined) : undefined,
      charts_url: isInstaForex ? (body.charts_url || undefined) : undefined,
      symbol_suffix: isInstaForex ? (body.symbol_suffix || undefined) : undefined,
      quantity_unit: isInstaForex ? "lots" : undefined,
      lot_size: isInstaForex ? finiteBounded(body.lot_size, DEFAULT_FOREX_LOT_SIZE, 1, 10_000_000) : undefined,
      position_cost_percent: isInstaForex ? finiteBounded(body.position_cost_percent, 0.1, 0.02, 1) : undefined,
      spread_buffer_pips: isInstaForex ? finiteBounded(body.spread_buffer_pips, DEFAULT_FOREX_SPREAD_BUFFER_PIPS, 0, 100) : undefined,
      spread_multiplier: isInstaForex ? finiteBounded(body.spread_multiplier, DEFAULT_FOREX_SPREAD_MULTIPLIER, 0, 20) : undefined,
      positions_average: isInstaForex ? Math.round(finiteBounded(body.positions_average ?? body.average_count, DEFAULT_FOREX_POSITIONS_AVERAGE, 1, 600)) : undefined,
      average_count: isInstaForex ? Math.round(finiteBounded(body.average_count ?? body.positions_average, DEFAULT_FOREX_POSITIONS_AVERAGE, 1, 600)) : undefined,
      spread_mode: isInstaForex ? (body.spread_mode === "configured" ? "configured" : "exchange") : undefined,
      max_spread_pips: isInstaForex ? finiteBounded(body.max_spread_pips, 3, 0, 100) : undefined,
      api_type: isInstaForex ? "forex" : (body.api_type || "perpetual_futures"),
      api_subtype: body.api_type === "unified" ? (body.api_subtype || "perpetual") : undefined,
      connection_method: connectionMethod,
      connection_library: connectionLibrary,
      margin_type: body.margin_type || "cross",
      position_mode: isInstaForex ? "one_way" : (body.position_mode || "hedge"),
      contract_type: isInstaForex ? "forex" : (body.contract_type || "usdt-perpetual"),
      is_testnet: isInstaForex ? false : (isProdVstTemplate || truthy(body.is_testnet)),
      is_enabled: body.is_enabled === true, // Settings: enabled by default for base connections
      is_inserted: true, // User-created connection is "inserted" (available for use)
      is_dashboard_inserted: false, // Not yet added to Active Connections dashboard
      is_active_inserted: false, // Not yet in Active panel
      is_enabled_dashboard: false, // Dashboard toggle OFF by default
      is_active: false, // Not actively processing
      is_predefined: false, // User-created, not predefined template
      is_live_trade: false,
      is_preset_trade: false,
      forex_execution_mode: isInstaForex ? forexExecutionMode : undefined,
      execution_mode: isInstaForex ? forexExecutionMode : undefined,
      read_only: isInstaForex ? !bridgeSelected : undefined,
      execution_supported: isInstaForex ? bridgeSelected : undefined,
      is_signal_trade: false,
      signal_trade_enabled: false,
      signal_trade_requested: false,
      // Base is an immutable coordination identity. Main/Preset/Signal have
      // their own independently persisted channel factors below.
      volume_factor: 1,
      live_volume_factor: liveVolumeFactor,
      preset_volume_factor: presetVolumeFactor,
      signal_volume_factor: signalVolumeFactor,
      connection_settings: {
        ...requestedSettings,
        baseVolumeFactor: 1,
        baseVolumeFactorLive: liveVolumeFactor,
        baseVolumeFactorPreset: presetVolumeFactor,
        baseVolumeFactorSignal: signalVolumeFactor,
        volume_factor_live: liveVolumeFactor,
        volume_factor_preset: presetVolumeFactor,
        volume_factor_signal: signalVolumeFactor,
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    // Save to Redis database
    await createConnection(connection)
    const persistedConnection = await getConnection(connectionId)
    const safePersistedConnection = persistedConnection ? maskConnectionSecrets(persistedConnection) : null
    if (!safePersistedConnection || safePersistedConnection.credentials_configured !== true) {
      throw new Error("Connection was created but credential persistence verification failed")
    }

    console.log("[v0] [API] Connection created successfully:", {
      id: connectionId,
      name: body.name,
      exchange: body.exchange,
    })

    // Auto-test the newly created connection (non-blocking)
    let testResult = null
    if (isInstaForex ? accountId : (effectiveApiKey && effectiveApiSecret)) {
      try {
        console.log("[v0] [API] Auto-testing newly created connection:", connectionId)
        const testResponse = await fetch(
          new URL(`/api/settings/connections/${connectionId}/test`, process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${process.env.PORT || "3002"}`)).toString(),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source: "creation" }),
          }
        )
        if (testResponse.ok) {
          testResult = await testResponse.json()
          console.log("[v0] [API] Auto-test result:", testResult.success ? "PASSED" : "FAILED")
        }
      } catch (testError) {
        console.log("[v0] [API] Auto-test skipped (non-blocking error):", testError instanceof Error ? testError.message : "Unknown")
      }
    }

    return NextResponse.json(
      {
        success: true,
        message: "Connection created successfully",
        id: connectionId,
        connectionId: connectionId,
        connection: safePersistedConnection,
        persistenceVerified: true,
        credentialsConfigured: true,
      autoTest: testResult ? { ran: true, success: testResult.success } : { ran: false, reason: isInstaForex ? "No InstaForex account id provided" : "No API credentials provided" },
      },
      { status: 201 }
    )
  } catch (error) {
    console.error("[v0] Error creating connection:", error instanceof Error ? error.message : String(error))
    return NextResponse.json(
      { error: "Failed to create connection", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}

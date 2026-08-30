import { NextRequest, NextResponse } from "next/server"
import { createExchangeConnector } from "@/lib/exchange-connectors"
import { normalizeExchangeId, normalizeMarketType } from "@/lib/market-types"
import { isMaskedOrEmptyConnectionSecret } from "@/lib/connection-secrets"
import {
  isForexBridgeSelected,
  isValidForexBridgeUrl,
  normalizeForexExecutionMode,
} from "@/lib/forex-market"

export const dynamic = "force-dynamic"

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true"
}

function finiteOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : undefined
}
export async function POST(request: NextRequest) {
  try {
    let body
    try {
      body = await request.json()
    } catch (parseError) {
      console.error("[v0] [Test Connection] Failed to parse request body:", parseError)
      return NextResponse.json(
        { success: false, log: ["Error: Invalid request body - expected JSON"], error: "Invalid request format" },
        { status: 200 }
      )
    }

    const { exchange, api_key, api_secret, api_passphrase, account_id, login, symbol_suffix, lot_size, position_cost_percent, spread_buffer_pips, spread_multiplier, positions_average, average_count, is_testnet, connection_library, connection_method, api_type, api_subtype, margin_type, position_mode, predefinition_id } = body
    const normalizedExchange = normalizeExchangeId(exchange)
    const isInstaForex = normalizedExchange === "instaforex" || normalizedExchange === "instafx"
    const accountId = String(account_id ?? login ?? (isInstaForex ? api_key : "") ?? "").trim()
    const forexExecutionMode = isInstaForex
      ? normalizeForexExecutionMode(body.forex_execution_mode ?? body.execution_mode ?? body.connection_method)
      : "read_only"
    const bridgeSelected = isInstaForex && forexExecutionMode === "mt5_bridge" && isForexBridgeSelected({
      ...body,
      forex_execution_mode: forexExecutionMode,
    })
    const accountPassword = isInstaForex && !isMaskedOrEmptyConnectionSecret(body.account_password ?? body.trader_password ?? body.mt5_password)
      ? String(body.account_password ?? body.trader_password ?? body.mt5_password ?? "").trim()
      : ""
    const bridgeUrl = isInstaForex ? String(body.bridge_url ?? body.bridgeUrl ?? "").trim() : ""
    if (!exchange || (isInstaForex ? !/^[0-9]{4,12}$/.test(accountId) : !api_key || !api_secret)) {
      return NextResponse.json(
        { success: false, log: [isInstaForex ? "Error: InstaForex account id is required" : "Error: API Key and Secret are required"], error: "Missing required fields" },
        { status: 200 }
      )
    }
    if (bridgeSelected && (!accountPassword || !isValidForexBridgeUrl(bridgeUrl))) {
      return NextResponse.json(
        { success: false, log: ["Error: Private InstaForex bridge requires a trader password and a valid HTTP(S) bridge URL"], error: "Incomplete private bridge configuration" },
        { status: 200 },
      )
    }
    // Only use api_subtype when api_type is "unified" (e.g. Bybit Unified Trading Account)
    const hasSubtype = api_type === "unified" && api_subtype
    const effectiveApiType = isInstaForex ? "forex" : (api_type || "futures")
    const isProdVst = predefinition_id === "bingx-x02"
    const useTestnet = isInstaForex ? false : (isProdVst || truthy(is_testnet))
    const marketType = isInstaForex
      ? "forex"
      : normalizeMarketType(body.market_type ?? body.asset_class, normalizedExchange)
    if (marketType === "forex" && !isInstaForex) {
      return NextResponse.json(
        { success: false, log: ["Error: Forex connections currently support InstaForex read-only data only"], error: "Unsupported Forex connection" },
        { status: 200 },
      )
    }
    const testedConnectionMethod = isInstaForex ? (bridgeSelected ? "bridge" : "rest") : (body.connection_method || "rest")
    const testedConnectionLibrary = isInstaForex ? (bridgeSelected ? "mt5-bridge" : "native-http") : (connection_library || "native")

    const testLog: string[] = []
    testLog.push(`[${new Date().toISOString()}] Starting connection test...`)
    testLog.push(`[${new Date().toISOString()}] Exchange: ${normalizedExchange}`)
    testLog.push(`[${new Date().toISOString()}] Market: ${marketType}`)
    testLog.push(`[${new Date().toISOString()}] API Type: ${effectiveApiType}${hasSubtype ? ` | ${api_subtype}` : ""}`)
    testLog.push(`[${new Date().toISOString()}] Connection Method: ${testedConnectionMethod}`)
    testLog.push(`[${new Date().toISOString()}] Connection Library: ${testedConnectionLibrary}`)
    if (margin_type) testLog.push(`[${new Date().toISOString()}] Margin Type: ${margin_type}`)
    if (position_mode) testLog.push(`[${new Date().toISOString()}] Position Mode: ${position_mode}`)
    testLog.push(`[${new Date().toISOString()}] Environment: ${isInstaForex ? (bridgeSelected ? "private terminal bridge" : "official read-only account/quote API") : (useTestnet ? "Prod-VST authenticated demo (virtual funds)" : "Prod-Live (real funds)")}`)
    testLog.push(`[${new Date().toISOString()}] ---`)

    try {
      testLog.push(`[${new Date().toISOString()}] Creating exchange connector with configured settings...`)
      testLog.push(`[${new Date().toISOString()}] API Type: ${effectiveApiType}${hasSubtype ? ` | Subtype: ${api_subtype}` : ""}`)
      
      const connector = await createExchangeConnector(normalizedExchange, {
        apiKey: isInstaForex ? accountId : api_key,
        apiSecret: isInstaForex ? (api_secret || "") : api_secret,
        apiPassphrase: api_passphrase || "",
        accountId: isInstaForex ? accountId : undefined,
        accountPassword: bridgeSelected ? accountPassword : undefined,
        accountServer: bridgeSelected ? String(body.account_server ?? body.server ?? "").trim() || undefined : undefined,
        bridgeUrl: bridgeSelected ? bridgeUrl : undefined,
        bridgeToken: bridgeSelected ? String(body.bridge_token ?? body.bridgeToken ?? "").trim() || undefined : undefined,
        terminalPath: bridgeSelected ? String(body.terminal_path ?? body.terminalPath ?? "").trim() || undefined : undefined,
        apiBaseUrl: isInstaForex ? body.api_base_url : undefined,
        quotesBaseUrl: isInstaForex ? body.quotes_base_url : undefined,
        chartsUrl: isInstaForex ? body.charts_url : undefined,
        symbolSuffix: isInstaForex ? symbol_suffix : undefined,
        lotSize: isInstaForex ? finiteOrUndefined(lot_size) : undefined,
        positionCostPercent: isInstaForex ? finiteOrUndefined(position_cost_percent) : undefined,
        // Keep explicit zero values: they are valid controls for a live
        // broker-spread buffer/multiplier and must not be replaced by defaults.
        spreadBufferPips: isInstaForex ? finiteOrUndefined(spread_buffer_pips) : undefined,
        spreadMultiplier: isInstaForex ? finiteOrUndefined(spread_multiplier) : undefined,
        quantityUnit: isInstaForex ? "lots" : undefined,
        positionsAverage: isInstaForex ? finiteOrUndefined(positions_average ?? average_count) : undefined,
        marketType,
        isTestnet: useTestnet,
        connectionMethod: testedConnectionMethod,
        connectionLibrary: testedConnectionLibrary,
        executionMode: isInstaForex ? forexExecutionMode : undefined,
        forexExecutionMode: isInstaForex ? forexExecutionMode : undefined,
        readOnly: isInstaForex ? !bridgeSelected : undefined,
        apiType: effectiveApiType,
        ...(hasSubtype && { apiSubtype: api_subtype }),
        ...(margin_type && { marginType: margin_type }),
        ...(position_mode && { positionMode: position_mode }),
      })

      testLog.push(`[${new Date().toISOString()}] Testing connection using ${testedConnectionMethod} method...`)
      const result = await connector.testConnection()
      const environmentInfo = (connector as any).getEnvironmentInfo?.() || {
        environment: useTestnet ? "prod-vst" : "prod-live",
        usesVirtualFunds: useTestnet,
      }

      if (result.success) {
        testLog.push(`[${new Date().toISOString()}] ✓ Connection successful`)
        testLog.push(`[${new Date().toISOString()}] Balance: ${result.settlementAsset || (isInstaForex ? "account currency" : "USDT")} ${Number(result.balance || 0).toFixed(2)}`)
        testLog.push(`[${new Date().toISOString()}] Capabilities: ${result.capabilities?.join(", ") || "N/A"}`)
        
        return NextResponse.json({ 
          success: true, 
          log: testLog, 
          balance: result.balance,
          btcPrice: result.btcPrice || 0,
          capabilities: result.capabilities,
          environment: environmentInfo.environment,
          baseUrl: environmentInfo.baseUrl,
          virtualFunds: environmentInfo.usesVirtualFunds === true,
          settlementAsset: result.settlementAsset || (isInstaForex ? "account currency" : "USDT"),
          marketType,
          executionSupported: isInstaForex ? environmentInfo.executionSupported === true : environmentInfo.executionSupported !== false,
          readOnly: isInstaForex ? environmentInfo.executionSupported !== true : environmentInfo.executionSupported !== true,
          executionMode: environmentInfo.executionMode,
          equity: result.equity,
          availableMargin: result.availableMargin,
          unrealizedProfit: result.unrealizedProfit,
        })
      } else {
        testLog.push(`[${new Date().toISOString()}] ✗ Connection failed`)
        testLog.push(`[${new Date().toISOString()}] Error: ${result.error || "Unknown error"}`)
        
        return NextResponse.json(
          { 
            success: false, 
            log: testLog,
            error: result.error || "Connection test failed"
          }, 
          { status: 200 }
        )
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error"
      testLog.push(`[${new Date().toISOString()}] ✗ Error: ${errorMsg}`)
      
      return NextResponse.json(
        { 
          success: false, 
          log: testLog,
          error: errorMsg
        }, 
        { status: 200 }
      )
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Invalid request"
    console.error("[v0] [Test Connection] Unexpected error:", errorMsg)
    return NextResponse.json(
      { 
        success: false, 
        log: [`Error: ${errorMsg}`],
        error: errorMsg
      },
      { status: 200 }
    )
  }
}

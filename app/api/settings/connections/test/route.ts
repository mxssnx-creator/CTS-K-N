import { NextRequest, NextResponse } from "next/server"
import { createExchangeConnector } from "@/lib/exchange-connectors"

export const dynamic = "force-dynamic"

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true"
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

    const { exchange, api_key, api_secret, api_passphrase, is_testnet, connection_method, connection_library, api_type, api_subtype, margin_type, position_mode, predefinition_id } = body

    if (!exchange || !api_key || !api_secret) {
      return NextResponse.json(
        { success: false, log: ["Error: API Key and Secret are required"], error: "Missing required fields" },
        { status: 200 }
      )
    }

    // Only use api_subtype when api_type is "unified" (e.g. Bybit Unified Trading Account)
    const hasSubtype = api_type === "unified" && api_subtype
    const effectiveApiType = api_type || "futures"
    const isProdVst = predefinition_id === "bingx-x02"
    const useTestnet = isProdVst || truthy(is_testnet)

    const testLog: string[] = []
    testLog.push(`[${new Date().toISOString()}] Starting connection test...`)
    testLog.push(`[${new Date().toISOString()}] Exchange: ${exchange}`)
    testLog.push(`[${new Date().toISOString()}] API Type: ${effectiveApiType}${hasSubtype ? ` | ${api_subtype}` : ""}`)
    testLog.push(`[${new Date().toISOString()}] Connection Method: ${connection_method || "rest"}`)
    testLog.push(`[${new Date().toISOString()}] Connection Library: ${connection_library || "native"}`)
    if (margin_type) testLog.push(`[${new Date().toISOString()}] Margin Type: ${margin_type}`)
    if (position_mode) testLog.push(`[${new Date().toISOString()}] Position Mode: ${position_mode}`)
    testLog.push(`[${new Date().toISOString()}] Environment: ${useTestnet ? "Prod-VST authenticated demo (virtual funds)" : "Prod-Live (real funds)"}`)
    testLog.push(`[${new Date().toISOString()}] ---`)

    try {
      testLog.push(`[${new Date().toISOString()}] Creating exchange connector with configured settings...`)
      testLog.push(`[${new Date().toISOString()}] API Type: ${effectiveApiType}${hasSubtype ? ` | Subtype: ${api_subtype}` : ""}`)
      
      const connector = await createExchangeConnector(exchange, {
        apiKey: api_key,
        apiSecret: api_secret,
        apiPassphrase: api_passphrase || "",
        isTestnet: useTestnet,
        connectionMethod: connection_method || "rest",
        connectionLibrary: connection_library || "native",
        apiType: effectiveApiType,
        ...(hasSubtype && { apiSubtype: api_subtype }),
        ...(margin_type && { marginType: margin_type }),
        ...(position_mode && { positionMode: position_mode }),
      })

      testLog.push(`[${new Date().toISOString()}] Testing connection using ${connection_method || "rest"} method...`)
      const result = await connector.testConnection()
      const environmentInfo = (connector as any).getEnvironmentInfo?.() || {
        environment: useTestnet ? "prod-vst" : "prod-live",
        usesVirtualFunds: useTestnet,
      }

      if (result.success) {
        testLog.push(`[${new Date().toISOString()}] ✓ Connection successful`)
        testLog.push(`[${new Date().toISOString()}] Balance: $${Number(result.balance || 0).toFixed(2)}`)
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
          settlementAsset: result.settlementAsset || "USDT",
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

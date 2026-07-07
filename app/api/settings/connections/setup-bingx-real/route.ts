import { NextRequest, NextResponse } from "next/server"
import { initRedis, getConnection, updateConnection } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { ensureDefaultExchangesExist } from "@/lib/default-exchanges-seeder"

export const dynamic = "force-dynamic"

/**
 * POST /api/settings/connections/setup-bingx-real
 * 
 * Sets up real BingX credentials for the bingx-x01 connection.
 * This endpoint accepts API key and secret and stores them securely.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { apiKey, apiSecret, apiPassphrase } = body

    if (!apiKey || !apiSecret) {
      return NextResponse.json(
        { success: false, error: "API key and secret are required" },
        { status: 400 }
      )
    }

    if (apiKey.length < 20 || apiSecret.length < 20) {
      return NextResponse.json(
        { success: false, error: "API key and secret must be at least 20 characters" },
        { status: 400 }
      )
    }

    await initRedis()
    await ensureDefaultExchangesExist()

    // Get the BingX connection
    const bingxConnection = await getConnection("bingx-x01")

    if (!bingxConnection) {
      console.log("[v0] [BingX Setup] BingX connection not found, creating it...")
      return NextResponse.json(
        { success: false, error: "BingX connection not found. Please initialize connections first." },
        { status: 404 }
      )
    }

    console.log(`[v0] [BingX Setup] Updating BingX connection with real credentials...`)

    // Update the connection with real credentials
    const updatedConnection = {
      ...bingxConnection,
      api_key: apiKey,
      api_secret: apiSecret,
      api_passphrase: apiPassphrase || "",
      is_testnet: false, // Always mainnet
      updated_at: new Date().toISOString(),
    }

    await updateConnection("bingx-x01", updatedConnection)

    console.log(`[v0] [BingX Setup] ✓ BingX connection updated with real credentials`)
    console.log(`[v0] [BingX Setup] API Key: ${apiKey.substring(0, 10)}...${apiKey.substring(apiKey.length - 10)}`)

    // Log the setup event
    await logProgressionEvent("bingx-x01", "credentials_set", "info", "Real credentials configured for BingX", {
      apiKeyLength: apiKey.length,
      apiSecretLength: apiSecret.length,
      testnet: false,
    })

    return NextResponse.json({
      success: true,
      message: "BingX connection updated with real credentials",
      connection: {
        id: updatedConnection.id,
        name: updatedConnection.name,
        exchange: updatedConnection.exchange,
        api_key_preview: `${apiKey.substring(0, 10)}...${apiKey.substring(apiKey.length - 10)}`,
        api_secret_length: apiSecret.length,
        is_testnet: false,
        updated_at: updatedConnection.updated_at,
      },
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error("[v0] [BingX Setup] Error:", errorMessage)
    
    await logProgressionEvent("bingx-x01", "credentials_error", "error", `Failed to set credentials: ${errorMessage}`, {})

    return NextResponse.json(
      { success: false, error: "Failed to set BingX credentials", details: errorMessage },
      { status: 500 }
    )
  }
}

/**
 * GET /api/settings/connections/setup-bingx-real
 * 
 * Check if BingX has valid credentials configured
 */
export async function GET(request: NextRequest) {
  try {
    await initRedis()
    await ensureDefaultExchangesExist()
    const bingxConnection = await getConnection("bingx-x01")

    if (!bingxConnection) {
      return NextResponse.json(
        { ready: false, error: "BingX connection not found" },
        { status: 404 }
      )
    }

    const hasValidCredentials = !!(
      bingxConnection.api_key &&
      bingxConnection.api_secret &&
      bingxConnection.api_key.length >= 20 &&
      bingxConnection.api_secret.length >= 20
    )

    return NextResponse.json({
      ready: hasValidCredentials,
      connection: {
        id: bingxConnection.id,
        name: bingxConnection.name,
        exchange: bingxConnection.exchange,
        hasApiKey: !!bingxConnection.api_key,
        hasApiSecret: !!bingxConnection.api_secret,
        apiKeyLength: bingxConnection.api_key?.length || 0,
        apiSecretLength: bingxConnection.api_secret?.length || 0,
        isTestnet: bingxConnection.is_testnet,
        isEnabled: bingxConnection.is_enabled,
      },
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error("[v0] [BingX Status] Error:", errorMessage)

    return NextResponse.json(
      { ready: false, error: "Failed to check BingX status", details: errorMessage },
      { status: 500 }
    )
  }
}

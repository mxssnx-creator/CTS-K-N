/**
 * Engine Startup Route
 * Starts the trade engine with market data initialization
 */

import { NextRequest, NextResponse } from "next/server"
import { TradeEngineManager } from "@/lib/trade-engine/engine-manager"
import { getSettings, setSettings, initRedis, getAssignedAndEnabledConnections } from "@/lib/redis-db"
import { loadMarketDataForEngine } from "@/lib/market-data-loader"
import { validateProductionStartup } from "@/lib/startup-validation"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function POST(request: NextRequest) {
  try {
    // Run comprehensive startup validation
    const validation = await validateProductionStartup()
    if (!validation.passed) {
      return NextResponse.json(
        {
          error: "Startup validation failed",
          validation,
        },
        { status: 500 }
      )
    }

    await initRedis()

    const { symbols = [], connectionId: requestedConnectionId } = await request.json()
    const assignedConnections = await getAssignedAndEnabledConnections()
    const selectedConnection = requestedConnectionId
      ? assignedConnections.find((connection: any) => connection.id === requestedConnectionId)
      : assignedConnections.find((connection: any) =>
          String(connection.exchange || connection.id || "").toLowerCase().includes("bingx"),
        ) || assignedConnections[0]
    const connectionId = String(selectedConnection?.id || "")
    if (!connectionId) {
      return NextResponse.json({ error: "No enabled persisted connection available" }, { status: 400 })
    }

    // Load market data for all symbols
    console.log("[v0] [API] Loading market data for engine startup...")
    const loadedCount = await loadMarketDataForEngine(symbols, { requireHistory: true, connectionId })

    if (loadedCount === 0) {
      return NextResponse.json(
        { error: "Failed to load market data", loadedCount: 0 },
        { status: 400 }
      )
    }

    // Start the engine
    console.log("[v0] [API] Starting trade engine with market data loaded...")
    const config = {
      connectionId,
      indicationInterval: 5, // 5 seconds
      strategyInterval: 10, // 10 seconds
      realtimeInterval: 0.3,
    }

    const engine = new TradeEngineManager(config)
    await engine.start(config)

    // Store engine state
    await setSettings("engine_state", {
      running: true,
      startedAt: new Date().toISOString(),
      marketDataLoaded: loadedCount,
      symbols: symbols.length > 0 ? symbols : "all_default",
    })

    return NextResponse.json({
      status: "started",
      message: "Trade engine started with market data",
      marketDataLoaded: loadedCount,
      config,
    })
  } catch (error) {
    console.error("[v0] [API] Engine startup failed:", error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        status: "failed",
      },
      { status: 500 }
    )
  }
}

export async function GET() {
  try {
    await initRedis()
    const engineState = await getSettings("engine_state")

    return NextResponse.json({
      status: "ok",
      engineState: engineState || { running: false, marketDataLoaded: 0 },
    })
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to get engine state" },
      { status: 500 }
    )
  }
}

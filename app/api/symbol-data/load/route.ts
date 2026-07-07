import { NextResponse, type NextRequest } from "next/server"
import { initRedis } from "@/lib/redis-db"
import { getSession } from "@/lib/auth"
import {
  loadSymbolDataByTimeframe,
  getLoadProgress,
  cancelSymbolDataLoad,
  type Timeframe,
} from "@/lib/symbol-data-loader"

export const dynamic = "force-dynamic"

/**
 * POST /api/symbol-data/load - Start loading symbol data by timeframe
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getSession()
    if (!user) {
      return NextResponse.json({ success: false, error: "Not authenticated" }, { status: 401 })
    }

    await initRedis()
    const body = await request.json()

    const {
      connection_id,
      symbols = [],
      timeframes = ["1h", "4h", "1d"],
      days_back = 30,
      batch_size = 5,
    } = body

    if (!connection_id || symbols.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "connection_id and symbols array required",
        },
        { status: 400 },
      )
    }

    // Start async load operation
    const loadPromise = loadSymbolDataByTimeframe({
      connectionId: connection_id,
      symbols,
      timeframes: timeframes as Timeframe[],
      daysBack: days_back,
      batchSize: batch_size,
    })

    // Return immediately with task ID (load continues in background)
    const taskId = `load_${connection_id}_${Date.now()}`

    return NextResponse.json({
      success: true,
      taskId,
      connectionId: connection_id,
      totalSymbols: symbols.length,
      timeframes: timeframes.length,
      message: "Symbol data load started in background",
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error("[v0] Symbol data load error:", errorMsg)

    return NextResponse.json(
      {
        success: false,
        error: "Failed to start symbol data load",
        details: process.env.NODE_ENV === "development" ? errorMsg : undefined,
      },
      { status: 500 },
    )
  }
}

/**
 * GET /api/symbol-data/load?connection_id=... - Get load progress
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getSession()
    if (!user) {
      return NextResponse.json({ success: false, error: "Not authenticated" }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get("connection_id")

    if (!connectionId) {
      return NextResponse.json(
        { success: false, error: "connection_id required" },
        { status: 400 },
      )
    }

    await initRedis()
    const progress = await getLoadProgress(connectionId)

    if (!progress) {
      return NextResponse.json({
        success: true,
        data: null,
        message: "No active load operation",
      })
    }

    return NextResponse.json({
      success: true,
      data: {
        status: progress.status,
        totalSymbols: progress.totalSymbols,
        processedSymbols: progress.processedSymbols,
        totalTimeframes: progress.totalTimeframes,
        processedTimeframes: progress.processedTimeframes,
        currentSymbol: progress.currentSymbol,
        currentTimeframe: progress.currentTimeframe,
        progress: ((progress.processedSymbols / progress.totalSymbols) * 100).toFixed(1) + "%",
        errors: progress.errors,
      },
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error("[v0] Failed to get load progress:", errorMsg)

    return NextResponse.json(
      {
        success: false,
        error: "Failed to get load progress",
        details: process.env.NODE_ENV === "development" ? errorMsg : undefined,
      },
      { status: 500 },
    )
  }
}

/**
 * DELETE /api/symbol-data/load?connection_id=... - Cancel load operation
 */
export async function DELETE(request: NextRequest) {
  try {
    const user = await getSession()
    if (!user) {
      return NextResponse.json({ success: false, error: "Not authenticated" }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get("connection_id")

    if (!connectionId) {
      return NextResponse.json(
        { success: false, error: "connection_id required" },
        { status: 400 },
      )
    }

    await initRedis()
    await cancelSymbolDataLoad(connectionId)

    return NextResponse.json({
      success: true,
      message: "Symbol data load cancelled",
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error("[v0] Failed to cancel load:", errorMsg)

    return NextResponse.json(
      {
        success: false,
        error: "Failed to cancel load",
        details: process.env.NODE_ENV === "development" ? errorMsg : undefined,
      },
      { status: 500 },
    )
  }
}

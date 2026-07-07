import { NextResponse } from "next/server"
import { initRedis, getRedisClient, updateConnection } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

/**
 * POST /api/trade-engine/enable-symbols
 * Enable live trading for specified symbols
 */
export async function POST(request: Request) {
  try {
    await initRedis()
    const { symbols } = await request.json()

    if (!Array.isArray(symbols) || symbols.length === 0) {
      return NextResponse.json(
        { error: "Invalid symbols array" },
        { status: 400 }
      )
    }

    const client = getRedisClient()

    // Store enabled symbols in Redis
    const enabledSymbols = await client.get("enabled_symbols")
    const currentSet = new Set(enabledSymbols ? JSON.parse(enabledSymbols) : [])

    // Add new symbols
    symbols.forEach((s: string) => currentSet.add(s))

    // Save back to Redis
    await client.set("enabled_symbols", JSON.stringify(Array.from(currentSet)))

    // Set live trading enabled flag for each symbol
    for (const symbol of symbols) {
      await client.hset(`symbol:${symbol}`, {
        live_trading_enabled: "true",
        enabled_at: new Date().toISOString(),
      })
    }

    console.log(`[v0] [TradeEngine] Enabled live trading for symbols: ${symbols.join(", ")}`)

    return NextResponse.json({
      success: true,
      enabledSymbols: Array.from(currentSet),
      message: `Live trading enabled for ${symbols.length} symbol(s)`,
    })
  } catch (error) {
    console.error("[v0] Error enabling symbols:", error)
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    )
  }
}

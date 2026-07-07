import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

/**
 * POST /api/trade-engine/toggle-symbol
 * Toggle live trading for a specific symbol
 */
export async function POST(request: Request) {
  try {
    await initRedis()
    const { symbol, enabled } = await request.json()

    if (!symbol || typeof enabled !== "boolean") {
      return NextResponse.json(
        { error: "Invalid symbol or enabled status" },
        { status: 400 }
      )
    }

    const client = getRedisClient()

    if (enabled) {
      // Enable live trading for symbol
      await client.hset(`symbol:${symbol}`, {
        live_trading_enabled: "true",
        enabled_at: new Date().toISOString(),
      })

      // Add to enabled symbols set
      const enabledSymbols = await client.get("enabled_symbols")
      const currentSet = new Set(enabledSymbols ? JSON.parse(enabledSymbols) : [])
      currentSet.add(symbol)
      await client.set("enabled_symbols", JSON.stringify(Array.from(currentSet)))

    } else {
      // Disable live trading for symbol
      await client.hset(`symbol:${symbol}`, {
        live_trading_enabled: "false",
        disabled_at: new Date().toISOString(),
      })

      // Remove from enabled symbols set
      const enabledSymbols = await client.get("enabled_symbols")
      const currentSet = new Set(enabledSymbols ? JSON.parse(enabledSymbols) : [])
      currentSet.delete(symbol)
      await client.set("enabled_symbols", JSON.stringify(Array.from(currentSet)))

    }

    return NextResponse.json({
      success: true,
      symbol,
      enabled,
      message: `Live trading ${enabled ? "enabled" : "disabled"} for ${symbol}`,
    })
  } catch (error) {
    console.error("[v0] Error toggling symbol:", error)
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    )
  }
}

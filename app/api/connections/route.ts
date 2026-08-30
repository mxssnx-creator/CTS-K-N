import { NextResponse } from "next/server"
import { initRedis, getAllConnections } from "@/lib/redis-db"
import { resolveCanonicalSymbols } from "@/lib/connection-symbols"

export const dynamic = "force-dynamic"
export const maxDuration = 30

/**
 * GET /api/connections
 * Returns all configured connections (mirrors /api/settings/connections/status format).
 * Exists as a backward-compatible alias for probe scripts and integration tests
 * that POST to /api/trade-engine/quick-start and then read connRes.connections[0].id.
 */
export async function GET() {
  try {
    await initRedis()
    const connectionsRaw = await getAllConnections()
    const connections = Array.isArray(connectionsRaw) ? connectionsRaw : []
    return NextResponse.json({
      success: true,
      connections: connections.map((c: any) => {
        const effectiveSymbols = resolveCanonicalSymbols(c)
        return {
        id: c.id,
        name: c.name,
        exchange: c.exchange,
        api_type: c.api_type,
        is_enabled: c.is_enabled,
        is_assigned: c.is_assigned,
        is_dashboard_enabled: c.is_dashboard_enabled,
        is_active: c.is_active,
        is_live_trade: c.is_live_trade,
        active_symbols: effectiveSymbols.count > 0 ? effectiveSymbols.symbols : c.active_symbols,
        symbol_count: effectiveSymbols.count > 0 ? effectiveSymbols.count : undefined,
        symbol_count_source: effectiveSymbols.count > 0 ? effectiveSymbols.source : "none",
      }
      }),
      count: connections.length,
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to get connections", connections: [], count: 0 },
      { status: 500 }
    )
  }
}

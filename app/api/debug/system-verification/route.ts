import { NextResponse } from "next/server"
import { initRedis, getRedisClient, getAllConnections } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const verification = {
    timestamp: new Date().toISOString(),
    components: {} as any,
    summary: {} as any,
  }

  try {
    // Initialize Redis
    await initRedis()
    const client = getRedisClient()
    if (!client) throw new Error("Redis unavailable")

    // 1. CHECK CONNECTIONS
    const connections = await getAllConnections()
    const bingxConn = connections.find((c: any) => c.exchange === "bingx")
    
    verification.components.connections = {
      status: "CHECK",
      total: connections.length,
      bybit: connections.some((c: any) => c.exchange === "bybit"),
      bingx: connections.some((c: any) => c.exchange === "bingx"),
      pionex: connections.some((c: any) => c.exchange === "pionex"),
      orangex: connections.some((c: any) => c.exchange === "orangex"),
      bingx_api_key_length: bingxConn?.api_key?.length || 0,
      bingx_is_inserted: bingxConn?.is_inserted,
      bingx_is_active: bingxConn?.is_active,
    }

    // 2. CHECK HISTORIC DATA
    const marketData = await client.hgetall("market_data:BTCUSDT")
    verification.components.historic_data = {
      status: marketData ? "LOADED" : "MISSING",
      btcusdt_records: Object.keys(marketData || {}).length,
    }

    // 3. CHECK INDICATIONS STATE
    const indicationsState = await client.hgetall("indications:state")
    verification.components.indications = {
      status: Object.keys(indicationsState || {}).length > 0 ? "RUNNING" : "PENDING",
      cycles: indicationsState?.cycles_processed,
      last_update: indicationsState?.last_update,
    }

    // 4. CHECK STRATEGIES STATE
    const strategiesState = await client.hgetall("strategies:state")
    verification.components.strategies = {
      status: Object.keys(strategiesState || {}).length > 0 ? "RUNNING" : "PENDING",
      cycles: strategiesState?.cycles_processed,
      last_update: strategiesState?.last_update,
    }

    // 5. CHECK PROGRESSION LOGS
    const progressionLogs = await client.lrange("progression:logs", -5, -1)
    verification.components.progression = {
      status: progressionLogs.length > 0 ? "ACTIVE" : "NONE",
      recent_logs: progressionLogs.length,
      last_events: progressionLogs.slice(-3).map((log: string) => {
        try {
          return JSON.parse(log)
        } catch {
          return log
        }
      }),
    }

    // SUMMARY
    const indicationCycles = parseInt(indicationsState?.cycles_processed || "0")
    const strategyCycles = parseInt(strategiesState?.cycles_processed || "0")
    
    verification.summary = {
      connections_ready: connections.length >= 1 && bingxConn?.api_key?.length >= 16,
      historic_data_loaded: Object.keys(marketData || {}).length > 0,
      indications_processing: indicationCycles > 0,
      strategies_processing: strategyCycles > 0,
      progression_tracking: progressionLogs.length > 0,
      
      overall_status:
        connections.length >= 1 &&
        bingxConn?.api_key?.length >= 16 &&
        Object.keys(marketData || {}).length > 0 &&
        indicationCycles > 0 &&
        strategyCycles > 0
          ? "OPERATIONAL"
          : "INCOMPLETE",
    }

    return NextResponse.json(verification, { status: 200 })
  } catch (error) {
    verification.summary.error = error instanceof Error ? error.message : String(error)
    verification.summary.overall_status = "ERROR"
    return NextResponse.json(verification, { status: 500 })
  }
}

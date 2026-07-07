import { NextResponse } from "next/server"
import { initRedis, getAllConnections, getRedisClient, getRedisRequestsPerSecond } from "@/lib/redis-db"
import { getDashboardWorkflowSnapshot } from "@/lib/dashboard-workflow"
import {
  hasConnectionCredentials,
  isConnectionDashboardEnabled,
  isConnectionInActivePanel,
  isConnectionLiveTradeEnabled,
  isConnectionPresetTradeEnabled,
  isConnectionWorking,
  isTruthyFlag,
} from "@/lib/connection-state-utils"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const fetchCache = "force-no-store"

// Main/base connection scope for dashboard metrics.
const BASE_EXCHANGES = ["bingx"]

function isBaseExchange(c: any): boolean {
  return BASE_EXCHANGES.includes((c?.exchange || "").toLowerCase().trim())
}

export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()

    // STABILITY RULE: do NOT trigger default connection seeding from stats requests.
    // Seeding is a startup-only concern; triggering it from polled endpoints causes
    // user-deleted base connections to reappear and breaks the "stable assignment"
    // contract. An empty list is a valid, respected state.
    const connections = await getAllConnections()
    const allConnections = connections
    console.log(`[v0] [SystemStats] Analyzing ${connections.length} total connections`)
    
    // BASE CONNECTIONS = All base exchange connections (predefined or user-created)
    // that are marked as enabled (is_enabled=1) in Settings
    const baseConnections = connections.filter((c: any) => isBaseExchange(c))
    const enabledBase = baseConnections.filter((c: any) => isTruthyFlag(c.is_enabled))
    console.log(`[v0] [SystemStats] Base connections: ${baseConnections.length}, enabled: ${enabledBase.length}`)
    
    // ACTIVE PANEL = Connections marked as active-inserted (shown in Active Connections panel)
    // These can be predefined templates OR user-created connections
    const activeInsertedAll = connections.filter((c: any) => isConnectionInActivePanel(c))
    console.log(`[v0] [SystemStats] In Active panel: ${activeInsertedAll.length}`)
    
    // ENABLED ON DASHBOARD = Active connections that user has toggled ON
    const enabledDashboard = activeInsertedAll.filter((c: any) => isConnectionDashboardEnabled(c))
    console.log(`[v0] [SystemStats] Enabled on dashboard: ${enabledDashboard.length}`)
    
    // WORKING = Connections where API test succeeded
    const workingAll = allConnections.filter((c: any) => isConnectionWorking(c))
    console.log(`[v0] [SystemStats] Working/tested: ${workingAll.length}`)
    
    // PERF: use DBSIZE instead of KEYS("*") — KEYS is O(N) and blocks the Redis
    // server. DBSIZE is O(1). Falls back to 0 if the client does not support it.
    let totalKeys = 0
    try {
      const dbSizeFn = (client as any).dbsize || (client as any).dbSize
      if (typeof dbSizeFn === "function") {
        totalKeys = await dbSizeFn.call(client)
      }
    } catch (err) {
      console.warn("[v0] [SystemStats] DBSIZE failed (falling back to 0):", err instanceof Error ? err.message : err)
      totalKeys = 0
    }
    console.log(`[v0] [SystemStats] Total DB keys: ${totalKeys}`)

    // Trade Engine Status from Redis (stored as hash, not string)
    let globalEngineState: any = {}
    try {
      // trade_engine:global is stored as a hash using hset, so use hgetall
      const hashData = await client.hgetall("trade_engine:global")
      globalEngineState = hashData && Object.keys(hashData).length > 0 ? hashData : {}
    } catch {
      globalEngineState = {}
    }
    const globalStatus = globalEngineState.status || "stopped"

    // Main Connections: base connections that are either inserted OR in active panel
    const mainConnections = baseConnections.filter((c: any) => {
      const isInserted = isTruthyFlag(c.is_inserted)
      const isActiveInserted = isConnectionInActivePanel(c)
      return isInserted || isActiveInserted
    })
    const mainEnabled = mainConnections.length > 0
    
    // Live Trade: runs independently when is_live_trade=true (for real exchange position mirroring)
    // Does NOT require Main Engine to be running
    const liveTradeConnections = connections.filter((c: any) => isConnectionLiveTradeEnabled(c))
    const liveTradeEnabled = liveTradeConnections.length > 0
    
    // Preset: runs independently when is_preset_trade=true (for preset strategies)
    const presetTradeConnections = connections.filter((c: any) => isConnectionPresetTradeEnabled(c))
    const presetTradeEnabled = presetTradeConnections.length > 0
    
    // Main Engine status: running when main_enabled, regardless of live/preset
    const mainStatusBeforePause = mainEnabled 
      ? "running" 
      : "stopped"
    
    // Live Trade status: independent - running when enabled
    const liveTradeStatusBeforePause = liveTradeEnabled
      ? "running"
      : "stopped"
    
    // Preset status: independent - running when enabled  
    const presetStatusBeforePause = presetTradeEnabled
      ? "running"
      : "stopped"
    
    // ── Override all statuses if global coordinator is paused ──────────
    // When globalStatus === "paused", all engine statuses (main, live,
    // preset) become "paused" as well. This ensures the UI consistently
    // shows the pause state across all engine tiers.
    const mainStatus = globalStatus === "paused" ? "paused" : mainStatusBeforePause
    const liveTradeStatus = globalStatus === "paused" ? "paused" : liveTradeStatusBeforePause
    const presetStatus = globalStatus === "paused" ? "paused" : presetStatusBeforePause
    
    // Connections with valid credentials (can actually trade)
    const connectionsWithCredentials = baseConnections.filter((c: any) => hasConnectionCredentials(c, 10))
    console.log(`[v0] [SystemStats] Connections with valid credentials: ${connectionsWithCredentials.length}`)
    
    // EXCHANGE CONNECTIONS = Base connections that are inserted (either is_inserted=1 OR is_active_inserted=1)
    // These are connections visible to the user, regardless of panel placement
    const insertedBaseConnections = baseConnections.filter((c: any) => {
      const isInserted = isTruthyFlag(c.is_inserted)
      const isActiveInserted = isConnectionInActivePanel(c)
      return isInserted || isActiveInserted
    })
    console.log(`[v0] [SystemStats] Exchange connections (inserted as cards): ${insertedBaseConnections.length}`)
    
    // Exchange status: healthy if connections with credentials exist, otherwise waiting for credentials
    const exchangeStatus = 
      connectionsWithCredentials.length > 0 ? "healthy" :
      insertedBaseConnections.length > 0 ? "waiting" :
      baseConnections.length > 0 ? "partial" : "down"

    const workflow = await getDashboardWorkflowSnapshot()

    // ── Aggregate cycle/indication/strategy stats from ALL active-inserted connections ──
    // The focusConnection in dashboard-workflow only tracks one connection; read all
    // progression hashes directly to get the real totals across all running engines.
    let totalIndicationCycles = 0
    let totalStrategyCycles   = 0
    let totalIndicationsCount = 0
    let totalStrategiesCount  = 0

    // PERF: iterate over connections we already have in memory and HGETALL each
    // progression hash in parallel. Avoids a Redis-blocking KEYS("progression:*") scan
    // which was O(total DB keys). Bounded to N connections (usually < 10).
    try {
      const relevantIds: string[] = connections
        .map((c: any) => c?.id)
        .filter((id: unknown): id is string => typeof id === "string" && id.length > 0)

      const progressionHashes = await Promise.all(
        relevantIds.map(async (id) => {
          try {
            return await client.hgetall(`progression:${id}`)
          } catch {
            return null
          }
        })
      )

      for (const ph of progressionHashes) {
        if (ph && typeof ph === "object") {
          totalIndicationCycles += parseInt((ph as any).indication_cycle_count || "0", 10)
          totalStrategyCycles   += parseInt((ph as any).strategy_cycle_count   || "0", 10)
          totalIndicationsCount += parseInt((ph as any).indications_count       || "0", 10)
          totalStrategiesCount  += parseInt((ph as any).strategies_count        || "0", 10)
        }
      }
    } catch (e) {
      console.warn("[v0] [SystemStats] Error aggregating progression hashes:", e instanceof Error ? e.message : e)
    }

    // Fallback to focusConnection metrics if all progression hashes are empty
    const focusCycles = workflow.connectionMetrics.engineCycles
    const finalIndicationCycles = totalIndicationCycles || focusCycles?.indication || 0
    const finalStrategyCycles   = totalStrategyCycles   || focusCycles?.strategy   || 0
    const finalTotalCycles      = finalIndicationCycles + finalStrategyCycles

    console.log(`[v0] [SystemStats] Response: exchangeConnections.total=${insertedBaseConnections.length}, debug: base=${baseConnections.length}, enabled=${enabledBase.length}, inserted=${insertedBaseConnections.length}`)
    
    return NextResponse.json({
      success: true,
      tradeEngines: {
        globalStatus,
        mainStatus,
        mainCount: mainConnections.length,
        mainTotal: activeInsertedAll.length,
        mainEnabled,
        liveTradeStatus,
        liveTradeCount: liveTradeConnections.length,
        liveTradeEnabled,
        presetStatus,
        presetCount: presetTradeConnections.length,
        presetTotal: activeInsertedAll.length,
        presetEnabled: presetTradeEnabled,
        totalEnabled: mainConnections.length + liveTradeConnections.length + presetTradeConnections.length,
        // Convenience aliases expected by dashboard components
        enabledConnections: enabledBase.length,
        activeConnections:  activeInsertedAll.length,
      },
      database: {
        status: "healthy",
        requestsPerSecond: getRedisRequestsPerSecond(),
        totalKeys,
        heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        rssMB:  Math.round(process.memoryUsage().rss       / 1024 / 1024),
      },
      exchangeConnections: {
        total: insertedBaseConnections.length,
        enabled: insertedBaseConnections.filter((c: any) => isTruthyFlag(c.is_enabled_dashboard) || isTruthyFlag(c.is_enabled)).length,
        // "working" = connection is engine-running (has an active engine) OR has a recent successful test
        working: insertedBaseConnections.filter((c: any) =>
          isConnectionWorking(c) ||
          isTruthyFlag(c.is_enabled_dashboard) ||
          isConnectionInActivePanel(c)
        ).length,
        withCredentials: connectionsWithCredentials.length,
        status: exchangeStatus,
      },
      activeConnections: {
        // Count active-inserted connections — these are the ones with running engines
        total: activeInsertedAll.length,
        active: activeInsertedAll.length,
        liveTrade: workflow.overview.liveTradeConnections,
        presetTrade: workflow.overview.presetTradeConnections,
      },
      availableConnections: enabledBase.filter((c: any) => !isConnectionInActivePanel(c)).length,
      liveTrades: {
        lastHour: 0,
        topConnections: [],
      },
      cycleStats: {
        cycleCount: finalTotalCycles,
        indicationCycles: finalIndicationCycles,
        strategyCycles: finalStrategyCycles,
        indicationsCount: totalIndicationsCount,
        strategiesCount: totalStrategiesCount,
        cycleDurationMs: workflow.connectionMetrics.engineDurations?.indicationAvgMs || 0,
      },
      totalPositions: workflow.connectionMetrics.positions,
      totalTrades: workflow.connectionMetrics.trades,
      workflowOverview: {
        ...workflow.overview,
        // Override with accurate active-inserted count
        activePanelConnections: activeInsertedAll.length,
        eligibleEngineConnections: Math.max(workflow.overview.eligibleEngineConnections, activeInsertedAll.length),
      },
      workflowPhases: workflow.workflowPhases,
      _debug: {
        baseConnectionsTotal: baseConnections.length,
        baseConnectionsEnabled: enabledBase.length,
        insertedBaseConnectionsCount: insertedBaseConnections.length,
        activeInsertedAllCount: activeInsertedAll.length,
        totalIndicationCycles,
        totalStrategyCycles,
      }
    })
  } catch (error) {
    console.error("[v0] [System Stats v3] ERROR:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to fetch system stats" },
      { status: 500 }
    )
  }
}

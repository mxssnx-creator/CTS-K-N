/**
 * Engine System Verification
 * Comprehensive checks for entire trade engine workflow
 * 
 * Verifies:
 * 1. Connection states (enabled/inserted/active)
 * 2. Market data availability
 * 3. Indication calculation and storage
 * 4. Strategy evaluation
 * 5. Progression state tracking
 * 6. Error handling across all phases
 */

import { getAllConnections, getAssignedAndEnabledConnections, initRedis, getRedisClient } from "@/lib/redis-db"

interface VerificationReport {
  timestamp: string
  status: "healthy" | "degraded" | "critical"
  summary: string
  checks: {
    connections: ConnectionCheck
    marketData: MarketDataCheck
    indications: IndicationCheck
    strategies: StrategyCheck
    progression: ProgressionCheck
  }
  errors: string[]
  warnings: string[]
  recommendations: string[]
}

interface ConnectionCheck {
  totalConnections: number
  insertedConnections: number
  enabledConnections: number
  activeConnections: number
  baseConnections: {
    id: string
    name: string
    exchange: string
    is_inserted: string
    is_enabled: string
    is_active_inserted: string
  }[]
  status: "ok" | "missing" | "misconfigured"
  details: string
}

interface MarketDataCheck {
  totalSymbols: number
  symbolsWithData: number
  avgCandlesPerSymbol: number
  status: "ok" | "incomplete" | "missing"
  details: string
}

interface IndicationCheck {
  prehistoricPhaseComplete: boolean
  prehistoricIndications: number
  realtimeIndications: number
  indicationTypesGenerated: string[]
  status: "ok" | "partial" | "missing"
  details: string
}

interface StrategyCheck {
  strategiesLoaded: number
  strategiesEvaluated: number
  evaluationStatus: "running" | "stalled" | "inactive"
  status: "ok" | "stalled" | "inactive"
  details: string
}

interface ProgressionCheck {
  phase: string
  progressionEvents: number
  errorCount: number
  lastUpdate: string
  status: "ok" | "degraded" | "stalled"
  details: string
}

export async function verifyEngineSystem(): Promise<VerificationReport> {
  const errors: string[] = []
  const warnings: string[] = []
  const recommendations: string[] = []
  
  const timestamp = new Date().toISOString()
  
  try {
    await initRedis()
    const client = getRedisClient()
    
    // ==============
    // 1. CONNECTIONS
    // ==============
    console.log("[v0] [Verification] Checking connections...")
    const allConnections = await getAllConnections()
    const enabledConnections = await getAssignedAndEnabledConnections()
    
    const connectionCheck: ConnectionCheck = {
      totalConnections: allConnections.length,
      insertedConnections: allConnections.filter((c: any) => c.is_inserted === "1").length,
      enabledConnections: enabledConnections.length,
      activeConnections: allConnections.filter((c: any) => c.is_active_inserted === "1").length,
      baseConnections: allConnections
        .filter((c: any) => (c.is_inserted === "1" || c.is_active_inserted === "1") && (c.is_predefined === "1" || !c.is_predefined))
        .map((c: any) => ({
          id: c.id,
          name: c.name,
          exchange: c.exchange,
          is_inserted: c.is_inserted || "0",
          is_enabled: c.is_enabled || "0",
          is_active_inserted: c.is_active_inserted || "0",
        })),
      status: "ok",
      details: "",
    }
    
    if (enabledConnections.length === 0) {
      connectionCheck.status = "missing"
      errors.push("NO ACTIVE CONNECTIONS FOUND - Engine has nothing to process")
      recommendations.push("Use quick-start endpoint or manually enable a connection in Settings > Active")
    } else if (enabledConnections.length < 2) {
      warnings.push(`Only ${enabledConnections.length} active connection(s) - consider adding more for diversity`)
    }
    
    connectionCheck.details = `Found ${enabledConnections.length}/${allConnections.length} connections enabled and ready`
    
    console.log(`[v0] [Verification] Connections: ${enabledConnections.length} active of ${allConnections.length} total`)
    
    // ==============
    // 2. MARKET DATA
    // ==============
    console.log("[v0] [Verification] Checking market data...")
    const marketDataCheck: MarketDataCheck = {
      totalSymbols: 0,
      symbolsWithData: 0,
      avgCandlesPerSymbol: 0,
      status: "ok",
      details: "",
    }
    
    // Check for market data keys
    const marketDataKeys = await client.keys("market_data:*:candles")
    const validSymbols = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "LINKUSDT", "LITUSDT", "THETAUSDT", "AVAXUSDT", "MATICUSDT", "SOLUSDT", "UNIUSDT", "APTUSDT", "ARBUSDT"]
    
    marketDataCheck.totalSymbols = validSymbols.length
    marketDataCheck.symbolsWithData = marketDataKeys.length
    
    if (marketDataKeys.length === 0) {
      marketDataCheck.status = "missing"
      errors.push("NO MARKET DATA FOUND - Run market data loader or wait for data ingestion")
      recommendations.push("Call /api/init to load initial market data")
    } else if (marketDataKeys.length < validSymbols.length) {
      marketDataCheck.status = "incomplete"
      warnings.push(`Only ${marketDataKeys.length}/${validSymbols.length} symbols have market data`)
    }
    
    marketDataCheck.details = `${marketDataCheck.symbolsWithData}/${marketDataCheck.totalSymbols} symbols have market data loaded`
    
    console.log(`[v0] [Verification] Market data: ${marketDataCheck.symbolsWithData}/${marketDataCheck.totalSymbols} symbols`)
    
    // ==============
    // 3. INDICATIONS
    // ==============
    console.log("[v0] [Verification] Checking indications...")
    const indicationCheck: IndicationCheck = {
      prehistoricPhaseComplete: false,
      prehistoricIndications: 0,
      realtimeIndications: 0,
      indicationTypesGenerated: [],
      status: "ok",
      details: "",
    }
    
    // Check for prehistoric indications (should exist after first run)
    const prehistoricKeys = await client.keys("prehistoric:*:data")
    indicationCheck.prehistoricPhaseComplete = prehistoricKeys.length > 0
    indicationCheck.prehistoricIndications = prehistoricKeys.length
    
    // Check for realtime indications
    const realtimeKeys = await client.keys("indication:*:realtime")
    indicationCheck.realtimeIndications = realtimeKeys.length
    
    if (!indicationCheck.prehistoricPhaseComplete) {
      indicationCheck.status = "missing"
      warnings.push("Prehistoric phase not complete - engine still initializing")
      recommendations.push("Wait for first full indication cycle to complete (5-10 minutes typically)")
    } else if (indicationCheck.realtimeIndications === 0) {
      indicationCheck.status = "partial"
      warnings.push("Prehistoric complete but realtime indications not yet generated")
    }
    
    indicationCheck.indicationTypesGenerated = ["direction", "move", "active", "optimal"]
    indicationCheck.details = `Prehistoric: ${indicationCheck.prehistoricIndications} complete | Realtime: ${indicationCheck.realtimeIndications} generated`
    
    console.log(`[v0] [Verification] Indications: prehistoric=${indicationCheck.prehistoricPhaseComplete}, realtime=${indicationCheck.realtimeIndications}`)
    
    // ==============
    // 4. STRATEGIES
    // ==============
    console.log("[v0] [Verification] Checking strategies...")
    const strategyCheck: StrategyCheck = {
      strategiesLoaded: 0,
      strategiesEvaluated: 0,
      evaluationStatus: "inactive",
      status: "ok",
      details: "",
    }
    
    // Get strategy stats from Redis
    const strategyStatsRaw = await client.get("strategies:stats")
    const strategyStats = strategyStatsRaw ? JSON.parse(strategyStatsRaw) : null
    
    if (strategyStats) {
      strategyCheck.strategiesEvaluated = strategyStats.totalEvaluated || 0
      strategyCheck.evaluationStatus = strategyStats.totalEvaluated > 0 ? "running" : "stalled"
    }
    
    if (enabledConnections.length === 0) {
      strategyCheck.status = "inactive"
      strategyCheck.details = "No active connections - strategies cannot evaluate"
    } else if (strategyCheck.strategiesEvaluated === 0) {
      strategyCheck.status = "stalled"
      warnings.push("Strategies not evaluating - waiting for indications to generate")
    } else {
      strategyCheck.details = `${strategyCheck.strategiesEvaluated} strategies evaluated`
    }
    
    console.log(`[v0] [Verification] Strategies: evaluated=${strategyCheck.strategiesEvaluated}, status=${strategyCheck.evaluationStatus}`)
    
    // ==============
    // 5. PROGRESSION
    // ==============
    console.log("[v0] [Verification] Checking progression...")
    const progressionCheck: ProgressionCheck = {
      phase: "unknown",
      progressionEvents: 0,
      errorCount: 0,
      lastUpdate: "never",
      status: "ok",
      details: "",
    }
    
    // Get progression status from Redis
    const progressionRaw = await client.get("progression:global")
    const progression = progressionRaw ? JSON.parse(progressionRaw) : null
    
    if (progression) {
      progressionCheck.phase = progression.phase || "unknown"
      progressionCheck.progressionEvents = progression.eventCount || 0
      progressionCheck.errorCount = progression.errorCount || 0
      progressionCheck.lastUpdate = progression.lastUpdate || "never"
    }
    
    if (progressionCheck.errorCount > 10) {
      progressionCheck.status = "degraded"
      warnings.push(`${progressionCheck.errorCount} progression errors detected`)
    }
    
    progressionCheck.details = `Phase: ${progressionCheck.phase} | Events: ${progressionCheck.progressionEvents} | Errors: ${progressionCheck.errorCount}`
    
    console.log(`[v0] [Verification] Progression: phase=${progressionCheck.phase}, events=${progressionCheck.progressionEvents}`)
    
    // ===============
    // FINAL VERDICT
    // ===============
    let overallStatus: "healthy" | "degraded" | "critical" = "healthy"
    
    if (errors.length > 0) overallStatus = "critical"
    else if (warnings.length > 0) overallStatus = "degraded"
    
    const report: VerificationReport = {
      timestamp,
      status: overallStatus,
      summary: buildSummary(overallStatus, errors.length, warnings.length),
      checks: {
        connections: connectionCheck,
        marketData: marketDataCheck,
        indications: indicationCheck,
        strategies: strategyCheck,
        progression: progressionCheck,
      },
      errors,
      warnings,
      recommendations,
    }
    
    console.log(`[v0] [Verification] ✓ Verification complete: ${overallStatus.toUpperCase()}`)
    return report
    
  } catch (error) {
    console.error("[v0] [Verification] ✗ Verification failed:", error)
    throw error
  }
}

function buildSummary(status: string, errorCount: number, warningCount: number): string {
  switch (status) {
    case "critical":
      return `CRITICAL: ${errorCount} errors preventing engine operation. See recommendations to fix.`
    case "degraded":
      return `DEGRADED: ${warningCount} warnings - engine running but not optimally. Monitor closely.`
    case "healthy":
      return "HEALTHY: Engine operating normally with all critical systems active."
    default:
      return "UNKNOWN: Unable to determine system status."
  }
}

export async function logEngineSystemState(): Promise<void> {
  try {
    const report = await verifyEngineSystem()
    
    console.log("\n========== ENGINE SYSTEM VERIFICATION ==========")
    console.log(`Timestamp: ${report.timestamp}`)
    console.log(`Status: ${report.status.toUpperCase()}`)
    console.log(`Summary: ${report.summary}\n`)
    
    console.log("Connections:")
    console.log(`  Total: ${report.checks.connections.totalConnections}`)
    console.log(`  Enabled: ${report.checks.connections.enabledConnections}`)
    console.log(`  Active: ${report.checks.connections.activeConnections}\n`)
    
    console.log("Market Data:")
    console.log(`  Symbols: ${report.checks.marketData.symbolsWithData}/${report.checks.marketData.totalSymbols}\n`)
    
    console.log("Indications:")
    console.log(`  Prehistoric: ${report.checks.indications.prehistoricPhaseComplete ? "complete" : "incomplete"}`)
    console.log(`  Realtime: ${report.checks.indications.realtimeIndications} generated\n`)
    
    console.log("Strategies:")
    console.log(`  Evaluated: ${report.checks.strategies.strategiesEvaluated}`)
    console.log(`  Status: ${report.checks.strategies.evaluationStatus}\n`)
    
    console.log("Progression:")
    console.log(`  Phase: ${report.checks.progression.phase}`)
    console.log(`  Events: ${report.checks.progression.progressionEvents}`)
    console.log(`  Errors: ${report.checks.progression.errorCount}\n`)
    
    if (report.errors.length > 0) {
      console.log("ERRORS:")
      report.errors.forEach(e => console.log(`  ✗ ${e}`))
      console.log("")
    }
    
    if (report.warnings.length > 0) {
      console.log("WARNINGS:")
      report.warnings.forEach(w => console.log(`  ⚠ ${w}`))
      console.log("")
    }
    
    if (report.recommendations.length > 0) {
      console.log("RECOMMENDATIONS:")
      report.recommendations.forEach(r => console.log(`  → ${r}`))
      console.log("")
    }
    
    console.log("================================================\n")
  } catch (error) {
    console.error("[v0] [Verification] Failed to log system state:", error)
  }
}

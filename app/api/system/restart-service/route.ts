import { NextRequest, NextResponse } from "next/server"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export async function POST(request: NextRequest) {
  try {
    const { service } = await request.json()
    
    console.log(`[v0] [Restart] Restarting service: ${service}`)

    await initRedis()
    const coordinator = getGlobalTradeEngineCoordinator()
    const client = getRedisClient()

    const restartLog = (msg: string) => {
      console.log(`[v0] [Restart] ${msg}`)
    }

    switch (service) {
      case "trade-engine":
        restartLog("Stopping trade engine...")
        await coordinator.stopAllEngines()
        restartLog("Cleared engine state from Redis...")
        await client.del("trade_engine:global")
        restartLog("✓ Trade engine restarted")
        break

      case "indications-engine":
        restartLog("Restarting indications engine...")
        // Reset indications state
        const indicationKeys = await client.keys("indication:*").catch(() => [])
        if (indicationKeys.length > 0) {
          await client.del(...indicationKeys)
          restartLog(`Cleared ${indicationKeys.length} indication keys`)
        }
        restartLog("✓ Indications engine restarted")
        break

      case "strategies-engine":
        restartLog("Restarting strategies engine...")
        // Reset strategies state
        const strategyKeys = await client.keys("strategy:*").catch(() => [])
        if (strategyKeys.length > 0) {
          await client.del(...strategyKeys)
          restartLog(`Cleared ${strategyKeys.length} strategy keys`)
        }
        restartLog("✓ Strategies engine restarted")
        break

      case "all-services":
        restartLog("Restarting all services...")
        
        // Stop all engines
        await coordinator.stopAllEngines()
        
        // Clear all engine-related state
        const engineKeys = await client.keys("trade_engine:*").catch(() => [])
        if (engineKeys.length > 0) {
          await client.del(...engineKeys)
          restartLog(`Cleared ${engineKeys.length} engine keys`)
        }
        
        // Clear indication state
        const indicKeys = await client.keys("indication:*").catch(() => [])
        if (indicKeys.length > 0) {
          await client.del(...indicKeys)
          restartLog(`Cleared ${indicKeys.length} indication keys`)
        }
        
        // Clear strategy state
        const stratKeys = await client.keys("strategy:*").catch(() => [])
        if (stratKeys.length > 0) {
          await client.del(...stratKeys)
          restartLog(`Cleared ${stratKeys.length} strategy keys`)
        }
        
        restartLog("✓ All services restarted")
        break

      case "all-modules":
        restartLog("Restarting all modules...")
        
        // Reinitialize Redis connection
        await initRedis()
        restartLog("✓ Redis module restarted")
        
        // Reset persistence
        const persistKeys = await client.keys("persist:*").catch(() => [])
        if (persistKeys.length > 0) {
          await client.del(...persistKeys)
          restartLog(`Cleared ${persistKeys.length} persistence keys`)
        }
        
        // Reset coordinator
        if (coordinator) {
          await coordinator.stopAllEngines()
          restartLog("✓ Coordinator module restarted")
        }
        
        restartLog("✓ All modules restarted")
        break

      default:
        return NextResponse.json({ error: `Unknown service: ${service}` }, { status: 400 })
    }

    return NextResponse.json({
      success: true,
      message: `${service} restarted successfully`,
      service,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] [Restart] Error restarting service:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to restart service",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}

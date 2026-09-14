import { NextResponse } from "next/server"
import { getAllConnections, isConnectionMainEnabled } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { resolvePersistentDataDir } from "@/lib/persistent-paths"

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    console.log("[v0] [VERIFY] Starting comprehensive system verification")

    const verification = {
      timestamp: new Date().toISOString(),
      checks: [] as any[],
      status: "success" as string,
    }

    // Check 1: Load connections from the canonical Redis catalog (the legacy
    // file catalog is no longer the source of truth and may hold stale ids).
    try {
      const connections = await getAllConnections()

      if (!Array.isArray(connections)) {
        throw new Error(`Connections is not an array (type: ${typeof connections})`)
      }

      const enabled = connections.filter((c) => isConnectionMainEnabled(c))

      verification.checks.push({
        name: "Load Connections",
        status: "pass",
        details: {
          source: "redis",
          totalConnections: connections.length,
          enabledConnections: enabled.length,
          connections: connections.map((c) => ({
            id: c.id,
            name: c.name ?? c.id,
            exchange: c.exchange ?? null,
            enabled: isConnectionMainEnabled(c),
          })),
        },
      })
    } catch (error) {
      verification.checks.push({
        name: "Load Connections",
        status: "fail",
        error: error instanceof Error ? error.message : String(error),
      })
      verification.status = "partial"
    }

    // Check 2: Get coordinator
    try {
      const coordinator = getGlobalTradeEngineCoordinator()
      
      // Check if coordinator is null
      if (!coordinator) {
        throw new Error("Coordinator is null - engines may not be initialized yet")
      }

      verification.checks.push({
        name: "Get Coordinator",
        status: "pass",
        details: {
          coordinatorExists: !!coordinator,
          hasStartEngineMethod: typeof coordinator.startEngine === "function",
        },
      })
    } catch (error) {
      verification.checks.push({
        name: "Get Coordinator",
        status: "fail",
        error: error instanceof Error ? error.message : String(error),
      })
      verification.status = "partial"
    }

    // Check 3: Legacy file storage is informational only. Its absence is not a
    // failure: connections are served from Redis.
    try {
      const fs = await import("fs")
      const path = await import("path")
      const filePath = path.join(resolvePersistentDataDir(path.join(process.cwd(), "data")), "connections.json")
      const fileExists = fs.existsSync(filePath)

      verification.checks.push({
        name: "File Storage (legacy, informational)",
        status: "pass",
        details: {
          filePath,
          fileExists,
          note: "canonical connection source is Redis; this file is not authoritative",
        },
      })
    } catch (error) {
      verification.checks.push({
        name: "File Storage",
        status: "fail",
        error: error instanceof Error ? error.message : String(error),
      })
      verification.status = "partial"
    }

    console.log("[v0] [VERIFY] Verification complete:", verification)

    return NextResponse.json(verification)
  } catch (error) {
    console.error("[v0] [VERIFY] Verification failed:", error)

    return NextResponse.json(
      {
        status: "error",
        error: "Verification failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}

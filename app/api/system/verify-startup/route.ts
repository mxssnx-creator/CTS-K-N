import { NextResponse } from "next/server"
import { loadConnections } from "@/lib/file-storage"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    console.log("[v0] [VERIFY] Starting comprehensive system verification")

    const verification = {
      timestamp: new Date().toISOString(),
      checks: [] as any[],
      status: "success" as string,
    }

    // Check 1: Load connections
    try {
      const connections = loadConnections()
      
      // Ensure connections is an array before filtering
      if (!Array.isArray(connections)) {
        throw new Error(`Connections is not an array (type: ${typeof connections})`)
      }

      const enabledCount = connections.filter((c) => c.is_enabled === true).length
      const activeCount = connections.filter((c) => c.is_active === true).length

      verification.checks.push({
        name: "Load Connections",
        status: "pass",
        details: {
          totalConnections: connections.length,
          enabledConnections: enabledCount,
          activeConnections: activeCount,
          connections: connections.map((c) => ({
            id: c.id,
            name: c.name,
            exchange: c.exchange,
            is_enabled: c.is_enabled,
            is_active: c.is_active,
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

    // Check 3: Verify file storage
    try {
      const fs = await import("fs")
      const path = await import("path")
      const filePath = path.join(process.cwd(), "data", "connections.json")
      const fileExists = fs.existsSync(filePath)

      verification.checks.push({
        name: "File Storage",
        status: fileExists ? "pass" : "fail",
        details: {
          filePath,
          fileExists,
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

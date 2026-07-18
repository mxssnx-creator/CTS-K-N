/**
 * Persistence Status API
 * Returns information about database persistence and session continuity
 */

import { NextRequest, NextResponse } from "next/server"
import { getRedisBackend, getRedisClient, initRedis } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export const revalidate = 0

export async function GET(request: NextRequest) {
  try {
    await initRedis()
    const client = getRedisClient()
    const backend = getRedisBackend()
    const shared = backend === "redis-network"

    // Get Redis statistics
    const dbSize = await client.dbSize().catch(() => 0)
    const info = await client.info().catch(() => "")

    // Parse info for used memory if available
    let usedMemory = 0
    try {
      const lines = info.split("\r\n")
      const memLine = lines.find((line) => line.startsWith("used_memory:"))
      if (memLine) {
        usedMemory = parseInt(memLine.split(":")[1], 10)
      }
    } catch {
      // Ignore parsing errors
    }

    return NextResponse.json({
      status: shared ? "ok" : "degraded",
      timestamp: Date.now(),
      persistence: {
        enabled: true,
        backend,
        scope: shared ? "shared-cross-instance" : "process-local",
        cross_instance_durable: shared,
        local_snapshot_mode: shared ? "provider-managed" : "best-effort-node-filesystem-only",
      },
      database: {
        type: "redis",
        backend,
        shared,
        durable: shared,
        keys: dbSize,
        memory_bytes: usedMemory,
        memory_mb: Math.round(usedMemory / 1024 / 1024),
      },
      features: {
        automatic_snapshots: shared ? "provider-managed" : "best effort on writable Node filesystems",
        on_exit_flush: shared ? "not required" : "best effort",
        continuous_session: shared,
        page_refresh_recovery: true,
        rebuild_recovery: shared,
        cross_worker_recovery: shared,
        live_order_coordination: shared,
      },
      recovery: {
        last_snapshot: shared ? "Provider managed" : "Not guaranteed",
        recovery_on_restart: shared ? "Automatic" : "Process-local only",
        session_restore_on_refresh: "Available while the same store remains active",
        ui_state_preservation: shared ? "Cross-instance" : "Current worker only",
      },
      warnings: shared
        ? []
        : [
            "InlineLocalRedis is process-local and can reset on worker restart or scale-out.",
            "Configure shared Redis before enabling real exchange order placement.",
          ],
    })
  } catch (error) {
    console.error("[v0] Error getting persistence status:", error)
    return NextResponse.json(
      {
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}

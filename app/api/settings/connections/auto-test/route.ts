import { NextResponse } from "next/server"
import { initRedis, getEnabledConnections, updateConnection } from "@/lib/redis-db"
import { ConnectionCoordinator } from "@/lib/connection-coordinator"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Track last auto-test time to prevent excessive runs
let lastAutoTestTime = 0
const AUTO_TEST_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * POST /api/settings/connections/auto-test
 * Auto-tests all base connections. Called at startup and every 5 minutes.
 * Base connections are always enabled; this tests their connectivity.
 */
export async function POST() {
  try {
    const now = Date.now()

    // Prevent running more than once per interval
    if (now - lastAutoTestTime < AUTO_TEST_INTERVAL_MS - 10000) {
      return NextResponse.json({
        success: true,
        skipped: true,
        message: "Auto-test skipped (within cooldown)",
        nextTestIn: Math.ceil((AUTO_TEST_INTERVAL_MS - (now - lastAutoTestTime)) / 1000),
      })
    }

    lastAutoTestTime = now

    await initRedis()
    const baseConnections = await getEnabledConnections()

    if (baseConnections.length === 0) {
      return NextResponse.json({
        success: true,
        tested: 0,
        message: "No base connections to test",
      })
    }

    console.log(`[v0] [AutoTest] Testing ${baseConnections.length} base connections...`)

    const coordinator = ConnectionCoordinator.getInstance()
    const results: Array<{ id: string; name: string; status: string; error?: string }> = []

    // Test connections sequentially with small delay to avoid rate limits
    for (const conn of baseConnections) {
      try {
        const result = await coordinator.testConnection(conn.id)
        
        // Update connection with test result
        await updateConnection(conn.id, {
          ...conn,
          is_enabled: "1", // Always force-enable base connections
          last_test_status: result.success ? "success" : "failed",
          last_test_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })

        results.push({
          id: conn.id,
          name: conn.name || conn.exchange,
          status: result.success ? "success" : "failed",
          error: result.success ? undefined : (result.error || "Unknown"),
        })

        console.log(`[v0] [AutoTest] ${conn.name || conn.id}: ${result.success ? "OK" : "FAILED"}`)
      } catch (error) {
        // Even on test failure, keep connection enabled (base connections are always enabled)
        await updateConnection(conn.id, {
          ...conn,
          is_enabled: "1",
          last_test_status: "error",
          last_test_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })

        results.push({
          id: conn.id,
          name: conn.name || conn.exchange,
          status: "error",
          error: error instanceof Error ? error.message : "Unknown",
        })

        console.log(`[v0] [AutoTest] ${conn.name || conn.id}: ERROR - ${error instanceof Error ? error.message : "Unknown"}`)
      }

      // Small delay between tests to avoid exchange rate limits
      await new Promise(resolve => setTimeout(resolve, 500))
    }

    const successful = results.filter(r => r.status === "success").length
    const failed = results.filter(r => r.status !== "success").length

    console.log(`[v0] [AutoTest] Complete: ${successful}/${results.length} successful, ${failed} failed`)

    return NextResponse.json({
      success: true,
      tested: results.length,
      successful,
      failed,
      results,
      nextTestIn: AUTO_TEST_INTERVAL_MS / 1000,
    })
  } catch (error) {
    console.error("[v0] [AutoTest] Failed:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown" },
      { status: 500 }
    )
  }
}

import { NextResponse } from "next/server"
import { getAllConnections, initRedis, isConnectionAssignedToMain } from "@/lib/redis-db"
import { authorizeCronRequest, cronAuthorizationResponse } from "@/lib/cron-auth"
import { runSignalSourceOptimization } from "@/lib/signal-source-optimizer"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * Hourly Signal source optimization. The minute scheduler calls this route
 * every tick; the per-connection UTC-hour lock makes it run once per hour.
 * It re-validates, re-ranks and refills the active source set, and persists
 * an audit record. Public read-only candle replay only; never trades.
 */
async function sweep() {
  const startedAt = Date.now()
  await initRedis()
  const connections = await getAllConnections().catch(() => [] as any[])
  const results: Array<{ connectionId: string; ran: boolean; skipped?: string; changes?: number; active?: number; error?: string }> = []
  for (const connection of connections) {
    const connectionId = String((connection as any)?.id || "").trim()
    if (!connectionId || !isConnectionAssignedToMain(connection)) continue
    try {
      const outcome = await runSignalSourceOptimization({ connectionId, trigger: "hourly", fetchImpl: fetch })
      results.push({
        connectionId,
        ran: outcome.ran,
        skipped: outcome.skipped,
        changes: outcome.audit?.changes.length,
        active: outcome.snapshot?.activeCount,
      })
    } catch (error) {
      results.push({ connectionId, ran: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { ok: results.every((result) => !result.error), results, ms: Date.now() - startedAt }
}

export async function GET(request: Request) {
  const auth = authorizeCronRequest(request)
  if (!auth.ok) return cronAuthorizationResponse(auth)
  return NextResponse.json(await sweep())
}

export async function POST(request: Request) {
  const auth = authorizeCronRequest(request)
  if (!auth.ok) return cronAuthorizationResponse(auth)
  return NextResponse.json(await sweep())
}

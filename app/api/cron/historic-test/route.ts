import { NextResponse } from "next/server"
import { getAllConnections, getRedisClient, initRedis, isConnectionAssignedToMain } from "@/lib/redis-db"
import { authorizeCronRequest, cronAuthorizationResponse } from "@/lib/cron-auth"
import { maybeRunHistoricTest, type HistoricTestSkipReason } from "@/lib/historic-test-service"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * Historic Test trigger.
 *
 * Runs the validation pass for every connection-relevant lane whose recalc
 * interval has elapsed. The pass is simulation only: it reads stored history
 * and writes its validated set and report, and never reaches an exchange or
 * touches a position.
 *
 * Only connections assigned to Main are considered, for the same reason the
 * position sync skips the others: a lane the operator removed is not managed,
 * so validating it would spend time on exposure the system will not act on.
 */
interface HistoricTestSweepSummary {
  ok: boolean
  connectionsChecked: number
  connectionsRan: number
  connectionsNotRelevant: number
  skipped: Record<HistoricTestSkipReason, number>
  validatedCombinations: number
  errors: number
  ms: number
  results: Array<{
    connectionId: string
    ran: boolean
    skipped: HistoricTestSkipReason | null
    validated?: number
    scored?: number
    simulationErrors?: number
  }>
}

async function sweep(): Promise<HistoricTestSweepSummary> {
  const startedAt = Date.now()
  const summary: HistoricTestSweepSummary = {
    ok: true,
    connectionsChecked: 0,
    connectionsRan: 0,
    connectionsNotRelevant: 0,
    skipped: { disabled: 0, not_due: 0, no_symbols: 0 },
    validatedCombinations: 0,
    errors: 0,
    ms: 0,
    results: [],
  }

  await initRedis()
  const redis = getRedisClient() as any
  const connections = await getAllConnections().catch(() => [] as any[])

  for (const connection of connections) {
    const connectionId = String((connection as any)?.id || "").trim()
    if (!connectionId) continue
    if (!isConnectionAssignedToMain(connection)) {
      summary.connectionsNotRelevant++
      continue
    }
    summary.connectionsChecked++
    try {
      const outcome = await maybeRunHistoricTest(connectionId, {
        redis,
        loadSettings: async (id: string) =>
          (await redis.hgetall(`connection_settings:${id}`).catch(() => ({}))) as Record<string, unknown>,
      })
      if (outcome.skipped) summary.skipped[outcome.skipped]++
      if (outcome.ran && outcome.result) {
        summary.connectionsRan++
        summary.validatedCombinations += outcome.result.validated.length
      }
      summary.results.push({
        connectionId,
        ran: outcome.ran,
        skipped: outcome.skipped,
        validated: outcome.result?.validated.length,
        scored: outcome.result?.scores.length,
        simulationErrors: outcome.result?.errors,
      })
    } catch (error) {
      // One connection must never cost the sweep; the failure is counted and
      // reported so a silently skipped validation cannot look like a pass.
      summary.errors++
      summary.results.push({ connectionId, ran: false, skipped: null })
      console.warn(
        `[v0] [HistoricTest] ${connectionId} pass failed:`,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  summary.ms = Date.now() - startedAt
  return summary
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

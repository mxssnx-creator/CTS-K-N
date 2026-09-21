import { NextResponse } from "next/server"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { getCanonicalConnectionSettingsOverlay } from "@/lib/connection-settings-overlay"
import { normalizeHistoricTestSettings } from "@/lib/historic-test-settings"
import { historicTestReportKey, historicTestValidatedKey } from "@/lib/historic-test-scoring"

export const dynamic = "force-dynamic"

/**
 * Historic Test statistics for one connection.
 *
 * Reports what the last validation pass measured: the per-family ProfitFactor
 * and drawdown time, the validated combinations, and every rejection with its
 * reason. The distinction that matters to an operator is preserved end to end:
 * a family with `combinations: 0` was NOT measured (the replay cannot model it,
 * or nothing was scored), which is different from a family that was measured
 * and rejected. Collapsing those two into one "no result" would hide whether
 * the system has an opinion at all.
 */
function parse<T>(raw: unknown, fallback: T): T {
  try {
    return raw ? (JSON.parse(String(raw)) as T) : fallback
  } catch {
    return fallback
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const resolved = await params
    const connectionId = String(resolved?.id || "").trim()
    if (!connectionId) {
      return NextResponse.json({ success: false, error: "connectionId is required" }, { status: 400 })
    }

    await initRedis()
    const client = getRedisClient() as any
    const overlay = await getCanonicalConnectionSettingsOverlay(connectionId).catch(() => ({}))
    const settings = normalizeHistoricTestSettings(overlay as Record<string, unknown>)

    const [reportRaw, validatedRaw] = await Promise.all([
      client.get(historicTestReportKey(connectionId)).catch(() => null),
      client.get(historicTestValidatedKey(connectionId)).catch(() => null),
    ])
    const report = parse<any>(reportRaw, null)
    const validated = parse<any>(validatedRaw, null)

    const scores: any[] = Array.isArray(report?.scores) ? report.scores : []
    const rejected = scores.filter((score) => !score?.valid)

    return NextResponse.json({
      success: true,
      connectionId,
      enabled: settings.enabled,
      settings: {
        periodHours: settings.periodHours,
        minProfitFactor: settings.minProfitFactor,
        symbolCount: settings.symbolCount,
        recalcIntervalHours: settings.recalcIntervalHours,
        strategies: settings.strategies,
        symbols: settings.symbols,
      },
      // null when no pass has completed yet — not an empty result.
      ranAt: report?.ranAt ?? null,
      window: report?.window ?? null,
      symbols: report?.symbols ?? [],
      families: report?.families ?? [],
      summaries: Array.isArray(report?.summaries) ? report.summaries : [],
      validated: {
        count: Array.isArray(validated?.keys) ? validated.keys.length : 0,
        combinations: Array.isArray(validated?.combinations) ? validated.combinations : [],
      },
      rejected: {
        count: rejected.length,
        byReason: rejected.reduce((acc: Record<string, number>, score: any) => {
          const reason = String(score?.rejectedReason || "unknown")
          acc[reason] = (acc[reason] || 0) + 1
          return acc
        }, {}),
      },
      scoredCombinations: scores.length,
      simulationErrors: Number(report?.errors) || 0,
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}

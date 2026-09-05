import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

const INDICATION_TYPES = [
  "direction", "move", "active", "active_advanced", "special",
  "optimal", "auto", "common", "signal", "break", "trend",
] as const

type IndicationType = typeof INDICATION_TYPES[number]

interface MutableIndicationStats {
  count: number
  lastTrigger: string | null
  signalStrengthSum: number
  signalStrengthSamples: number
  profitFactorSum: number
  profitFactorSamples: number
}

function emptyStats(): Record<IndicationType, MutableIndicationStats> {
  return Object.fromEntries(INDICATION_TYPES.map((type) => [type, {
    count: 0,
    lastTrigger: null,
    signalStrengthSum: 0,
    signalStrengthSamples: 0,
    profitFactorSum: 0,
    profitFactorSamples: 0,
  }])) as Record<IndicationType, MutableIndicationStats>
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function toTimestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null
  const parsed = typeof value === "number" ? value : Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).toISOString()
}

function parseRows(raw: unknown): Record<string, unknown>[] {
  if (typeof raw !== "string" || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    const values = Array.isArray(parsed) ? parsed : [parsed]
    return values.filter((value): value is Record<string, unknown> =>
      Boolean(value) && typeof value === "object" && !Array.isArray(value),
    )
  } catch {
    return []
  }
}

async function readTypeSnapshot(client: any, connectionId: string, type: IndicationType) {
  const baseKey = `indications:${connectionId}:${type}`
  const countKey = `${baseKey}:count`
  const evaluatedKey = `${baseKey}:evaluated`
  const latestKey = `${baseKey}:latest`

  // The evaluator stores a bounded list at the base key while the statistics
  // tracker stores durable counters/latest samples beside it. Read those
  // exact keys directly; scanning a 500k+ key Redis database for every UI
  // poll made this endpoint take 10–15 seconds and frequently time out.
  const [snapshotRaw, latestRaw, countRaw, evaluatedRaw, listRaw] = await Promise.all([
    client.get(baseKey).catch(() => null),
    client.get(latestKey).catch(() => null),
    client.get(countKey).catch(() => null),
    client.get(evaluatedKey).catch(() => null),
    typeof client.lrange === "function"
      ? client.lrange(baseKey, 0, 999).catch(() => [])
      : Promise.resolve([]),
  ])

  const directRows = parseRows(snapshotRaw)
  const listRows = Array.isArray(listRaw)
    ? listRaw.flatMap((value: unknown) => parseRows(value))
    : []
  // A string snapshot and the list representation are alternate storage
  // shapes, never additive. Prefer the exact JSON snapshot when present.
  const rows = directRows.length > 0 ? directRows : listRows
  const latestRows = parseRows(latestRaw)
  const countHint = finiteNumber(countRaw) ?? finiteNumber(evaluatedRaw) ?? 0

  return { rows, latest: latestRows[0] || null, countHint }
}

/**
 * Current Main indication snapshots, scoped to an optional connection.
 *
 * The evaluator has two bounded storage shapes in the wild: a JSON snapshot
 * at `indications:{connectionId}:{type}` and a Redis list at that same key.
 * Durable `:count`, `:evaluated`, and `:latest` keys sit beside both shapes.
 * Read those known keys directly so a dashboard poll is independent of the
 * total Redis keyspace size.
 */
export async function GET(request: Request) {
  const stats = emptyStats()
  try {
    await initRedis()
    const client = getRedisClient()
    const params = new URL(request.url).searchParams
    const requestedConnectionId = String(
      params.get("connectionId") || params.get("connection_id") || "",
    ).trim()
    const connectionIds = new Set<string>()
    let malformedSnapshots = 0

    // Without a connection filter there is no bounded key index for this
    // legacy route. Keep the response deterministic and cheap; the dashboard
    // and analytics surfaces always provide their selected connection id.
    if (requestedConnectionId) {
      const snapshots = await Promise.all(
        INDICATION_TYPES.map((type) => readTypeSnapshot(client, requestedConnectionId, type)),
      )
      snapshots.forEach(({ rows, latest, countHint }, index) => {
        const type = INDICATION_TYPES[index]
        const aggregate = stats[type]
        if (rows.length > 0 || countHint > 0 || latest) connectionIds.add(requestedConnectionId)
        aggregate.count = rows.length > 0 ? rows.length : countHint

        for (const row of rows) {
          const strength = finiteNumber(
            row.signal_strength ?? row.rawSignalStrength ?? row.signalScore ?? row.strength,
          )
          if (strength !== null) {
            aggregate.signalStrengthSum += strength
            aggregate.signalStrengthSamples++
          }

          const pf = finiteNumber(row.profit_factor ?? row.profitFactor)
          if (pf !== null) {
            aggregate.profitFactorSum += pf
            aggregate.profitFactorSamples++
          }

          const rowTimestamp = toTimestamp(row.timestamp ?? row.updated_at ?? row.created_at)
          if (rowTimestamp && (!aggregate.lastTrigger || rowTimestamp > aggregate.lastTrigger)) {
            aggregate.lastTrigger = rowTimestamp
          }
        }

        const latestTimestamp = latest && toTimestamp(
          latest.timestamp ?? latest.updated_at ?? latest.created_at,
        )
        if (latestTimestamp && (!aggregate.lastTrigger || latestTimestamp > aggregate.lastTrigger)) {
          aggregate.lastTrigger = latestTimestamp
        }
      })
    }

    const indications = Object.fromEntries(INDICATION_TYPES.map((type) => {
      const value = stats[type]
      const avgSignalStrengthAvailable = value.signalStrengthSamples > 0
      const profitFactorAvailable = value.profitFactorSamples > 0
      return [type, {
        count: value.count,
        avgSignalStrength: avgSignalStrengthAvailable
          ? value.signalStrengthSum / value.signalStrengthSamples
          : null,
        avgSignalStrengthAvailable,
        lastTrigger: value.lastTrigger,
        lastTriggerAvailable: value.lastTrigger !== null,
        profitFactor: profitFactorAvailable
          ? value.profitFactorSum / value.profitFactorSamples
          : null,
        profitFactorAvailable,
      }]
    }))

    return NextResponse.json({
      success: true,
      connectionId: requestedConnectionId || null,
      connectionsIncluded: Array.from(connectionIds).sort(),
      indications,
      diagnostics: {
        malformedSnapshots,
        source: "durable-indication-counters",
      },
    })
  } catch (error) {
    console.error("[v0] Failed to fetch indications stats:", error)
    return NextResponse.json({
      success: false,
      error: "Failed to fetch indications stats",
      connectionId: null,
      connectionsIncluded: [],
      indications: Object.fromEntries(INDICATION_TYPES.map((type) => [type, {
        count: 0,
        avgSignalStrength: null,
        avgSignalStrengthAvailable: false,
        lastTrigger: null,
        lastTriggerAvailable: false,
        profitFactor: null,
        profitFactorAvailable: false,
      }])),
      diagnostics: { malformedSnapshots: 0, source: "unavailable" },
    }, { status: 500 })
  }
}

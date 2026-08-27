import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { scanRedisKeys } from "@/lib/redis-scan"

export const dynamic = "force-dynamic"

const INDICATION_TYPES = [
  "direction", "move", "active", "active_advanced", "special",
  "optimal", "auto", "common", "signal", "trend",
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

/**
 * Current Main indication snapshots, scoped to an optional connection.
 *
 * Only exact `indications:{connectionId}:{type}` JSON keys are consumed.
 * Count/latest/prehistoric metadata keys share this namespace but have other
 * Redis types or payload shapes and must never fail the whole statistics API.
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
    const pattern = requestedConnectionId
      ? `indications:${requestedConnectionId}:*`
      : "indications:*"
    const connectionIds = new Set<string>()
    let malformedSnapshots = 0

    for (const key of await scanRedisKeys(client, pattern)) {
      const match = /^indications:([^:]+):([^:]+)$/.exec(String(key))
      if (!match) continue
      const [, connectionId, rawType] = match
      if (requestedConnectionId && connectionId !== requestedConnectionId) continue
      if (!INDICATION_TYPES.includes(rawType as IndicationType)) continue

      const raw = await client.get(key).catch(() => null)
      if (typeof raw !== "string" || !raw.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        malformedSnapshots++
        continue
      }
      const rows = Array.isArray(parsed) ? parsed : [parsed]
      connectionIds.add(connectionId)
      const aggregate = stats[rawType as IndicationType]

      for (const candidate of rows) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue
        const row = candidate as Record<string, unknown>
        aggregate.count++

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
        source: "current-indication-snapshots",
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

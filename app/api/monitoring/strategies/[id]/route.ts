import { NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { isConnectionMainProcessing } from "@/lib/connection-state-utils"

export const dynamic = "force-dynamic"

type StrategyStage = "base" | "main" | "real" | "live"

const STRATEGY_STAGES: readonly StrategyStage[] = ["base", "main", "real", "live"]

const STAGE_FIELDS: Record<StrategyStage, {
  total: string
  totalFallback: string
  active: string
  activeFallback: string
  evaluated: string
  evaluatedFallback: string
  passed: string
  passedFallback: string
}> = {
  base: {
    total: "row_total",
    totalFallback: "created_sets",
    active: "row_total_open",
    activeFallback: "sets_running_now",
    evaluated: "row_total",
    evaluatedFallback: "evaluated",
    passed: "row_valid",
    passedFallback: "passed_sets",
  },
  main: {
    total: "row_overall",
    totalFallback: "created_sets",
    active: "row_overall_open",
    activeFallback: "sets_running_now",
    evaluated: "evaluated",
    evaluatedFallback: "input_sets",
    passed: "row_valid",
    passedFallback: "parent_sets_passed",
  },
  real: {
    total: "row_valid",
    totalFallback: "created_sets",
    active: "row_active",
    activeFallback: "sets_running_now",
    evaluated: "evaluated",
    evaluatedFallback: "created_sets",
    passed: "row_valid",
    passedFallback: "passed_sets",
  },
  live: {
    total: "row_mirrored",
    totalFallback: "created_sets",
    active: "row_active",
    activeFallback: "sets_running_now",
    evaluated: "row_total",
    evaluatedFallback: "evaluated",
    passed: "row_mirrored",
    passedFallback: "passed_sets",
  },
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await initRedis()
    const client = getRedisClient()
    const { id: connectionId } = await params

    if (!connectionId) {
      return NextResponse.json({ error: "Missing id parameter" }, { status: 400 })
    }

    const [bareConnection, settingsConnection, ...details] = await Promise.all([
      client.hgetall(`connection:${connectionId}`).catch(() => ({})),
      client.hgetall(`settings:connection:${connectionId}`).catch(() => ({})),
      ...STRATEGY_STAGES.map((stage) =>
        client.hgetall(`strategy_detail:${connectionId}:${stage}`).catch(() => ({})),
      ),
    ])
    const pipelineEnabled = isConnectionMainProcessing({
      ...(bareConnection || {}),
      ...(settingsConnection || {}),
    })

    // Base → Main → Real → Live is one coordinated processing pipeline.
    // Stages cannot be enabled or disabled independently; only their measured
    // populations differ.
    const strategies = STRATEGY_STAGES.map((stage, index) =>
      getStrategyData(stage, details[index] || {}, pipelineEnabled),
    )

    return NextResponse.json({ strategies })
  } catch (error) {
    console.error("[Strategies API] Error:", error)
    return NextResponse.json(
      {
        strategies: [
          { type: "base", enabled: false, rangeCount: 0, activePositions: 0, totalIndications: 0, successRate: 0 },
          { type: "main", enabled: false, rangeCount: 0, activePositions: 0, totalIndications: 0, successRate: 0 },
          { type: "real", enabled: false, rangeCount: 0, activePositions: 0, totalIndications: 0, successRate: 0 },
          { type: "live", enabled: false, rangeCount: 0, activePositions: 0, totalIndications: 0, successRate: 0 },
        ],
        error: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    )
  }
}

function numberValue(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
}

function aggregateFreshField(
  data: Record<string, string>,
  field: string,
  fallback: string,
): number {
  let total = 0
  let samples = 0
  const now = Date.now()
  for (const key of Object.keys(data)) {
    if (!key.startsWith("s:") || !key.endsWith(":ts")) continue
    const timestamp = numberValue(data[key])
    if (!(timestamp > 0) || now - timestamp > 5 * 60_000) continue
    const symbol = key.slice(2, -3)
    total += numberValue(data[`s:${symbol}:${field}`])
    samples++
  }
  return samples > 0 ? total : numberValue(data[field] ?? data[fallback])
}

function aggregateFreshEntries(data: Record<string, string>): number {
  let total = 0
  let samples = 0
  const now = Date.now()
  for (const key of Object.keys(data)) {
    if (!key.startsWith("s:") || !key.endsWith(":ts")) continue
    const timestamp = numberValue(data[key])
    if (!(timestamp > 0) || now - timestamp > 5 * 60_000) continue
    const symbol = key.slice(2, -3)
    total += numberValue(data[`s:${symbol}:entries`])
    samples++
  }
  return samples > 0
    ? total
    : numberValue(data.entries_total ?? data.entries_count)
}

function getStrategyData(
  type: StrategyStage,
  data: Record<string, string>,
  pipelineEnabled: boolean,
) {
  const fields = STAGE_FIELDS[type]
  const total = aggregateFreshField(data, fields.total, fields.totalFallback)
  const active = aggregateFreshField(data, fields.active, fields.activeFallback)
  const evaluated = aggregateFreshField(data, fields.evaluated, fields.evaluatedFallback)
  const passed = aggregateFreshField(data, fields.passed, fields.passedFallback)
  const successRate = evaluated > 0
    ? Math.min(100, Math.round((passed / evaluated) * 1_000) / 10)
    : 0

  return {
    type,
    enabled: pipelineEnabled,
    rangeCount: total,
    activePositions: active,
    totalIndications: aggregateFreshEntries(data),
    successRate,
    evaluatedCount: evaluated,
    passedCount: passed,
    semantics: "current-fresh-row-snapshot",
  }
}

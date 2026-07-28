import { NextResponse } from "next/server"
import {
  getAllConnections,
  getAssignedAndEnabledConnections,
  getRedisClient,
  initRedis,
} from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const fetchCache = "force-no-store"

type StageName = "base" | "main" | "real" | "live"

type StageSnapshot = {
  created: number
  evaluated: number
  passed: number
  running: number
  weightedPf: number
  pfWeight: number
  symbols: Set<string>
}

function emptyStageSnapshot(): StageSnapshot {
  return {
    created: 0,
    evaluated: 0,
    passed: 0,
    running: 0,
    weightedPf: 0,
    pfWeight: 0,
    symbols: new Set(),
  }
}

function finite(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Aggregate fresh per-symbol rows written by StrategyCoordinator.
 *
 * Top-level fields are overwritten by each symbol cycle and therefore cannot
 * be summed across a connection. The `s:{symbol}:*` bundle is the canonical
 * cross-symbol source; rows older than five minutes are excluded exactly as in
 * the progression statistics endpoint.
 */
function aggregateStage(
  raw: Record<string, string> | null | undefined,
  now = Date.now(),
): StageSnapshot {
  const result = emptyStageSnapshot()
  const rows = new Map<string, Record<string, number>>()
  for (const [field, value] of Object.entries(raw || {})) {
    const match = field.match(/^s:([^:]+):(created|evaluated|passed|running|apf|ts)$/)
    if (!match) continue
    const row = rows.get(match[1]) || {}
    row[match[2]] = finite(value)
    rows.set(match[1], row)
  }
  for (const [symbol, row] of rows) {
    const timestamp = row.ts || 0
    if (timestamp <= 0 || now - timestamp > 5 * 60_000) continue
    const created = Math.max(0, row.created || 0)
    result.created += created
    result.evaluated += Math.max(0, row.evaluated || 0)
    result.passed += Math.max(0, row.passed || 0)
    result.running += Math.max(0, row.running || 0)
    result.weightedPf += (row.apf || 0) * created
    result.pfWeight += created
    result.symbols.add(symbol)
  }
  return result
}

function mergeStage(target: StageSnapshot, source: StageSnapshot): void {
  target.created += source.created
  target.evaluated += source.evaluated
  target.passed += source.passed
  target.running += source.running
  target.weightedPf += source.weightedPf
  target.pfWeight += source.pfWeight
  for (const symbol of source.symbols) target.symbols.add(symbol)
}

function percentage(numerator: number, denominator: number): number {
  if (!(denominator > 0)) return 0
  return Number(((numerator / denominator) * 100).toFixed(2))
}

async function mapInBatches<T, R>(
  values: readonly T[],
  batchSize: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output: R[] = []
  for (let offset = 0; offset < values.length; offset += batchSize) {
    output.push(...await Promise.all(
      values.slice(offset, offset + batchSize).map(mapper),
    ))
  }
  return output
}

// GET functional overview metrics from current canonical ledgers only.
export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()
    const [allConnections, enabledConnections, databaseKeys] = await Promise.all([
      getAllConnections(),
      getAssignedAndEnabledConnections(),
      client.dbSize().catch(() => 0),
    ])

    const totals: Record<StageName, StageSnapshot> = {
      base: emptyStageSnapshot(),
      main: emptyStageSnapshot(),
      real: emptyStageSnapshot(),
      live: emptyStageSnapshot(),
    }
    let totalIndicationCycles = 0
    let totalStrategyCycles = 0
    let totalPositions = 0
    let totalLiveOpen = 0
    let totalLiveClosed = 0
    let prehistoricSymbolsProcessed = 0

    const connectionRows = await mapInBatches(
      enabledConnections,
      8,
      async (connection: any) => {
        const connectionId = String(connection.id || "")
        const [
          progression,
          base,
          main,
          real,
          live,
          pseudoOpen,
          liveOpen,
          liveClosed,
          prehistoricSymbols,
        ] = await Promise.all([
          client.hgetall(`progression:${connectionId}`).catch(() => ({})),
          client.hgetall(`strategy_detail:${connectionId}:base`).catch(() => ({})),
          client.hgetall(`strategy_detail:${connectionId}:main`).catch(() => ({})),
          client.hgetall(`strategy_detail:${connectionId}:real`).catch(() => ({})),
          client.hgetall(`strategy_detail:${connectionId}:live`).catch(() => ({})),
          client.scard(`pseudo_positions:${connectionId}`).catch(() => 0),
          client.llen(`live:positions:${connectionId}`).catch(() => 0),
          client.llen(`live:positions:${connectionId}:closed`).catch(() => 0),
          client.scard(`prehistoric:${connectionId}:symbols`).catch(() => 0),
        ])
        return {
          progression: progression as Record<string, string>,
          stages: {
            base: aggregateStage(base as Record<string, string>),
            main: aggregateStage(main as Record<string, string>),
            real: aggregateStage(real as Record<string, string>),
            live: aggregateStage(live as Record<string, string>),
          },
          pseudoOpen: finite(pseudoOpen),
          liveOpen: finite(liveOpen),
          liveClosed: finite(liveClosed),
          prehistoricSymbols: finite(prehistoricSymbols),
        }
      },
    )

    for (const row of connectionRows) {
      totalIndicationCycles += finite(row.progression.indication_cycle_count)
      totalStrategyCycles += finite(row.progression.strategy_cycle_count)
      for (const stage of ["base", "main", "real", "live"] as const) {
        mergeStage(totals[stage], row.stages[stage])
      }
      totalPositions += row.pseudoOpen + row.liveOpen + row.liveClosed
      totalLiveOpen += row.liveOpen
      totalLiveClosed += row.liveClosed
      prehistoricSymbolsProcessed += row.prehistoricSymbols
    }

    const activeSymbols = new Set<string>()
    for (const stage of Object.values(totals)) {
      for (const symbol of stage.symbols) activeSymbols.add(symbol)
    }
    const averagePf = (stage: StageName): number | null =>
      totals[stage].pfWeight > 0
        ? Number((totals[stage].weightedPf / totals[stage].pfWeight).toFixed(4))
        : null

    return NextResponse.json({
      symbolsActive: activeSymbols.size,
      indicationsCalculated: totalIndicationCycles,
      strategiesEvaluated:
        totals.base.evaluated +
        totals.main.evaluated +
        totals.real.evaluated +
        totals.live.evaluated,
      baseSetsCreated: totals.base.created > 0,
      mainSetsCreated: totals.main.created > 0,
      realSetsCreated: totals.real.created > 0,
      liveSetsCreated: totals.live.created > 0,
      positionsEntriesCreated: totalPositions,
      liveExchangePositions: totalLiveOpen,
      enabledConnections: enabledConnections.length,
      totalConnections: allConnections.length,
      persistenceKeys: finite(databaseKeys),
      counts: {
        indicationCycles: totalIndicationCycles,
        strategyCycles: totalStrategyCycles,
        baseStrategies: totals.base.created,
        mainStrategies: totals.main.created,
        realStrategies: totals.real.created,
        liveStrategies: totals.live.created,
        baseStrategiesEvaluated: totals.base.evaluated,
        mainStrategiesEvaluated: totals.main.evaluated,
        realStrategiesEvaluated: totals.real.evaluated,
        liveStrategiesEvaluated: totals.live.evaluated,
        baseRunning: totals.base.running,
        mainRunning: totals.main.running,
        realRunning: totals.real.running,
        liveRunning: totals.live.running,
        mainEvalPercentage: percentage(totals.main.passed, totals.main.evaluated),
        realEvalPercentage: percentage(totals.real.passed, totals.real.evaluated),
        liveMirrorPercentage: percentage(totals.live.passed, totals.live.evaluated),
        avgProfitFactorBase: averagePf("base"),
        avgProfitFactorMain: averagePf("main"),
        avgProfitFactorReal: averagePf("real"),
        avgProfitFactorLive: averagePf("live"),
      },
      positions: {
        currentLiveOpen: totalLiveOpen,
        retainedLiveClosed: totalLiveClosed,
        scope: "canonical-current-and-retained-ledgers",
      },
      prehistoricData: {
        symbolsProcessed: prehistoricSymbolsProcessed,
        // Exact byte accounting belongs to the database monitoring endpoint;
        // do not relabel an estimated item count as bytes.
        dataSizeBytes: 0,
        dataSizeMB: 0,
        sizeMeasured: false,
      },
      dataSource: "canonical-stage-and-position-ledgers",
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] [FunctionalOverview] Error:", error)
    return NextResponse.json(
      {
        error: "Failed to get functional overview",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}

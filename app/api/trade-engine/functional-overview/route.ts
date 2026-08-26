import { NextResponse } from "next/server"
import {
  getAllConnections,
  getAssignedAndEnabledConnections,
  getRedisClient,
  initRedis,
} from "@/lib/redis-db"
import {
  OVERVIEW_STAGE_ROW_FRESH_MS,
  OVERVIEW_STAGE_ROW_MAX_RETAIN_MS,
  aggregateFunctionalOverviewStage,
  emptyFunctionalOverviewStageSnapshot,
  mergeFunctionalOverviewStage,
  resolveOverviewActiveSymbols,
  type FunctionalOverviewStageSnapshot,
} from "@/lib/functional-overview-stage-snapshot"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const fetchCache = "force-no-store"

type StageName = "base" | "main" | "real" | "live"

function finite(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function percentage(numerator: number, denominator: number): number {
  if (!(denominator > 0)) return 0
  return Number(Math.min(100, (Math.max(0, numerator) / denominator) * 100).toFixed(2))
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

    const totals: Record<StageName, FunctionalOverviewStageSnapshot> = {
      base: emptyFunctionalOverviewStageSnapshot(),
      main: emptyFunctionalOverviewStageSnapshot(),
      real: emptyFunctionalOverviewStageSnapshot(),
      live: emptyFunctionalOverviewStageSnapshot(),
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
        const activeSymbols = resolveOverviewActiveSymbols(
          connection as Record<string, unknown>,
          progression as Record<string, unknown>,
        )
        return {
          progression: progression as Record<string, string>,
          stages: {
            base: aggregateFunctionalOverviewStage(base as Record<string, string>, { activeSymbols }),
            main: aggregateFunctionalOverviewStage(main as Record<string, string>, { activeSymbols }),
            real: aggregateFunctionalOverviewStage(real as Record<string, string>, {
              activeSymbols,
              // Real can materialise several physical Row/Block children from
              // one logical Main input Set. Its public funnel percentage must
              // compare logical survivors with that same logical denominator.
              passedField: "logical_passed_sets",
            }),
            live: aggregateFunctionalOverviewStage(live as Record<string, string>, { activeSymbols }),
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
        mergeFunctionalOverviewStage(totals[stage], row.stages[stage])
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
      stageSnapshots: Object.fromEntries(
        (["base", "main", "real", "live"] as const).map((stage) => [stage, {
          coveredSymbols: totals[stage].retainedRows,
          freshSymbols: totals[stage].freshRows,
          complete: totals[stage].complete,
          oldestUpdatedAt: totals[stage].oldestUpdatedAt || null,
          latestUpdatedAt: totals[stage].latestUpdatedAt || null,
        }]),
      ),
      stageSnapshotPolicy: {
        semantics: "last-observed-active-symbol-rows-with-explicit-freshness",
        freshMs: OVERVIEW_STAGE_ROW_FRESH_MS,
        maxRetainMs: OVERVIEW_STAGE_ROW_MAX_RETAIN_MS,
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

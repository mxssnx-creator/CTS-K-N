import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { NextRequest } from "next/server"
import { GET } from "@/app/api/connections/progression/[id]/logs/route"
import { buildSystemDetailFigures } from "@/components/dashboard/system-detail-data"
import { getRedisClient, initRedis } from "@/lib/redis-db"

describe("progression /logs route reads the keys the running engine writes", () => {
  const connectionId = `logs-sources-${process.pid}`
  const keys = [
    `progression:${connectionId}:main`,
    `progression:${connectionId}`,
    `prehistoric:${connectionId}:main`,
    `prehistoric:${connectionId}:main:symbols`,
    `prehistoric:${connectionId}:symbols`,
    `progression_lifecycle:${connectionId}`,
    `intervals:${connectionId}:processed_count`,
    `indications:${connectionId}:direction:evaluated`,
  ]

  afterAll(async () => {
    const client = getRedisClient()
    await Promise.all(keys.map((key) => client.del(key)))
  })

  test("Set totals, per-type indications, cycles, historic symbols and intervals come from written sources", async () => {
    await initRedis()
    const client = getRedisClient()
    await Promise.all([
      client.hset(`progression:${connectionId}:main`, {
        cycles_completed: "12",
        successful_cycles: "12",
        indication_cycle_count: "12",
        strategy_cycle_count: "11",
        realtime_cycle_count: "12",
        strategies_base_total: "40",
        strategies_main_total: "25",
        strategies_real_total: "9",
        indications_direction_count: "7",
        indications_move_count: "5",
        indications_active_count: "3",
        indications_optimal_count: "2",
        indications_auto_count: "4",
        indications_trend_count: "1",
        last_update: String(Date.now()),
      }),
      client.hset(`prehistoric:${connectionId}:main`, { intervals_processed: "480" }),
      client.sadd(`prehistoric:${connectionId}:main:symbols`, "BTCUSDT", "ETHUSDT"),
      // Keys nothing in the running engine writes: they must not be used.
      client.sadd(`prehistoric:${connectionId}:symbols`, "OLD1", "OLD2", "OLD3", "OLD4", "OLD5"),
      client.hset(`progression_lifecycle:${connectionId}`, { strategies_base_total: "999" }),
      client.set(`intervals:${connectionId}:processed_count`, "999"),
      client.set(`indications:${connectionId}:direction:evaluated`, "999"),
    ])

    const response = await GET(
      new NextRequest(`http://localhost/api/connections/progression/${connectionId}/logs`),
      { params: Promise.resolve({ id: connectionId }) },
    )
    const body = await response.json()
    const state = body.progressionState

    expect(body.success).toBe(true)
    expect(state).toMatchObject({
      setsBaseCount: 40,
      setsMainCount: 25,
      setsRealCount: 9,
      setsTotalCount: 9,
      indicationEvaluatedDirection: 7,
      indicationEvaluatedMove: 5,
      indicationEvaluatedActive: 3,
      indicationEvaluatedOptimal: 2,
      indicationEvaluatedAuto: 4,
      indicationEvaluatedTrend: 1,
      indicationCycleCount: 12,
      strategyCycleCount: 11,
      realtimeCycleCount: 12,
      intervalsProcessed: 480,
      prehistoricSymbolsProcessedCount: 2,
    })
    expect(state.processingCompleteness).toMatchObject({
      indicationsRunning: true,
      strategiesRunning: true,
      realtimeRunning: true,
    })
    const storedSchema = await client.get("_schema_version")
    expect(state.schemaVersion).toBe(storedSchema === null ? null : Number(storedSchema))
  })
})

describe("System Detail Panel figures", () => {
  test("a source that did not answer renders as missing, never as 0", () => {
    const figures = buildSystemDetailFigures(null, null)
    expect(figures.engine).toEqual({ totalCycles: null, lastCycleMs: null, successRate: null })
    expect(figures.indications.total).toBeNull()
    expect(figures.positions).toEqual({ pseudo: null, real: null, live: null })
    expect(figures.database.schemaVersion).toBeNull()
  })

  test("written counters map one-to-one and positions are never duplicated or summed", () => {
    const figures = buildSystemDetailFigures(
      {
        cyclesCompleted: 20,
        cycleSuccessRate: 95,
        cycleTimeMs: 0,
        indicationEvaluatedDirection: 7,
        indicationEvaluatedMove: 5,
        indicationEvaluatedActive: 3,
        indicationEvaluatedOptimal: 2,
        indicationEvaluatedAuto: 4,
        indicationEvaluatedTrend: 1,
        setsBaseCount: 40,
        setsMainCount: 25,
        setsRealCount: 9,
        schemaVersion: 91,
      },
      { openPositions: { pseudo: { open: 6 }, real: { open: 2 }, live: { open: 1 } } },
    )
    expect(figures.engine).toEqual({ totalCycles: 20, lastCycleMs: null, successRate: 95 })
    expect(figures.indications).toMatchObject({ auto: 4, total: 22 })
    expect(figures.strategies).toEqual({ base: 40, main: 25, real: 9 })
    expect(figures.positions).toEqual({ pseudo: 6, real: 2, live: 1 })
    expect(figures.database.schemaVersion).toBe(91)
  })

  test("no success rate exists before the first cycle", () => {
    expect(buildSystemDetailFigures({ cyclesCompleted: 0, cycleSuccessRate: 0 }, null).engine.successRate).toBeNull()
  })

  test("the panel renders the mapped figures with a missing-value placeholder", () => {
    const panel = readFileSync(resolve(process.cwd(), "components/dashboard/system-detail-panel.tsx"), "utf8")
    expect(panel).toContain("figures: buildSystemDetailFigures(progressionState, statsData)")
    expect(panel).toContain('{value ?? "—"}')
    expect(panel).not.toContain("auto: 0,")
    expect(panel).not.toContain("migrations: 0")
    expect(panel).not.toContain("main: statsData?.openPositions?.real?.open")
  })

  test("tile and heading tones are literal Tailwind classes, never built from a color name", () => {
    const panel = readFileSync(resolve(process.cwd(), "components/dashboard/system-detail-panel.tsx"), "utf8")
    // Strip comments: the explanation may quote the old pattern.
    const code = panel.replace(/\/\/.*$/gm, "")
    expect(code).not.toMatch(/(bg|text|border)-\$\{/)
    expect(panel).toContain('green: { tile: "bg-green-50 dark:bg-green-950/30"')
  })
})

import {
  HISTORIC_FOUR_HOUR_BUCKET_MS,
  createHistoricFourHourAccumulator,
  historicEpochMs,
  historicFourHourBucketStartMs,
  historicFourHourBucketStarts,
  historicFourHourRedisIncrements,
  markHistoricFourHourCoverage,
  parseHistoricFourHourAggregate,
  recordHistoricFourHourIndications,
  recordHistoricFourHourPositions,
} from "@/lib/historic-four-hour-stats"
import fs from "node:fs"
import path from "node:path"

function aggregateHash(
  accumulator: ReturnType<typeof createHistoricFourHourAccumulator>,
  metadata: Record<string, string> = {},
): Record<string, string> {
  return Object.fromEntries([
    ...historicFourHourRedisIncrements(accumulator).map(({ field, value }) => [field, String(value)]),
    ...Object.entries(metadata),
  ])
}

describe("historic four-hour config/set/indication statistics", () => {
  test("uses fixed elapsed UTC boundaries for seconds, milliseconds, and ISO timestamps", () => {
    const exactFourUtc = Date.parse("2026-08-24T04:00:00.000Z")
    expect(historicEpochMs(exactFourUtc / 1000)).toBe(exactFourUtc)
    expect(historicEpochMs(String(exactFourUtc))).toBe(exactFourUtc)
    expect(historicEpochMs("2026-08-24T04:00:00.000Z")).toBe(exactFourUtc)
    expect(historicFourHourBucketStartMs("2026-08-24T03:59:59.999Z")).toBe(
      Date.parse("2026-08-24T00:00:00.000Z"),
    )
    expect(historicFourHourBucketStartMs("2026-08-24T04:00:00.000Z")).toBe(exactFourUtc)
    expect(historicFourHourBucketStartMs("2026-08-24T07:59:59.999Z")).toBe(exactFourUtc)
    expect(historicFourHourBucketStartMs("2026-08-24T08:00:00.000Z")).toBe(
      exactFourUtc + HISTORIC_FOUR_HOUR_BUCKET_MS,
    )
  })

  test("keeps every covered window and counts exhaustive config evaluations even with zero results", () => {
    const accumulator = createHistoricFourHourAccumulator()
    const starts = historicFourHourBucketStarts([
      "2026-08-24T00:01:00Z",
      "2026-08-24T04:01:00Z",
      "2026-08-24T08:01:00Z",
      "2026-08-24T12:01:00Z",
      "2026-08-24T16:01:00Z",
      "2026-08-24T20:01:00Z",
      "2026-08-25T00:01:00Z",
    ])
    markHistoricFourHourCoverage(accumulator, starts, {
      indicationConfigs: 729,
      strategyConfigs: 256,
    })

    const stats = parseHistoricFourHourAggregate(aggregateHash(accumulator))
    expect(stats.buckets).toHaveLength(7)
    expect(stats.buckets.every((bucket) => bucket.symbols === 1)).toBe(true)
    expect(stats.buckets.every((bucket) => bucket.indicationConfigs === 729)).toBe(true)
    expect(stats.buckets.every((bucket) => bucket.strategyConfigs === 256)).toBe(true)
    expect(stats.buckets.every((bucket) => bucket.indications.total === 0)).toBe(true)
    expect(stats.buckets.every((bucket) => bucket.setResults.total === 0)).toBe(true)
    expect(stats.buckets.every((bucket) => bucket.performance.pfCoordinate === null)).toBe(true)
  })

  test("counts all indication aliases by exact four-hour result timestamp", () => {
    const accumulator = createHistoricFourHourAccumulator()
    recordHistoricFourHourIndications(accumulator, [
      { timestamp: "2026-08-24T01:00:00Z", signal: "buy" },
      { timestamp: "2026-08-24T02:00:00Z", signal: "sell" },
      { timestamp: "2026-08-24T05:00:00Z", signal: "neutral" },
      { timestamp: "invalid", signal: "buy" },
    ], 3)

    const stats = parseHistoricFourHourAggregate(aggregateHash(accumulator))
    expect(stats.buckets).toHaveLength(2)
    expect(stats.buckets[0].indications).toEqual({ total: 6, buy: 3, sell: 3, neutral: 0 })
    expect(stats.buckets[1].indications).toEqual({ total: 3, buy: 0, sell: 0, neutral: 3 })
    expect(stats.summary.indications.total).toBe(9)
  })

  test("treats PF 1.00 as neutral and excludes open set results from realised math", () => {
    const accumulator = createHistoricFourHourAccumulator()
    recordHistoricFourHourPositions(accumulator, [
      {
        entry_time: "2026-08-24T00:30:00Z",
        exit_time: "2026-08-24T01:30:00Z",
        status: "closed",
        result: 0,
        position_cost_pct: 0.1,
      },
      {
        entry_time: "2026-08-24T02:30:00Z",
        status: "open",
        result: 99,
        position_cost_pct: 0.1,
      },
    ])

    const bucket = parseHistoricFourHourAggregate(aggregateHash(accumulator)).buckets[0]
    expect(bucket.setResults).toEqual({ total: 2, closed: 1, open: 1 })
    expect(bucket.performance.netPnlPct).toBe(0)
    expect(bucket.performance.averageNetPnlPct).toBe(0)
    expect(bucket.performance.averagePositionCostPct).toBe(0.1)
    expect(bucket.performance.signedPositionCostMultiple).toBe(0)
    expect(bucket.performance.pfCoordinate).toBe(1)
    expect(bucket.performance.meetsMinimumPf).toBe(false)
  })

  test("maps total net result of one average PositionCost to the exact 1.10 minimum", () => {
    const accumulator = createHistoricFourHourAccumulator()
    recordHistoricFourHourPositions(accumulator, [
      {
        entry_time: "2026-08-24T00:30:00Z",
        exit_time: "2026-08-24T01:00:00Z",
        status: "closed",
        result: 0.1,
        position_cost_pct: 0.1,
      },
      {
        entry_time: "2026-08-24T01:30:00Z",
        exit_time: "2026-08-24T02:00:00Z",
        status: "closed",
        result: 0.2,
        position_cost_pct: 0.2,
      },
    ])

    const performance = parseHistoricFourHourAggregate(aggregateHash(accumulator)).buckets[0].performance
    expect(performance.netPnlPct).toBeCloseTo(0.3, 12)
    expect(performance.averageNetPnlPct).toBeCloseTo(0.15, 12)
    expect(performance.averagePositionCostPct).toBeCloseTo(0.15, 12)
    expect(performance.signedPositionCostMultiple).toBeCloseTo(1, 12)
    expect(performance.pfCoordinate).toBe(1.1)
    expect(performance.meetsMinimumPf).toBe(true)
  })

  test("uses cost-weighted totals, never deducts PositionCost twice, and preserves negative coordinates", () => {
    const accumulator = createHistoricFourHourAccumulator()
    recordHistoricFourHourPositions(accumulator, [
      {
        exit_time: "2026-08-24T01:00:00Z",
        status: "closed",
        // Historic result is already net after its 0.10% PositionCost.
        result: 0.2,
        position_cost_pct: 0.1,
      },
      {
        exit_time: "2026-08-24T02:00:00Z",
        status: "closed",
        result: -0.1,
        position_cost_pct: 0.3,
      },
    ])

    const performance = parseHistoricFourHourAggregate(aggregateHash(accumulator)).buckets[0].performance
    // Sum(net)=0.10; Sum(cost)=0.40; R=0.25 and PF-coordinate=1.025.
    expect(performance.netPnlPct).toBeCloseTo(0.1, 12)
    expect(performance.signedPositionCostMultiple).toBeCloseTo(0.25, 12)
    expect(performance.pfCoordinate).toBe(1.025)
    expect(performance.meetsMinimumPf).toBe(false)
    // Classic realised PF is a separate gross-win / gross-loss diagnostic.
    expect(performance.realizedProfitFactor).toBe(2)
    expect(performance.realizedProfitFactorInfinite).toBe(false)

    const negative = createHistoricFourHourAccumulator()
    recordHistoricFourHourPositions(negative, [{
      exit_time: "2026-08-24T01:00:00Z",
      status: "closed",
      result: -0.1,
      position_cost_pct: 0.1,
    }])
    expect(parseHistoricFourHourAggregate(aggregateHash(negative)).buckets[0].performance.pfCoordinate).toBe(0.9)
  })

  test("reports an infinite classic realised PF separately from the finite PositionCost coordinate", () => {
    const accumulator = createHistoricFourHourAccumulator()
    recordHistoricFourHourPositions(accumulator, [{
      exit_time: "2026-08-24T01:00:00Z",
      status: "closed",
      result: 0.1,
      position_cost_pct: 0.1,
    }], 2)

    const performance = parseHistoricFourHourAggregate(aggregateHash(accumulator)).buckets[0].performance
    expect(performance.pfCoordinate).toBe(1.1)
    expect(performance.realizedProfitFactor).toBeNull()
    expect(performance.realizedProfitFactorInfinite).toBe(true)
    expect(performance.wins).toBe(2)
  })

  test("serializes and parses every bucket in chronological order with completion metadata", () => {
    const accumulator = createHistoricFourHourAccumulator()
    markHistoricFourHourCoverage(accumulator, [
      Date.parse("2026-08-24T08:00:00Z"),
      Date.parse("2026-08-24T00:00:00Z"),
      Date.parse("2026-08-24T04:00:00Z"),
    ], { indicationConfigs: 2, strategyConfigs: 3 })

    const stats = parseHistoricFourHourAggregate(aggregateHash(accumulator, {
      schema_version: "1",
      generation: "epoch-42",
      complete: "1",
      updated_at_ms: String(Date.parse("2026-08-24T12:00:00Z")),
    }))

    expect(stats.complete).toBe(true)
    expect(stats.generation).toBe("epoch-42")
    expect(stats.updatedAt).toBe("2026-08-24T12:00:00.000Z")
    expect(stats.bucketCount).toBe(3)
    expect(stats.buckets.map((bucket) => bucket.bucketStart)).toEqual([
      "2026-08-24T00:00:00.000Z",
      "2026-08-24T04:00:00.000Z",
      "2026-08-24T08:00:00.000Z",
    ])
    expect(stats.summary.symbols).toBe(3)
    expect(stats.summary.indicationConfigs).toBe(6)
    expect(stats.summary.strategyConfigs).toBe(9)
  })

  test("wires the exhaustive stats through the API and the final card detail panel", () => {
    const read = (relativePath: string) => fs.readFileSync(path.join(process.cwd(), relativePath), "utf8")
    const route = read("app/api/connections/progression/[id]/stats/route.ts")
    const card = read("components/dashboard/active-connection-card.tsx")
    const panel = read("components/dashboard/historic-four-hour-stats.tsx")

    expect(route).toContain("historicFourHour,")
    expect(card).toContain("stats={statsSnapshot?.historicFourHour ?? null}")
    expect(card.lastIndexOf("<HistoricFourHourStatsPanel")).toBeGreaterThan(
      card.lastIndexOf("Diagnostic Tools"),
    )
    expect(panel).toContain("without sampling")
    expect(panel).toContain("1.00 is neutral")
    expect(panel).toContain("1.10 is")
    expect(panel).toContain("Classic realised PF is shown separately")
  })
})

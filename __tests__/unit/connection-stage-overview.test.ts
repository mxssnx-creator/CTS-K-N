import {
  buildConnectionStageOverview,
  calculateRealLivePfComparison,
  resolveRealProfitFactorSnapshot,
} from "@/lib/connection-stage-overview"

const closed = (overrides: Record<string, unknown> = {}) => ({
  entryPrice: 100,
  closePrice: 101,
  direction: "long",
  executedQuantity: 1,
  positionCostPct: 0.1,
  realProfitFactorAtEntry: 2,
  closedAt: 1_000,
  ...overrides,
})

describe("connection stage overview", () => {
  test("compares the same newest Real and Live position sample on a 1.0 parity basis", () => {
    const comparison = calculateRealLivePfComparison([
      closed({ closedAt: 3_000, closePrice: 101 }),
      closed({ closedAt: 2_000, closePrice: 99.5 }),
      closed({ closedAt: 1_000, closePrice: 101.5, realProfitFactorAtEntry: undefined }),
    ])

    // Live: +10R / -5R = 2 PF; Real snapshots average to 2 => parity 1.
    expect(comparison).toMatchObject({
      window: 50,
      availableClosedPositions: 3,
      matchedPositions: 2,
      missingRealSnapshots: 1,
      realProfitFactor: 2,
      liveProfitFactor: 2,
      ratio: 1,
      ratioPercent: 100,
      differencePercent: 0,
      status: "parity",
    })
  })

  test("supports legacy nested Real PF snapshots", () => {
    expect(resolveRealProfitFactorSnapshot({ prevPos: JSON.stringify({ profitFactor: 1.5 }) })).toBe(1.5)
  })

  test("excludes incomplete exchange settlement from Real-to-Live PF", () => {
    expect(calculateRealLivePfComparison([
      closed({
        realizedPnL: 0,
        closePrice: undefined,
        realizedPnlComplete: false,
        realizedPnlSource: "exchange_unresolved",
      }),
    ])).toMatchObject({
      availableClosedPositions: 0,
      matchedPositions: 0,
      liveProfitFactor: null,
      status: "unavailable",
    })
  })

  test("keeps stage identities, variant totals, directions, and independent running orders coherent", () => {
    const overview = buildConnectionStageOverview({
      base: { totalOpen: 10, validOpen: 8, pfMinimum: 0.8 },
      main: {
        validOpen: 8,
        overallOpen: 14,
        breakdown: { standard: 4, trailing: 2, positionCount: 3, block: 3, dca: 2 },
      },
      real: { valid: 7, active: 4, activeExactSets: 11 },
      live: {
        bySymbol: [
          { symbol: "BTCUSDT", long: 2, short: 1 },
          { symbol: "ETHUSDT", long: 0, short: 3 },
        ],
        positions: [
          { status: "pending_fill", orderId: "entry-1", stopLossOrderId: "sl-1", takeProfitOrderId: "tp-1" },
          { status: "open", orderId: "filled-entry", stopLossOrderId: "sl-2", takeProfitOrderId: "tp-2" },
        ],
        ordersPlaced: 25,
      },
      cycle: {
        base: { total: 100, valid: 80 },
        main: { valid: 80, overall: 140 },
        real: { valid: 70, active: 4, activeExactSets: 11 },
        live: { total: 9, mirrored: 6, executable: 5 },
      },
      snapshot: {
        updatedAt: Date.now() - 1_000,
        engineRunning: true,
        coverage: { processed: 12, total: 12, complete: true },
        stages: {
          base: { covered: 12, total: 12, fresh: true, complete: true },
          main: { covered: 12, total: 12, fresh: true, complete: true },
          real: { covered: 12, total: 12, fresh: true, complete: true },
        },
      },
      closedPositions: [],
    })

    expect(overview.schemaVersion).toBe(3)
    expect(overview.semantics).toBe("latest-cycle-and-current-open-stage-relations")
    expect(overview.snapshot).toMatchObject({
      fresh: true,
      maxAgeMs: 5 * 60_000,
      complete: true,
      engineRunning: true,
      coverage: { processed: 12, total: 12, percent: 100, complete: true },
    })
    expect(overview.latestCycle).toMatchObject({
      base: { total: 100, valid: 80 },
      main: { valid: 80, overall: 140 },
      real: { valid: 70, active: 4, activeExactSets: 11 },
      live: { total: 9, mirrored: 6, executable: 5 },
    })
    expect(overview.base).toMatchObject({ total: 10, valid: 8, pfMinimum: 0.8, validPercent: 80 })
    expect(overview.main).toMatchObject({ valid: 8, overall: 14, additional: 6, breakdownComplete: true })
    expect(overview.real).toMatchObject({ valid: 7, active: 4, activeExactSets: 11 })
    expect(overview.live).toMatchObject({
      total: 6,
      long: 2,
      short: 4,
      symbols: 2,
      orders: { placed: 25, running: 3, pendingEntry: 1, control: 2 },
    })
    expect(overview.integrity).toEqual({ valid: true, errors: [] })
  })

  test("surfaces a missing Main breakdown instead of silently accepting it", () => {
    const overview = buildConnectionStageOverview({
      base: { totalOpen: 1, validOpen: 1, pfMinimum: 0.8 },
      main: { validOpen: 1, overallOpen: 2 },
      real: { valid: 1, active: 1 },
      live: {},
    })
    expect(overview.main.breakdownComplete).toBe(false)
    expect(overview.integrity.valid).toBe(false)
    expect(overview.integrity.errors).toContain("Main breakdown 0 does not equal Overall 2")
  })

  test("keeps partial/stopped snapshot coverage explicit without changing cycle counts", () => {
    const overview = buildConnectionStageOverview({
      base: { totalOpen: 0, validOpen: 0, pfMinimum: 1.1 },
      main: { validOpen: 0, overallOpen: 0 },
      real: { valid: 7, active: 0 },
      live: {},
      cycle: { base: { total: 20, valid: 11 } },
      snapshot: {
        updatedAt: Date.now() - 10 * 60_000,
        engineRunning: false,
        coverage: { processed: 11, total: 12, complete: false },
      },
    })

    expect(overview.snapshot).toMatchObject({
      fresh: false,
      complete: false,
      engineRunning: false,
      coverage: { processed: 11, total: 12, percent: 91.7, complete: false },
    })
    expect(overview.latestCycle.base).toEqual({ total: 20, valid: 11 })
    expect(overview.base.total).toBe(0)
  })
})

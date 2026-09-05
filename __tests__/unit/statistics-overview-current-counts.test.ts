import { projectOverviewCurrentCounts } from "@/lib/statistics-overview-current-counts"

describe("current Overview counts", () => {
  test("preserves measured zeros despite historical throughput and mirrored rows", () => {
    const result = projectOverviewCurrentCounts({
      activeCounts: { indications: { direction: 0, total: 0 }, strategies: { total: 0 } },
      breakdown: { indications: { direction: 1000, total: 2000 }, strategies: { live: 1 } },
      realtime: { indicationsTotal: 2000 },
      activeProgressing: { strategies: { total: { sets: 99 } } },
      liveExecution: { positionsCreated: 0, winRate: 0, fillRate: 0 },
      strategyDetail: { live: { winRate: 90, passRatio: 100 } },
    })
    expect(Object.values(result)).toEqual(Array(12).fill(0))
  })

  test("shows the current sample and confirmed execution totals independently", () => {
    expect(projectOverviewCurrentCounts({
      activeCounts: {
        indications: { direction: 12, move: 8, total: 20 },
        strategies: { base: 7, main: 5, real: 3, total: 15 },
      },
      liveExecution: { positionsCreated: 48, winRate: 62.5, fillRate: 100 },
    })).toMatchObject({
      activeIndDirection: 12, activeIndMove: 8, activeIndTotal: 20,
      activeStratBase: 7, activeStratMain: 5, activeStratReal: 3, activeStratTotal: 3,
      stratLive: 48, liveWinRate: 62.5, liveFillRate: 100,
    })
  })

  test("keeps the observed empty Real basket at zero despite a retained API total", () => {
    expect(projectOverviewCurrentCounts({
      activeCounts: { strategies: { base: 0, main: 0, real: 0, live: 0, total: 15805 } },
    })).toMatchObject({ activeStratBase: 0, activeStratMain: 0, activeStratReal: 0, activeStratTotal: 0 })
  })

  test("missing or invalid current observations never invent activity", () => {
    expect(projectOverviewCurrentCounts({
      activeCounts: { indications: { total: "NaN" }, strategies: { total: -1 } },
      breakdown: { strategies: { live: 700 } },
    })).toMatchObject({ stratLive: 0, activeIndTotal: 0, activeStratTotal: 0, liveFillRate: 0 })
  })
})

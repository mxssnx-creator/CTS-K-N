import {
  HISTORIC_REALIZED_PROFIT_FACTOR_MAX,
  resolveHistoricProfitFactor,
} from "@/lib/historic-profit-factor"
import fs from "node:fs"
import path from "node:path"

describe("historic realised profit-factor source isolation", () => {
  test("preserves a valid all-loss PF 0 with its exact sample count", () => {
    expect(resolveHistoricProfitFactor({
      historic_avg_profit_factor: "0.0000",
      historic_avg_profit_factor_count: "40",
    })).toEqual({
      value: 0,
      count: 40,
      available: true,
      source: "prehistoric-closed-results",
    })
  })

  test("distinguishes no closed historic results from a measured zero", () => {
    expect(resolveHistoricProfitFactor({
      historic_avg_profit_factor: "0.0000",
      historic_avg_profit_factor_count: "0",
    })).toEqual({
      value: 0,
      count: 0,
      available: false,
      source: "no-closed-prehistoric-results",
    })
  })

  test("never substitutes a different stage when historic fields are absent", () => {
    expect(resolveHistoricProfitFactor({})).toEqual({
      value: 0,
      count: 0,
      available: false,
      source: "unavailable",
    })
  })

  test("rejects partial or malformed aggregates and retains the writer ceiling", () => {
    expect(resolveHistoricProfitFactor({ historic_avg_profit_factor: "2.5" }).source)
      .toBe("invalid-prehistoric-aggregate")
    expect(resolveHistoricProfitFactor({
      historic_avg_profit_factor: "NaN",
      historic_avg_profit_factor_count: "4",
    }).source).toBe("invalid-prehistoric-aggregate")
    expect(resolveHistoricProfitFactor({
      historic_avg_profit_factor: "99",
      historic_avg_profit_factor_count: "3",
    }).value).toBe(HISTORIC_REALIZED_PROFIT_FACTOR_MAX)
  })

  test("wires source and sample availability through API and operator UIs", () => {
    const read = (relativePath: string) =>
      fs.readFileSync(path.join(process.cwd(), relativePath), "utf8")
    const statsRoute = read("app/api/connections/progression/[id]/stats/route.ts")
    const engineStatsRoute = read("app/api/trading/engine-stats/route.ts")
    const quickstart = read("components/dashboard/quickstart-section.tsx")
    const logistics = read("app/logistics/page.tsx")
    const coordinator = read("lib/strategy-coordinator.ts")

    expect(statsRoute).toContain("resolveHistoricProfitFactor(prehistoricHash)")
    expect(statsRoute).toContain("avgProfitFactorAvailable:")
    expect(statsRoute).not.toContain("if (fromPrehistoric > 0)")
    expect(quickstart).toContain("stats.historicAvgProfitFactorAvailable")
    expect(quickstart).toContain('label="Historic PF"')
    expect(logistics).toContain("measuredStageProfitFactor(")
    expect(engineStatsRoute).toContain("avgProfitFactorCount")
    expect(engineStatsRoute).toContain("Object.prototype.hasOwnProperty.call(baseDetail")
    expect(coordinator.match(/avg_profit_factor_source: "realtime_coordination"/g)).toHaveLength(3)
  })
})

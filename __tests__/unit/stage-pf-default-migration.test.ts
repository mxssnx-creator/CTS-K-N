import { InlineLocalRedis } from "@/lib/redis-db"
import { lowerStagePfDefaults, migrateStagePfDefaults, stagePfThresholdStage } from "@/lib/stage-pf-default-migration"
import { MAIN_TRADE_STAGE_PF_DEFAULTS } from "@/lib/main-trade-profit-factor"

/**
 * Operator decision 2026-10-07: stage PF defaults 1.30 -> 1.10. Stored copies
 * of the previous default move; operator choices and Block ratios stay.
 */
describe("stage PF defaults 1.30 -> 1.10 (migration 110)", () => {
  test("the system defaults are 1.10 for every stage", () => {
    expect(MAIN_TRADE_STAGE_PF_DEFAULTS).toEqual({ base: 1.1, main: 1.1, real: 1.1, live: 1.1 })
  })

  test("the field matcher knows the stage aliases and never matches Block ratios", () => {
    expect(stagePfThresholdStage("baseProfitFactor")).toBe("base")
    expect(stagePfThresholdStage("main_min_profit_factor")).toBe("main")
    expect(stagePfThresholdStage("liveTradeProfitFactorMinReal")).toBe("real")
    expect(stagePfThresholdStage("base", "profitFactorMin")).toBe("base")
    expect(stagePfThresholdStage("min_profit_factor", "live")).toBe("live")
    expect(stagePfThresholdStage("blockProfitFactorRatio")).toBeNull()
    expect(stagePfThresholdStage("blockRowLiveProfitFactorRatio")).toBeNull()
    expect(stagePfThresholdStage("profitFactor")).toBeNull()
  })

  test("only a stored previous default moves, also nested; the stored type is kept", () => {
    const document: Record<string, any> = {
      baseProfitFactor: "1.3",
      mainProfitFactor: 1.3,
      realProfitFactor: 1.12,
      liveProfitFactor: "2.3",
      profitFactorMin: { base: 1.3, live: "1.30" },
      strategies: { main: { base: { min_profit_factor: 1.3 }, real: { min_profit_factor: 1.4 } } },
      blockProfitFactorRatio: "1.3",
      blockSettings: { mainProfitFactor: 1.3 },
      leverage: 1.3,
    }
    expect(lowerStagePfDefaults(document)).toBe(true)
    expect(document).toEqual({
      baseProfitFactor: "1.1",
      mainProfitFactor: 1.1,
      realProfitFactor: 1.12,
      liveProfitFactor: "2.3",
      profitFactorMin: { base: 1.1, live: "1.1" },
      strategies: { main: { base: { min_profit_factor: 1.1 }, real: { min_profit_factor: 1.4 } } },
      blockProfitFactorRatio: "1.3",
      blockSettings: { mainProfitFactor: 1.3 },
      leverage: 1.3,
    })
    expect(lowerStagePfDefaults({ baseProfitFactor: 1.32, mainProfitFactor: true })).toBe(false)
  })

  test("moves saved app, connection and Direct-Trade settings in place, once", async () => {
    const client = new InlineLocalRedis()
    await client.hset("settings:app_settings", { baseProfitFactor: "1.3", mainProfitFactor: "1.3", realProfitFactor: "1.14", leverage: "5" })
    await client.set("settings:all_settings", JSON.stringify({ liveProfitFactor: 1.3, blockProfitFactorRatio: 1.3 }))
    await client.hset("connection:bingx-x02", {
      id: "bingx-x02",
      connection_settings: JSON.stringify({ mainProfitFactor: 1.3, profitFactorMin: { real: 1.3 } }),
      blockRowLiveProfitFactorRatio: "1.3",
    })
    await client.hset("connection_settings:bingx-x02", { live_min_profit_factor: "1.3", base_min_profit_factor: "1.02" })
    await client.set("connection:bingx-x02:tombstoned_at", "2026-10-01T00:00:00.000Z")
    await client.set("direct_trade:state", JSON.stringify({ minProfitFactor: 1.3, minRecentProfitFactor: 1.5, fullHistoryPfDefaultsVersion: 2 }))

    const updated = await migrateStagePfDefaults(client)

    expect(updated).toBe(5)
    expect(await client.hgetall("settings:app_settings")).toMatchObject({ baseProfitFactor: "1.1", mainProfitFactor: "1.1", realProfitFactor: "1.14", leverage: "5" })
    expect(JSON.parse(String(await client.get("settings:all_settings")))).toEqual({ liveProfitFactor: 1.1, blockProfitFactorRatio: 1.3 })
    const connection = await client.hgetall("connection:bingx-x02")
    expect(JSON.parse(String(connection.connection_settings))).toEqual({ mainProfitFactor: 1.1, profitFactorMin: { real: 1.1 } })
    expect(connection.blockRowLiveProfitFactorRatio).toBe("1.3")
    expect(await client.hgetall("connection_settings:bingx-x02")).toMatchObject({ live_min_profit_factor: "1.1", base_min_profit_factor: "1.02" })
    expect(await client.get("connection:bingx-x02:tombstoned_at")).toBe("2026-10-01T00:00:00.000Z")
    expect(JSON.parse(String(await client.get("direct_trade:state")))).toEqual({ minProfitFactor: 1.1, minRecentProfitFactor: 1.5, fullHistoryPfDefaultsVersion: 3 })
    expect(await client.hget("system:database:coordination:performance", "schema_version")).toBe("110")
    // Idempotent: a second pass changes nothing.
    expect(await migrateStagePfDefaults(client)).toBe(0)
  })
})

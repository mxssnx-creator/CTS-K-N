import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

function resetRedisGlobals(): void {
  for (const key of [
    "__redis_data",
    "__redis_load_promise",
    "__redis_snapshot_loaded",
    "__redis_core_promise",
    "__redis_init_promise",
    "__redis_fully_connected",
    "__redis_backend",
    "__migration_run_promise",
    "__migrations_run",
    "__v0_devBootGuardDone",
  ]) delete (globalThis as any)[key]
}

describe("migrations 080–100 exact Set indexes and current engine defaults", () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = originalEnv
    resetRedisGlobals()
    jest.resetModules()
  })

  test("backfills lifetime/active/closed indexes, O(1) totals, and canonical Previous windows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "migration-080-"))
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      V0_REDIS_SNAPSHOT_PATH: join(dir, "snapshot.json"),
    }
    resetRedisGlobals()
    jest.resetModules()

    try {
      const redisDb = await import("@/lib/redis-db")
      await redisDb.ensureCoreRedis()
      const client = redisDb.getRedisClient()
      await client.flushDb()
      await client.sadd("connections", "conn-ledger")
      await client.hset("connection:conn-ledger", {
        id: "conn-ledger",
        name: "Ledger",
        exchange: "bingx",
        is_enabled_dashboard: "0",
      })
      await client.hset("strategy_set_entry_counts:conn-ledger", { "set:a": "2", "set:b": "1" })
      await client.hset("strategy_set_active_entry_counts:conn-ledger", { "set:a": "1" })
      await client.hset("strategy_set_closed_counts:conn-ledger", { "set:a": "1", "set:b": "1" })
      await client.hset("axis_pos_acc:conn-ledger", { "parent|axis:a": "7" })
      await client.hset("connection_settings:conn-ledger", {
        axisPrevMaxWindow: "5",
        blockProfitFactorRatio: "1.7",
        signal_volume_factor: "0.2",
        volume_factor: "7",
        baseVolumeFactor: "9",
        indicationSampleRanges: JSON.stringify([2, 5, 10, 20, 30]),
        optimalSampleRanges: JSON.stringify([2, 5, 10, 20, 30]),
        indicationFactorMultipliers: JSON.stringify([1]),
        activeThresholds: JSON.stringify([0.5, 1.5, 2.5]),
        activeAdvancedActivityRatios: JSON.stringify([0.5, 1.5, 3]),
        trendTimeframesMinutes: JSON.stringify([1, 3, 5, 10, 15, 30]),
        strategyRealSetsSafetyCeiling: "25",
        maxRealSets: "25",
        strategyLiveSetsCeiling: "90",
        minStep: "5",
        mainEvalPosCount: "15",
        realEvalPosCount: "10",
        coordination_settings: JSON.stringify({
          minStep: 5,
          mainEvalPosCount: 15,
          realEvalPosCount: 10,
        }),
      })
      await client.hset("connection:conn-ledger", {
        volume_factor: "8",
        live_volume_factor: "2.5",
        connection_settings: JSON.stringify({
          baseVolumeFactor: 6,
          live_volume_factor: 2.5,
        }),
      })
      await client.hset("settings:connection_settings:conn-ledger", { axisPrevMaxWindow: "11" })
      await client.hset("settings:active_indications:conn-ledger", {
        direction: "true",
        direction_timeout: "30",
        optimal: "false",
        optimal_timeout: "60",
        auto: "false",
        auto_timeout: "90",
        trend: "true",
        trend_timeout: "60",
      })
      await client.set("indications:signal", JSON.stringify({
        enabled: true,
        maxPositionsTotal: 24,
        sources: {
          "bingx-swap": { enabled: true, weight: 1 },
        },
      }))
      await client.set("indications:main", JSON.stringify({
        configuration: {
          sample_ranges: [2, 5, 10, 20, 30],
          factor_multipliers: [1],
          active_thresholds: [0.5, 1.5, 2.5],
        },
        direction: {
          range: { from: 3, to: 30, step: 1 },
          sample_ranges: [2, 5, 10, 20, 30],
          timeout: 3,
        },
        move: {
          range: { from: 3, to: 30, step: 1 },
          sample_ranges: [2, 5, 10, 20, 30],
          timeout: 3,
        },
        active: {
          thresholds: [0.5, 1.5, 2.5],
          timeout: 3,
        },
        active_advanced: {
          activity_values: [0.5, 1.5, 3],
        },
        optimal: {
          range: { from: 3, to: 30, step: 1 },
          sample_ranges: [2, 5, 10, 20, 30],
          timeout: 10,
        },
      }))
      await client.set("indications:common", JSON.stringify({
        coordination: {
          timeframesMinutes: [1, 3, 5, 15],
        },
        rsi: {
          enabled: false,
          period: { from: 8, to: 20, step: 1 },
          timeout: 10,
        },
      }))
      await client.sadd("preset_types:all", "preset-legacy-limit")
      await client.hset("preset_type:preset-legacy-limit", {
        id: "preset-legacy-limit",
        max_positions_per_indication: "5",
        max_positions_per_direction: "3",
        max_positions_per_range: "2",
      })
      const historicConfigBase = {
        connectionId: "conn-ledger",
        steps: 10,
        drawdown_ratio: 0.1,
        active_ratio: 0.7,
        last_part_ratio: 0.3,
        enabled: true,
        createdAt: "2026-08-10T00:00:00.000Z",
      }
      const leaderConfigKey = "indication:conn-ledger:config:cfg-a"
      const aliasConfigKey = "indication:conn-ledger:config:cfg-z"
      await client.sadd("indication:conn-ledger:configs:index", leaderConfigKey, aliasConfigKey)
      await client.set(leaderConfigKey, JSON.stringify({
        ...historicConfigBase,
        id: "cfg-a",
        type: "EMA",
      }))
      await client.set(aliasConfigKey, JSON.stringify({
        ...historicConfigBase,
        id: "cfg-z",
        type: "RSI",
      }))
      await client.rpush(`${leaderConfigKey}:results`, "leader-row")
      await client.rpush(`${aliasConfigKey}:results`, "duplicate-row")
      await client.set("_schema_version", "79")
      await client.set("_migrations_run", "true")

      const migrations = await import("@/lib/redis-migrations")
      migrations.resetMigrationRunState()
      await expect(migrations.runMigrations()).resolves.toMatchObject({ success: true, version: 100 })

      expect(await client.get("_schema_version")).toBe("100")
      expect(new Set(await client.smembers("strategy_set_keys:conn-ledger"))).toEqual(new Set(["set:a", "set:b"]))
      expect(await client.smembers("strategy_active_set_keys:conn-ledger")).toEqual(["set:a"])
      expect(new Set(await client.smembers("strategy_closed_set_keys:conn-ledger"))).toEqual(new Set(["set:a", "set:b"]))
      expect(await client.hgetall("strategy_ledger_totals:conn-ledger")).toMatchObject({
        exact_entries: "3",
        axis_entries: "7",
        active_memberships: "1",
        exact_closed: "2",
      })
      expect(await client.hget("connection_settings:conn-ledger", "axisPrevMaxWindow")).toBe("4")
      expect(await client.hget("settings:connection_settings:conn-ledger", "axisPrevMaxWindow")).toBe("10")
      expect(await client.hget("connection_settings:conn-ledger", "blockProfitFactorRatio")).toBe("1.7")
      expect(await client.hget("settings:connection_settings:conn-ledger", "blockProfitFactorRatio")).toBe("0.8")
      expect(await client.hget("connection_settings:conn-ledger", "positionCost")).toBe("0.1")
      expect(await client.hget("connection_settings:conn-ledger", "exchangePositionCost")).toBe("0.1")
      expect(await client.hget("connection_settings:conn-ledger", "live_volume_factor")).toBe("1")
      expect(await client.hget("connection_settings:conn-ledger", "signal_volume_factor")).toBe("1")
      expect(await client.hget("connection_settings:conn-ledger", "volume_factor")).toBe("1")
      expect(await client.hget("connection_settings:conn-ledger", "baseVolumeFactor")).toBe("1")
      expect(await client.hget("connection:conn-ledger", "volume_factor")).toBe("1")
      expect(await client.hget("connection:conn-ledger", "live_volume_factor")).toBe("2.5")
      expect(JSON.parse(
        String(await client.hget("connection:conn-ledger", "connection_settings")),
      )).toMatchObject({
        baseVolumeFactor: 1,
        live_volume_factor: 2.5,
      })
      expect(await client.hget("connection_settings:conn-ledger", "posCountsVolumeRatio")).toBe("3")
      // Systemwide Main Trade PF policy: base/main/real/live all default to 1.10
      // (MAIN_TRADE_STAGE_PF_DEFAULTS) when no prior value exists — see
      // lib/main-trade-profit-factor.ts.
      expect(await client.hget("connection_settings:conn-ledger", "baseProfitFactor")).toBe("1.1")
      expect(await client.hget("connection_settings:conn-ledger", "mainProfitFactor")).toBe("1.1")
      expect(await client.hget("connection_settings:conn-ledger", "realProfitFactor")).toBe("1.1")
      expect(await client.hget("connection_settings:conn-ledger", "liveProfitFactor")).toBe("1.1")
      expect(await client.hget("connection_settings:conn-ledger", "blockOnly")).toBe("true")
      expect(await client.hget("connection_settings:conn-ledger", "variantBlockOnly")).toBe("true")
      expect(await client.hget("connection_settings:conn-ledger", "indicationTimeoutMs")).toBe("250")
      expect(await client.hget("connection_settings:conn-ledger", "positionCooldownMs")).toBe("3000")
      expect(await client.hget("connection_settings:conn-ledger", "maxActiveBasePseudoPositionsPerDirection")).toBe("1")
      expect(await client.hget("connection_settings:conn-ledger", "strategyRealSetsSafetyCeiling")).toBe("0")
      expect(await client.hget("connection_settings:conn-ledger", "maxRealSets")).toBe("0")
      expect(await client.hget("connection_settings:conn-ledger", "strategyLiveSetsCeiling")).toBe("0")
      expect(await client.hget(
        "connection_settings:conn-ledger",
        "strategyBlockMaterializationBatchSize",
      )).toBe("1024")
      expect(await client.hget("connection_settings:conn-ledger", "minStep")).toBe("5")
      expect(await client.hget("connection_settings:conn-ledger", "mainEvalPosCount")).toBe("25")
      expect(await client.hget("connection_settings:conn-ledger", "realEvalPosCount")).toBe("20")
      expect(JSON.parse(String(
        await client.hget("connection_settings:conn-ledger", "coordination_settings"),
      ))).toMatchObject({
        minStep: 5,
        mainEvalPosCount: 25,
        realEvalPosCount: 20,
      })
      expect(JSON.parse(String(
        await client.hget("connection_settings:conn-ledger", "indicationSampleRanges"),
      ))).toEqual(Array.from({ length: 29 }, (_, index) => index + 2))
      expect(JSON.parse(String(
        await client.hget("connection_settings:conn-ledger", "indicationFactorMultipliers"),
      ))).toEqual([0.9, 1, 1.1])
      expect(JSON.parse(String(
        await client.hget("connection_settings:conn-ledger", "activeThresholds"),
      ))).toEqual([0.5, 1, 1.5, 2, 2.5])
      expect(JSON.parse(String(
        await client.hget("connection_settings:conn-ledger", "activeOutbreakRanges"),
      ))).toEqual([3, 5, 10])
      expect(JSON.parse(String(
        await client.hget("connection_settings:conn-ledger", "activeStopLossPositionCostRatios"),
      ))).toEqual([2, 3, 5])
      expect(JSON.parse(String(
        await client.hget("connection_settings:conn-ledger", "activeMarketExitSituations"),
      ))).toEqual(["momentum", "range_extension", "activity_fade"])
      expect(JSON.parse(String(await client.get("indications:main"))).active).toMatchObject({
        outbreak_ranges: [3, 5, 10],
        stop_loss_position_cost_ratios: [2, 3, 5],
        market_exit_situations: ["momentum", "range_extension", "activity_fade"],
      })
      expect(JSON.parse(String(
        await client.hget("connection_settings:conn-ledger", "trendTimeframesMinutes"),
      ))).toEqual([1, 5, 15, 30])
      expect(await client.hget("settings:active_indications:conn-ledger", "direction_timeout")).toBe("0.25")
      expect(await client.hget("settings:active_indications:conn-ledger", "optimal")).toBe("true")
      expect(await client.hget("settings:active_indications:conn-ledger", "auto")).toBe("true")
      expect(await client.hget("settings:active_indications:conn-ledger", "common")).toBe("true")
      expect(await client.hget("settings:active_indications:conn-ledger", "trend_timeout")).toBe("0.5")
      expect(await client.hget("settings:active_indications:conn-ledger", "trend_interval")).toBe("0.5")
      expect(await client.hget("settings:active_indications:conn-ledger", "common_timeout")).toBe("1")
      expect(await client.hget("settings:active_indications:conn-ledger", "common_interval")).toBe("1")
      const mainIndications = JSON.parse(String(await client.get("indications:main")))
      expect(mainIndications.configuration.sample_ranges).toEqual(
        Array.from({ length: 29 }, (_, index) => index + 2),
      )
      expect(mainIndications.configuration.factor_multipliers).toEqual([0.9, 1, 1.1])
      expect(mainIndications.active.thresholds).toEqual([0.5, 1, 1.5, 2, 2.5])
      expect(mainIndications.active_advanced.activity_values).toEqual([0.5, 1, 1.5, 2, 2.5, 3])
      expect(mainIndications.direction).toMatchObject({
        range: { from: 2, to: 30, step: 1 },
        timeout: 0.25,
      })
      expect(mainIndications.move.timeout).toBe(0.25)
      expect(mainIndications.optimal.timeout).toBe(0.25)
      const commonIndications = JSON.parse(String(await client.get("indications:common")))
      expect(commonIndications.coordination.timeframesMinutes).toEqual([1, 5, 15, 30])
      expect(commonIndications.rsi).toMatchObject({ enabled: false, timeout: 1, interval: 1 })
      expect(commonIndications.ma).toMatchObject({ enabled: true, timeout: 1, interval: 1 })
      expect(commonIndications.parabolicSAR).toMatchObject({ enabled: true, timeout: 1, interval: 1 })
      expect(await client.hgetall("preset_type:preset-legacy-limit")).toMatchObject({
        max_positions_per_indication: "0",
        max_positions_per_direction: "0",
        max_positions_per_range: "0",
      })
      expect(JSON.parse(String(await client.get("indications:signal")))).toMatchObject({
        directExecutionEnabled: true,
        maxSourcesPerCycle: 35,
        maxPositionsTotal: 350,
        sources: {
          "bingx-swap": {
            disabledSymbols: [],
            disabledLanes: [],
          },
        },
      })
      expect(await client.hget("app_settings", "signalTradeVolumeFactor")).toBe("1")
      expect(await client.hget("system:database:coordination:performance", "inline_snapshot_interval_ms")).toBe("60000")
      expect(await client.hget("system:database:coordination:performance", "independent_block_profit_factor"))
        .toBe("default-pf-x-ratio-x-volume-increment-v1")
      expect(await client.hget("system:database:coordination:performance", "schema_version"))
        .toBe("100")
      expect(await client.hget("system:database:coordination:performance", "active_processing_order"))
        .toBe("primary-active-trend")
      expect(await client.get(`${aliasConfigKey}:results:ref`)).toBe("cfg-a")
      expect(await client.lrange(`${leaderConfigKey}:results`, 0, -1)).toEqual(["leader-row"])
      expect(await client.llen(`${aliasConfigKey}:results`)).toBe(0)
      expect(await client.hget("system:database:coordination:performance", "historic_indication_detail_storage"))
        .toBe("shared-identical-calculation-v1")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("repairs schema-88 Base PF values and pins the exact Signal admission contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "migration-090-"))
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      V0_REDIS_SNAPSHOT_PATH: join(dir, "snapshot.json"),
    }
    resetRedisGlobals()
    jest.resetModules()

    try {
      const redisDb = await import("@/lib/redis-db")
      await redisDb.ensureCoreRedis()
      const client = redisDb.getRedisClient()
      await client.flushDb()
      await client.sadd("connections", "conn-stage-floor")
      await client.hset("connection:conn-stage-floor", {
        id: "conn-stage-floor",
        baseProfitFactor: "0.08",
        mainProfitFactor: "0.08",
        connection_settings: JSON.stringify({
          baseProfitFactor: 0.4,
          mainProfitFactor: 0.08,
          strategies: {
            main: {
              base: { min_profit_factor: 0.12 },
              main: { min_profit_factor: 0.08 },
            },
          },
        }),
      })
      await client.hset("connection_settings:conn-stage-floor", {
        baseProfitFactor: "0.3",
        base_min_profit_factor: "0.08",
        mainProfitFactor: "0.08",
        strategies: JSON.stringify({
          main: {
            base: { min_profit_factor: 0.08 },
            main: { min_profit_factor: 0.08 },
          },
          preset: {
            base: { min_profit_factor: 0.4 },
          },
        }),
      })
      await client.set("indications:signal", JSON.stringify({
        directExecutionEnabled: false,
        maxSourcesPerCycle: 10,
        maxPositionsTotal: 24,
        performanceLookback: 100,
        performanceMinSamples: 1,
        performanceDisableBelowPnl: -5,
      }))
      await client.set("_schema_version", "88")
      await client.set("_migrations_run", "true")

      const migrations = await import("@/lib/redis-migrations")
      migrations.resetMigrationRunState()
      await expect(migrations.runMigrations()).resolves.toMatchObject({ success: true, version: 100 })

      // Systemwide Main Trade PF floors are neutral at 1.00 for every stage.
      expect(await client.hget("connection:conn-stage-floor", "baseProfitFactor")).toBe("1")
      expect(await client.hget("connection:conn-stage-floor", "base_min_profit_factor")).toBe("1")
      expect(await client.hget("connection:conn-stage-floor", "mainProfitFactor")).toBe("1")
      expect(JSON.parse(String(
        await client.hget("connection:conn-stage-floor", "connection_settings"),
      ))).toMatchObject({
        baseProfitFactor: 1,
        mainProfitFactor: 1,
        strategies: {
          main: {
            base: { min_profit_factor: 1 },
            main: { min_profit_factor: 1 },
          },
        },
      })
      expect(await client.hget("connection_settings:conn-stage-floor", "baseProfitFactor")).toBe("1")
      expect(await client.hget("connection_settings:conn-stage-floor", "base_min_profit_factor")).toBe("1")
      expect(await client.hget("connection_settings:conn-stage-floor", "mainProfitFactor")).toBe("1")
      expect(JSON.parse(String(
        await client.hget("connection_settings:conn-stage-floor", "strategies"),
      ))).toMatchObject({
        main: {
          base: { min_profit_factor: 1 },
          main: { min_profit_factor: 1 },
        },
        preset: {
          base: { min_profit_factor: 1 },
        },
      })
      expect(JSON.parse(String(await client.get("indications:signal")))).toMatchObject({
        directExecutionEnabled: true,
        maxSourcesPerCycle: 35,
        maxPositionsTotal: 350,
        performanceLookback: 12,
        performanceMinSamples: 12,
        performanceDisableBelowPnl: 0,
        configMinimumPfRatio: 0.3,
      })
      expect(await client.hget(
        "system:database:coordination:performance",
        "signal_max_open_positions_long_short_total",
      )).toBe("350")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("raises the schema-89 stale 0.8 default to the current 1.15 default and preserves higher downstream settings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "migration-090-default-"))
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      V0_REDIS_SNAPSHOT_PATH: join(dir, "snapshot.json"),
    }
    resetRedisGlobals()
    jest.resetModules()

    try {
      const redisDb = await import("@/lib/redis-db")
      await redisDb.ensureCoreRedis()
      const client = redisDb.getRedisClient()
      await client.flushDb()
      await client.sadd("connections", "conn-v90")
      await client.hset("connection:conn-v90", {
        id: "conn-v90",
        baseProfitFactor: "0.8",
        mainProfitFactor: "1.3",
        connection_settings: JSON.stringify({
          baseProfitFactor: 0.8,
          mainProfitFactor: 1.3,
        }),
      })
      await client.hset("connection_settings:conn-v90", {
        baseProfitFactor: "0.8",
        base_min_profit_factor: "0.8",
        mainProfitFactor: "1.3",
        strategies: JSON.stringify({
          main: {
            base: { enabled: false, is_enabled: false, min_profit_factor: 0.8 },
            main: { enabled: false, is_enabled: false, min_profit_factor: 1.3 },
          },
          preset: {
            real: { enabled: false, is_enabled: false, min_profit_factor: 1.4 },
            live: { enabled: false, is_enabled: false, min_profit_factor: 1.5 },
          },
        }),
      })
      await client.set("indications:signal", JSON.stringify({
        directExecutionEnabled: false,
        performanceLookback: 10,
        performanceMinSamples: 10,
        configMinimumPfRatio: 0.7,
      }))
      await client.set("_schema_version", "89")
      await client.set("_migrations_run", "true")

      const migrations = await import("@/lib/redis-migrations")
      migrations.resetMigrationRunState()
      await expect(migrations.runMigrations()).resolves.toMatchObject({
        success: true,
        version: 100,
      })

      // The legacy sentinel value 0.8 (the old systemwide default) is recognized
      // as "still on default" and is upgraded straight to the current default
      // 1.10, rather than merely clamped to the neutral 1.00 floor. The higher
      // mainProfitFactor (1.3) and downstream preset values are preserved
      // untouched since they already clear their respective floors.
      expect(await client.hget("connection:conn-v90", "baseProfitFactor")).toBe("1.1")
      expect(await client.hget("connection:conn-v90", "mainProfitFactor")).toBe("1.3")
      expect(await client.hget("connection_settings:conn-v90", "baseProfitFactor")).toBe("1.1")
      expect(await client.hget("connection_settings:conn-v90", "base_min_profit_factor")).toBe("1.1")
      expect(await client.hget("connection_settings:conn-v90", "mainProfitFactor")).toBe("1.3")
      expect(JSON.parse(String(
        await client.hget("connection_settings:conn-v90", "strategies"),
      ))).toMatchObject({
        main: {
          base: { enabled: true, is_enabled: true, min_profit_factor: 1.1 },
          main: { enabled: true, is_enabled: true, min_profit_factor: 1.3 },
        },
        preset: {
          real: { enabled: true, is_enabled: true, min_profit_factor: 1.4 },
          live: { enabled: true, is_enabled: true, min_profit_factor: 1.5 },
        },
      })
      expect(JSON.parse(String(await client.get("indications:signal")))).toMatchObject({
        directExecutionEnabled: true,
        performanceLookback: 12,
        performanceMinSamples: 12,
        configMinimumPfRatio: 0.3,
      })
      expect(await client.hget(
        "system:database:coordination:performance",
        "strategy_stages",
      )).toBe("combined-base-main-real-live-process")
      expect(await client.hget(
        "system:database:coordination:performance",
        "strategy_stage_switches",
      )).toBe("compatibility-only-always-true")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("preserves an explicit QuickStart symbol basket across repeated boot initialization", async () => {
    const dir = await mkdtemp(join(tmpdir(), "migration-symbol-pin-"))
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      V0_DEV_SYMBOL_COUNT: "3",
      V0_REDIS_SNAPSHOT_PATH: join(dir, "snapshot.json"),
    }
    resetRedisGlobals()
    jest.resetModules()

    try {
      const redisDb = await import("@/lib/redis-db")
      await redisDb.ensureCoreRedis()
      const client = redisDb.getRedisClient()
      await client.flushDb()
      const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
      const serialized = JSON.stringify(symbols)
      await client.sadd("connections", "bingx-x01")
      for (const key of [
        "connection:bingx-x01",
        "settings:trade_engine_state:bingx-x01",
        "settings:connection_settings:bingx-x01",
        "settings:connection:bingx-x01",
      ]) {
        await client.hset(key, {
          id: "bingx-x01",
          name: "BingX Base",
          exchange: "bingx",
          force_symbols: serialized,
          symbols: serialized,
          active_symbols: serialized,
          symbol_count: "3",
          dev_symbol_count_override: "3",
        })
      }
      await client.set("_schema_version", "90")
      await client.set("_migrations_run", "true")

      const migrations = await import("@/lib/redis-migrations")
      migrations.resetMigrationRunState()
      await expect(migrations.runMigrations()).resolves.toMatchObject({
        success: true,
        version: 100,
      })

      for (const key of [
        "connection:bingx-x01",
        "settings:trade_engine_state:bingx-x01",
        "settings:connection_settings:bingx-x01",
        "settings:connection:bingx-x01",
      ]) {
        const forcedSymbols = await client.hget(key, "force_symbols")
        expect({ key, forcedSymbols }).toEqual({
          key,
          forcedSymbols: expect.stringContaining("["),
        })
        expect(JSON.parse(String(forcedSymbols))).toEqual([
          "BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT",
        ])
        expect(await client.hget(key, "symbol_count")).toBe("4")
        expect(JSON.parse(String(await client.hget(key, "mandatory_symbols")))).toEqual([
          "BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT",
        ])
        expect(await client.hget(key, "symbol_order")).toBe("")
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("normalizes legacy stage caps into unlimited rows and seeds the Block scheduler at schema 91", async () => {
    const dir = await mkdtemp(join(tmpdir(), "migration-091-stage-rows-"))
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      V0_REDIS_SNAPSHOT_PATH: join(dir, "snapshot.json"),
    }
    resetRedisGlobals()
    jest.resetModules()

    try {
      const redisDb = await import("@/lib/redis-db")
      await redisDb.ensureCoreRedis()
      const client = redisDb.getRedisClient()
      await client.flushDb()
      await client.sadd("connections", "conn-v91")
      await client.hset("connection_settings:conn-v91", {
        strategyRealSetsSafetyCeiling: "5000",
        maxRealSets: "5000",
        strategyLiveSetsCeiling: "500",
        connection_settings: JSON.stringify({
          strategies: {
            main: {
              base: { enabled: true, max_positions: 0 },
              main: { enabled: true, max_positions: 0 },
              real: { enabled: true, max_positions: 5000 },
              live: { enabled: false, max_positions: 500 },
            },
          },
          coordination_settings: {},
        }),
      })
      await client.set("_schema_version", "90")
      await client.set("_migrations_run", "true")

      const migrations = await import("@/lib/redis-migrations")
      migrations.resetMigrationRunState()
      await expect(migrations.runMigrations()).resolves.toMatchObject({
        success: true,
        version: 100,
      })

      expect(await client.hget("connection_settings:conn-v91", "strategyRealSetsSafetyCeiling")).toBe("0")
      expect(await client.hget("connection_settings:conn-v91", "maxRealSets")).toBe("0")
      expect(await client.hget("connection_settings:conn-v91", "strategyLiveSetsCeiling")).toBe("0")
      expect(await client.hget(
        "connection_settings:conn-v91",
        "strategyBlockMaterializationBatchSize",
      )).toBe("1024")
      const document = JSON.parse(String(
        await client.hget("connection_settings:conn-v91", "connection_settings"),
      ))
      expect(document.strategies.main.real.max_positions).toBe(0)
      expect(document.strategies.main.live.max_positions).toBe(0)
      expect(document.strategies.main.live.enabled).toBe(false)
      expect(document.coordination_settings.strategyBlockMaterializationBatchSize).toBe(1024)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("upgrades v98 PositionCost-ratio defaults without clobbering explicit grids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "migration-099-position-cost-"))
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      V0_REDIS_SNAPSHOT_PATH: join(dir, "snapshot.json"),
    }
    resetRedisGlobals()
    jest.resetModules()

    try {
      const redisDb = await import("@/lib/redis-db")
      await redisDb.ensureCoreRedis()
      const client = redisDb.getRedisClient()
      await client.flushDb()
      await client.sadd("connections", "conn-v99")
      await client.hset("connection:conn-v99", {
        id: "conn-v99",
        name: "PositionCost migration",
        exchange: "bingx",
        baseProfitFactor: "1.15",
        mainProfitFactor: "1.4",
        connection_settings: JSON.stringify({
          baseProfitFactor: 1.15,
          strategies: {
            main: { base: { min_profit_factor: 1.15 } },
            preset: { live: { min_profit_factor: 1.15 } },
          },
        }),
      })
      await client.hset("connection_settings:conn-v99", {
        baseProfitFactor: "1.15",
        mainProfitFactor: "1.4",
        realProfitFactor: "1.15",
      })
      await client.set("direct_trade:state", JSON.stringify({
        takeProfitRatioRange: [4, 8],
        takeProfitRatioStep: 2,
      }))
      await client.set("_schema_version", "98")
      await client.set("_migrations_run", "true")

      const migrations = await import("@/lib/redis-migrations")
      migrations.resetMigrationRunState()
      await expect(migrations.runMigrations()).resolves.toMatchObject({ success: true, version: 100 })

      expect(await client.get("_schema_version")).toBe("100")
      expect(await client.hget("connection:conn-v99", "baseProfitFactor")).toBe("1.1")
      expect(await client.hget("connection:conn-v99", "mainProfitFactor")).toBe("1.4")
      expect(await client.hget("connection_settings:conn-v99", "baseProfitFactor")).toBe("1.1")
      expect(await client.hget("connection_settings:conn-v99", "realProfitFactor")).toBe("1.1")
      expect(JSON.parse(String(await client.hget("connection:conn-v99", "connection_settings"))))
        .toMatchObject({
          baseProfitFactor: 1.1,
          mainTradePfRatioSemantics: "position-cost-net-v3",
          strategies: {
            main: { base: { min_profit_factor: 1.1 } },
            preset: { live: { min_profit_factor: 1.1 } },
          },
        })
      expect(JSON.parse(String(await client.get("direct_trade:state")))).toMatchObject({
        takeProfitRatioRange: [5, 10],
        takeProfitRatioStep: 5,
        takeProfitDefaultsVersion: 2,
      })
      expect(await client.hget(
        "system:database:coordination:performance",
        "main_trade_pf_two_cost_ratio",
      )).toBe("1.1")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

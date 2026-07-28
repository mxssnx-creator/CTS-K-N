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

describe("migrations 080–089 exact Set indexes and current engine defaults", () => {
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
      await client.set("_schema_version", "79")
      await client.set("_migrations_run", "true")

      const migrations = await import("@/lib/redis-migrations")
      migrations.resetMigrationRunState()
      await expect(migrations.runMigrations()).resolves.toMatchObject({ success: true, version: 90 })

      expect(await client.get("_schema_version")).toBe("90")
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
      expect(await client.hget("connection_settings:conn-ledger", "baseProfitFactor")).toBe("0.8")
      expect(await client.hget("connection_settings:conn-ledger", "mainProfitFactor")).toBe("1.12")
      expect(await client.hget("connection_settings:conn-ledger", "realProfitFactor")).toBe("1.12")
      expect(await client.hget("connection_settings:conn-ledger", "liveProfitFactor")).toBe("1.12")
      expect(await client.hget("connection_settings:conn-ledger", "blockOnly")).toBe("true")
      expect(await client.hget("connection_settings:conn-ledger", "variantBlockOnly")).toBe("true")
      expect(await client.hget("connection_settings:conn-ledger", "indicationTimeoutMs")).toBe("250")
      expect(await client.hget("connection_settings:conn-ledger", "positionCooldownMs")).toBe("3000")
      expect(await client.hget("connection_settings:conn-ledger", "maxActiveBasePseudoPositionsPerDirection")).toBe("1")
      expect(await client.hget("connection_settings:conn-ledger", "strategyRealSetsSafetyCeiling")).toBe("5000")
      expect(await client.hget("connection_settings:conn-ledger", "maxRealSets")).toBe("5000")
      expect(await client.hget("connection_settings:conn-ledger", "strategyLiveSetsCeiling")).toBe("500")
      expect(await client.hget("connection_settings:conn-ledger", "minStep")).toBe("2")
      expect(await client.hget("connection_settings:conn-ledger", "mainEvalPosCount")).toBe("25")
      expect(await client.hget("connection_settings:conn-ledger", "realEvalPosCount")).toBe("20")
      expect(JSON.parse(String(
        await client.hget("connection_settings:conn-ledger", "coordination_settings"),
      ))).toMatchObject({
        minStep: 2,
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
        await client.hget("connection_settings:conn-ledger", "trendTimeframesMinutes"),
      ))).toEqual([1, 5, 15, 30])
      expect(await client.hget("settings:active_indications:conn-ledger", "direction_timeout")).toBe("0.25")
      expect(await client.hget("settings:active_indications:conn-ledger", "optimal")).toBe("true")
      expect(await client.hget("settings:active_indications:conn-ledger", "auto")).toBe("true")
      expect(await client.hget("settings:active_indications:conn-ledger", "common")).toBe("true")
      expect(await client.hget("settings:active_indications:conn-ledger", "common_timeout")).toBe("3")
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
      expect(commonIndications.rsi).toMatchObject({ enabled: false, timeout: 3 })
      expect(commonIndications.ma).toMatchObject({ enabled: true, timeout: 3 })
      expect(commonIndications.parabolicSAR).toMatchObject({ enabled: true, timeout: 3 })
      expect(JSON.parse(String(await client.get("indications:signal")))).toMatchObject({
        directExecutionEnabled: true,
        maxSourcesPerCycle: 35,
        maxPositionsTotal: 120,
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
        .toBe("90")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("repairs schema-88 Base PF values and preserves explicit Signal direct execution choices", async () => {
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
      await expect(migrations.runMigrations()).resolves.toMatchObject({ success: true, version: 90 })

      expect(await client.hget("connection:conn-stage-floor", "baseProfitFactor")).toBe("0.8")
      expect(await client.hget("connection:conn-stage-floor", "base_min_profit_factor")).toBe("0.8")
      expect(await client.hget("connection:conn-stage-floor", "mainProfitFactor")).toBe("0.08")
      expect(JSON.parse(String(
        await client.hget("connection:conn-stage-floor", "connection_settings"),
      ))).toMatchObject({
        baseProfitFactor: 0.8,
        mainProfitFactor: 0.08,
        strategies: {
          main: {
            base: { min_profit_factor: 0.8 },
            main: { min_profit_factor: 0.08 },
          },
        },
      })
      expect(await client.hget("connection_settings:conn-stage-floor", "baseProfitFactor")).toBe("0.8")
      expect(await client.hget("connection_settings:conn-stage-floor", "base_min_profit_factor")).toBe("0.8")
      expect(await client.hget("connection_settings:conn-stage-floor", "mainProfitFactor")).toBe("0.08")
      expect(JSON.parse(String(
        await client.hget("connection_settings:conn-stage-floor", "strategies"),
      ))).toMatchObject({
        main: {
          base: { min_profit_factor: 0.8 },
          main: { min_profit_factor: 0.08 },
        },
        preset: {
          base: { min_profit_factor: 0.8 },
        },
      })
      expect(JSON.parse(String(await client.get("indications:signal")))).toMatchObject({
        directExecutionEnabled: false,
        maxSourcesPerCycle: 35,
        maxPositionsTotal: 120,
        performanceLookback: 12,
        performanceMinSamples: 12,
        performanceDisableBelowPnl: 0,
        configMinimumPfRatio: 0.7,
      })
      expect(await client.hget(
        "system:database:coordination:performance",
        "signal_max_open_positions_long_short_total",
      )).toBe("120")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("keeps the schema-89 Base 0.80 floor and preserves independent downstream settings", async () => {
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
            base: { min_profit_factor: 0.8 },
            main: { min_profit_factor: 1.3 },
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
        version: 90,
      })

      expect(await client.hget("connection:conn-v90", "baseProfitFactor")).toBe("0.8")
      expect(await client.hget("connection:conn-v90", "mainProfitFactor")).toBe("1.3")
      expect(await client.hget("connection_settings:conn-v90", "baseProfitFactor")).toBe("0.8")
      expect(await client.hget("connection_settings:conn-v90", "base_min_profit_factor")).toBe("0.8")
      expect(await client.hget("connection_settings:conn-v90", "mainProfitFactor")).toBe("1.3")
      expect(JSON.parse(String(
        await client.hget("connection_settings:conn-v90", "strategies"),
      ))).toMatchObject({
        main: {
          base: { min_profit_factor: 0.8 },
          main: { min_profit_factor: 1.3 },
        },
      })
      expect(JSON.parse(String(await client.get("indications:signal")))).toMatchObject({
        directExecutionEnabled: false,
        performanceLookback: 12,
        performanceMinSamples: 12,
        configMinimumPfRatio: 0.7,
      })
      expect(await client.hget(
        "system:database:coordination:performance",
        "strategy_stages",
      )).toBe("combined-base-main-real-live-process")
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
        version: 90,
      })

      for (const key of [
        "connection:bingx-x01",
        "settings:trade_engine_state:bingx-x01",
        "settings:connection_settings:bingx-x01",
        "settings:connection:bingx-x01",
      ]) {
        expect(await client.hget(key, "force_symbols")).toBe(serialized)
        expect(await client.hget(key, "symbol_count")).toBe("3")
        expect(await client.hget(key, "symbol_order")).toBe("")
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

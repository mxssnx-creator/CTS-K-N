import { readFileSync } from "node:fs"
import { join } from "node:path"
import { getIndications, getRedisClient, setSettings, storeIndications } from "@/lib/redis-db"
import { buildPrehistoricGateKeys, buildProgressionScope } from "@/lib/progression-scope"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { buildProgressionFingerprint } from "@/lib/progression-fingerprint"
import { IndicationConfigManager } from "@/lib/indication-config-manager"
import { IndicationSetsProcessor } from "@/lib/indication-sets-processor"
import { StrategyConfigManager } from "@/lib/strategy-config-manager"
import { getCanonicalSymbolSelection } from "@/lib/trade-engine/symbol-selection-ownership"
import { runIndStratCycle } from "@/lib/trade-engine/shared-ind-strat-pipeline"
import {
  clearHistoricCalculationState,
  clearHistoricListCompletionMarkers,
  historicAggregateMarkerCollectionKey,
  incrementHistoricAggregateOnce,
  incrementHistoricAggregatesOnce,
} from "@/lib/redis-idempotent-list"
import {
  ConfigSetProcessor,
  groupHistoricIndicationCalculationConfigs,
  groupHistoricIndicationCalculationGroupsByGeometry,
  historicProcessedIntervalsKey,
  resolveHistoricStrategyEntryThreshold,
} from "@/lib/trade-engine/config-set-processor"

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8")
}

describe("historic runtime generation stability", () => {
  test("adapts strategy entries to one-second volatility without relaxing the legacy ceiling", async () => {
    expect(resolveHistoricStrategyEntryThreshold(0)).toBe(0.00005)
    expect(resolveHistoricStrategyEntryThreshold(0.00004)).toBeCloseTo(0.00006, 12)
    expect(resolveHistoricStrategyEntryThreshold(0.01)).toBe(0.002)

    const startedAt = Date.parse("2026-08-24T00:00:00.000Z")
    const candles = Array.from({ length: 2_400 }, (_, index) => {
      const close = 100 * (1 + 0.006 * Math.sin(index / 40))
      return {
        timestamp: startedAt + index * 1_000,
        open: close,
        high: close,
        low: close,
        close,
        volume: 1,
      }
    })
    const processor = new ConfigSetProcessor("adaptive-strategy-test", 1)
    const positions = await (processor as any).calculateStrategyPositions(
      "BTCUSDT",
      candles,
      {
        id: "adaptive-strategy",
        connectionId: "adaptive-strategy-test",
        position_cost_step: 15,
        takeprofit: 0.01,
        stoploss: 0.005,
        trailing: false,
        type: "MA_Cross",
        enabled: true,
        createdAt: new Date(startedAt).toISOString(),
      },
    )

    expect(positions.length).toBeGreaterThan(0)
    expect(positions.some((position: { status: string }) => position.status === "closed")).toBe(true)
    expect(positions.every((position: { position_cost_pct?: number }) => position.position_cost_pct === 0.1)).toBe(true)
  })

  test("scopes processed intervals to the exact historic generation", () => {
    expect(historicProcessedIntervalsKey("connection", "BTC/USDT", "epoch:one")).toBe(
      "prehistoric:connection:BTC_USDT:processed_intervals:epoch_one",
    )
    expect(historicProcessedIntervalsKey("connection", "BTC/USDT", "epoch:two")).not.toBe(
      historicProcessedIntervalsKey("connection", "BTC/USDT", "epoch:one"),
    )
  })

  test("groups mathematically identical indication calculations across type labels", () => {
    const base = {
      connectionId: "grouping-test",
      steps: 10,
      drawdown_ratio: 0.1,
      active_ratio: 0.7,
      last_part_ratio: 0.3,
      enabled: true,
      createdAt: "2026-08-10T00:00:00.000Z",
    }
    const groups = groupHistoricIndicationCalculationConfigs([
      { ...base, id: "z-rsi", type: "RSI" },
      { ...base, id: "a-ema", type: "EMA" },
      { ...base, id: "different-step", type: "EMA", steps: 11 },
    ])

    expect(groups).toHaveLength(2)
    expect(groups.find((group) => group.length === 2)?.map((config) => config.id)).toEqual([
      "a-ema",
      "z-rsi",
    ])
  })

  test("batches factor variants by shared window geometry without merging their identities", () => {
    const base = {
      connectionId: "geometry-test",
      steps: 10,
      drawdown_ratio: 0.1,
      active_ratio: 0.7,
      last_part_ratio: 0.3,
      enabled: true,
      createdAt: "2026-08-10T00:00:00.000Z",
      type: "RSI",
    }
    const exactGroups = groupHistoricIndicationCalculationConfigs([
      { ...base, id: "factor-a" },
      { ...base, id: "factor-b", active_ratio: 0.9 },
      { ...base, id: "other-geometry", last_part_ratio: 0.5 },
    ])
    const geometryGroups = groupHistoricIndicationCalculationGroupsByGeometry(exactGroups)

    expect(exactGroups).toHaveLength(3)
    expect(geometryGroups).toHaveLength(2)
    expect(geometryGroups.find((group) => group.length === 2)?.flat().map((config) => config.id).sort()).toEqual([
      "factor-a",
      "factor-b",
    ])
  })

  test("counts a clean zero-position strategy calculation as completed work", () => {
    const processor = source("lib/trade-engine/config-set-processor.ts")
    const strategyProcessor = processor.slice(processor.indexOf("private async processStrategyConfigs("))

    expect(strategyProcessor).toMatch(
      /if \(positions\.length === 0\) \{\s*succeeded = true\s*return 0\s*\}/,
    )
  })

  test("engine startup closes a marker-only settings acknowledgement gap", () => {
    const manager = source("lib/trade-engine/engine-manager.ts")
    expect(manager).toContain("await this.acknowledgeStartupSettingsMarker()")
    expect(manager).toContain("private async acknowledgeStartupSettingsMarker(): Promise<void>")
    expect(manager).toContain("if (await getPendingChanges(this.connectionId)) return")
  })

  test("global pause snapshots Redis-proven owners for a targeted resume", () => {
    const coordinator = source("lib/trade-engine.ts")
    expect(coordinator).toContain("resolveDistributedEngineRuntime")
    expect(coordinator).toContain("const remoteRuntimeEntries = await Promise.all(activeConnections.map")
    expect(coordinator).toContain("if (connectionId) stateSnapshot[connectionId] = true")
  })

  test("canonical symbols fall back across every persisted runtime alias", async () => {
    const connectionId = `selection-fallback-${Date.now()}`
    const client = getRedisClient()
    const settingsKey = `settings:trade_engine_state:${connectionId}`
    try {
      await client.del(settingsKey)
      await setSettings(`trade_engine_state:${connectionId}`, {
        selected_symbols: "[]",
        force_symbols: JSON.stringify(["btcusdt", "ETHUSDT", "BTCUSDT"]),
        symbol_selection_epoch: "epoch-force",
      })

      await expect(getCanonicalSymbolSelection(connectionId)).resolves.toEqual({
        epoch: "epoch-force",
        symbols: ["BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT", "ETHUSDT"],
        total: 5,
      })
    } finally {
      await client.del(settingsKey)
    }
  })

  test("local production ownership keeps the complete configured basket", async () => {
    const connectionId = `selection-local-cap-${Date.now()}`
    const client = getRedisClient()
    const settingsKey = `settings:trade_engine_state:${connectionId}`
    const previousNodeEnv = process.env.NODE_ENV
    const previousRuntime = process.env.CTS_DEPLOYMENT_RUNTIME
    try {
      process.env.NODE_ENV = "production"
      process.env.CTS_DEPLOYMENT_RUNTIME = "self-hosted"
      await client.del(settingsKey)
      await setSettings(`trade_engine_state:${connectionId}`, {
        force_symbols: JSON.stringify([
          "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT",
          "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT", "ATOMUSDT", "LTCUSDT",
        ]),
        dev_symbol_count_override: "12",
        symbol_selection_epoch: "epoch-local-cap",
      })

      await expect(getCanonicalSymbolSelection(connectionId)).resolves.toEqual({
        epoch: "epoch-local-cap",
        symbols: [
          "BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT", "ETHUSDT", "BNBUSDT",
          "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT", "ATOMUSDT", "LTCUSDT",
        ],
        total: 13,
      })
    } finally {
      await client.del(settingsKey)
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previousNodeEnv
      if (previousRuntime === undefined) delete process.env.CTS_DEPLOYMENT_RUNTIME
      else process.env.CTS_DEPLOYMENT_RUNTIME = previousRuntime
    }
  })

  test("durable operator symbols survive a stale unscoped runtime mirror", async () => {
    const connectionId = `selection-toggle-handoff-${Date.now()}`
    const client = getRedisClient()
    const scope = buildProgressionScope(connectionId)
    const keys = [
      `settings:trade_engine_state:${connectionId}`,
      `trade_engine_state:${connectionId}`,
      scope.tradeEngineStateKey,
      `connection:${connectionId}`,
      `connection_settings:${connectionId}`,
      `settings:connection_settings:${connectionId}`,
    ]
    const expected = ["BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT", "ETHUSDT"]
    try {
      await client.del(...keys)
      await client.hset(`settings:trade_engine_state:${connectionId}`, {
        selected_symbols: JSON.stringify(["BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT", "WIFUSDT"]),
        force_symbols: "",
        active_symbols: "",
        symbols: "",
        symbol_selection_epoch: "stale-runtime-epoch",
      })
      await client.hset(`connection_settings:${connectionId}`, {
        force_symbols: JSON.stringify(expected),
        selected_symbols: JSON.stringify(expected),
      })
      await client.hset(scope.tradeEngineStateKey, {
        force_symbols: JSON.stringify(expected),
        selected_symbols: JSON.stringify(expected),
        symbol_selection_epoch: "quickstart-epoch",
        config_set_symbols_total: String(expected.length),
      })

      await expect(getCanonicalSymbolSelection(connectionId)).resolves.toEqual({
        epoch: "quickstart-epoch",
        symbols: expected,
        total: expected.length,
      })
    } finally {
      await client.del(...keys)
    }
  })

  test("repeated symbol completion increments one prehistoric cycle only once", async () => {
    const connectionId = `historic-cycle-${Date.now()}`
    const client = getRedisClient()
    const scope = buildProgressionScope(connectionId)
    const keys = [
      scope.progressionKey,
      `${scope.progressionKey}:prehistoric_symbols_set`,
      `${scope.prehistoricKey}:symbols`,
      scope.tradeEngineStateKey,
    ]
    try {
      await client.del(...keys)
      await client.hset(scope.tradeEngineStateKey, { symbol_selection_epoch: "epoch-cycle" })
      await ProgressionStateManager.incrementPrehistoricCycle(connectionId, "BTCUSDT", "epoch-cycle")
      await ProgressionStateManager.incrementPrehistoricCycle(connectionId, "BTCUSDT", "epoch-cycle")

      const progression = await client.hgetall(scope.progressionKey)
      expect(progression.prehistoric_cycles_completed).toBe("1")
      await expect(client.scard(`${scope.prehistoricKey}:symbols`)).resolves.toBe(1)
    } finally {
      await client.del(...keys)
    }
  })

  test("new sessions preserve a pending settings-generation acknowledgement", async () => {
    const connectionId = `pending-recoordination-${Date.now()}`
    const client = getRedisClient()
    const scope = buildProgressionScope(connectionId)
    const version = `settings-${Date.now()}`
    const keys = [
      scope.progressionKey,
      scope.legacyProgressionKey,
      `${scope.progressionKey}:history:1`,
    ]
    try {
      await client.del(...keys)
      await Promise.all([
        client.hset(scope.progressionKey, {
          session_number: "1",
          epoch: "1",
          settings_recoordination_pending: "1",
          settings_recoordination_requested_version: version,
          settings_recoordination_requested_event_id: "event-1",
          settings_recoordination_fields: JSON.stringify(["minimal_step_count"]),
          stats_recalculation_requested: "1",
          stats_recalculation_requested_version: version,
        }),
        client.hset(scope.legacyProgressionKey, {
          settings_recoordination_pending: "1",
          settings_recoordination_requested_version: version,
          settings_recoordination_requested_event_id: "event-1",
          settings_recoordination_fields: JSON.stringify(["minimal_step_count"]),
          stats_recalculation_requested: "1",
          stats_recalculation_requested_version: version,
        }),
      ])

      await ProgressionStateManager.archiveAndStartNewProgression(connectionId, Date.now(), "main")

      const next = await client.hgetall(scope.progressionKey)
      expect(next.settings_recoordination_pending).toBe("1")
      expect(next.settings_recoordination_requested_version).toBe(version)
      expect(next.stats_recalculation_requested).toBe("1")
      expect(next.cycles_completed).toBe("0")
    } finally {
      await client.del(...keys)
    }
  })

  test("process restart preserves only a complete fingerprint-owned Historic cache", async () => {
    const connectionId = `historic-restart-cache-${Date.now()}`
    const client = getRedisClient()
    const scope = buildProgressionScope(connectionId)
    const doneKeys = buildPrehistoricGateKeys(connectionId, "main", "done")
    const firstPassKeys = buildPrehistoricGateKeys(connectionId, "main", "firstpass:done")
    const symbols = ["BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT"]
    const symbolsHash = symbols.slice().sort().join("|")
    const selectionEpoch = `selection-${Date.now()}`
    const connectionKey = `connection:${connectionId}`
    const keys = [
      connectionKey,
      scope.progressionKey,
      `${scope.progressionKey}:prehistoric_symbols_set`,
      scope.prehistoricKey,
      `${scope.prehistoricKey}:symbols`,
      scope.prehistoricLoadedKey,
      `prehistoric_loaded:${connectionId}`,
      doneKeys.scoped,
      doneKeys.legacy,
      firstPassKeys.scoped,
      firstPassKeys.legacy,
      scope.tradeEngineStateKey,
      `trade_engine_state:${connectionId}`,
      `settings:trade_engine_state:${connectionId}`,
      `connection_settings:${connectionId}`,
      `settings:connection_settings:${connectionId}`,
      `realtime:${connectionId}`,
    ]
    try {
      await client.del(...keys)
      const connection = {
        force_symbols: JSON.stringify(symbols),
        selected_symbols: JSON.stringify(symbols),
        is_live_trade: "0",
        is_testnet: "1",
      }
      const engineState = {
        force_symbols: JSON.stringify(symbols),
        selected_symbols: JSON.stringify(symbols),
        symbol_selection_epoch: selectionEpoch,
        config_set_symbols_total: String(symbols.length),
      }
      await Promise.all([
        client.hset(connectionKey, connection),
        client.hset(scope.tradeEngineStateKey, engineState),
      ])
      const fingerprint = buildProgressionFingerprint({
        connectionId,
        engineType: "main",
        connData: connection,
        tradeEngineState: engineState,
        connectionSettings: {},
      })
      await Promise.all([
        client.hset(scope.prehistoricKey, {
          is_complete: "1",
          historic_avg_profit_factor: "0.0000",
          symbols_processed: String(symbols.length),
          symbols_total: String(symbols.length),
          symbol_selection_epoch: selectionEpoch,
          completed_progression_fingerprint: fingerprint,
          completed_symbols_hash: symbolsHash,
          candles_loaded: "21600",
          indicators_calculated: "48000",
        }),
        client.sadd(`${scope.prehistoricKey}:symbols`, ...symbols),
        client.set(doneKeys.scoped, "1", { EX: 86400 }),
        client.set(firstPassKeys.scoped, "1", { EX: 86400 }),
        client.set(scope.prehistoricLoadedKey, "1", { EX: 86400 }),
        client.set(`realtime:${connectionId}`, "restart-telemetry", { EX: 86400 }),
      ])

      await expect(
        ProgressionStateManager.recoordinateForActualOne(connectionId, "main"),
      ).resolves.toEqual(expect.objectContaining({
        changed: true,
        reason: "no active progression — verified Historic cache preserved",
      }))

      const progression = await client.hgetall(scope.progressionKey)
      const state = await client.hgetall(scope.tradeEngineStateKey)
      expect(progression.prehistoric_phase_active).toBe("false")
      expect(progression.prehistoric_symbols_processed_count).toBe(String(symbols.length))
      expect(state.prehistoric_data_source).toBe("verified-process-restart-cache")
      await expect(client.get(`realtime:${connectionId}`)).resolves.toBe("restart-telemetry")
      await expect(client.get(doneKeys.legacy)).resolves.toBe("1")
      await expect(client.get(firstPassKeys.legacy)).resolves.toBe("1")
      await expect(client.get(`prehistoric_loaded:${connectionId}`)).resolves.toBe("1")
    } finally {
      await client.del(...keys)
    }
  })

  test("process restart rejects a completed Historic cache with the wrong fingerprint", async () => {
    const connectionId = `historic-restart-mismatch-${Date.now()}`
    const client = getRedisClient()
    const scope = buildProgressionScope(connectionId)
    const doneKeys = buildPrehistoricGateKeys(connectionId, "main", "done")
    const firstPassKeys = buildPrehistoricGateKeys(connectionId, "main", "firstpass:done")
    const symbols = ["BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT"]
    const connectionKey = `connection:${connectionId}`
    const keys = [
      connectionKey,
      scope.progressionKey,
      scope.prehistoricKey,
      `${scope.prehistoricKey}:symbols`,
      scope.prehistoricLoadedKey,
      `prehistoric_loaded:${connectionId}`,
      doneKeys.scoped,
      doneKeys.legacy,
      firstPassKeys.scoped,
      firstPassKeys.legacy,
      scope.tradeEngineStateKey,
      `trade_engine_state:${connectionId}`,
      `settings:trade_engine_state:${connectionId}`,
      `connection_settings:${connectionId}`,
      `settings:connection_settings:${connectionId}`,
      `realtime:${connectionId}`,
      `prehistoric:progress:${connectionId}`,
    ]
    try {
      await client.del(...keys)
      await Promise.all([
        client.hset(connectionKey, {
          force_symbols: JSON.stringify(symbols),
          selected_symbols: JSON.stringify(symbols),
        }),
        client.hset(scope.tradeEngineStateKey, {
          force_symbols: JSON.stringify(symbols),
          selected_symbols: JSON.stringify(symbols),
          symbol_selection_epoch: "mismatch-epoch",
          config_set_symbols_total: String(symbols.length),
        }),
        client.hset(scope.prehistoricKey, {
          is_complete: "1",
          historic_avg_profit_factor: "1.5",
          symbols_processed: String(symbols.length),
          symbols_total: String(symbols.length),
          symbol_selection_epoch: "mismatch-epoch",
          completed_progression_fingerprint: "wrong-settings-fingerprint",
          completed_symbols_hash: symbols.slice().sort().join("|"),
        }),
        client.sadd(`${scope.prehistoricKey}:symbols`, ...symbols),
        client.set(doneKeys.scoped, "1"),
        client.set(firstPassKeys.scoped, "1"),
        client.set(scope.prehistoricLoadedKey, "1"),
        client.set(`realtime:${connectionId}`, "stale"),
      ])

      await expect(
        ProgressionStateManager.recoordinateForActualOne(connectionId, "main"),
      ).resolves.toEqual(expect.objectContaining({
        changed: true,
        reason: "no active progression",
      }))
      await expect(client.get(scope.prehistoricLoadedKey)).resolves.toBeNull()
      await expect(client.get(doneKeys.scoped)).resolves.toBeNull()
      await expect(client.get(`realtime:${connectionId}`)).resolves.toBeNull()
    } finally {
      await client.del(...keys)
    }
  })

  test("runtime settings changes retain an active same-basket Historic cache", async () => {
    const connectionId = `historic-runtime-settings-${Date.now()}`
    const client = getRedisClient()
    const scope = buildProgressionScope(connectionId)
    const doneKeys = buildPrehistoricGateKeys(connectionId, "main", "done")
    const firstPassKeys = buildPrehistoricGateKeys(connectionId, "main", "firstpass:done")
    const symbols = ["BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT"]
    const symbolsHash = symbols.slice().sort().join("|")
    const selectionEpoch = `runtime-settings-${Date.now()}`
    const connectionKey = `connection:${connectionId}`
    const keys = [
      connectionKey,
      scope.progressionKey,
      scope.prehistoricKey,
      `${scope.prehistoricKey}:symbols`,
      scope.prehistoricLoadedKey,
      `prehistoric_loaded:${connectionId}`,
      doneKeys.scoped,
      doneKeys.legacy,
      firstPassKeys.scoped,
      firstPassKeys.legacy,
      scope.tradeEngineStateKey,
      `trade_engine_state:${connectionId}`,
      `settings:trade_engine_state:${connectionId}`,
      `connection_settings:${connectionId}`,
      `settings:connection_settings:${connectionId}`,
      `realtime:${connectionId}`,
    ]
    try {
      await client.del(...keys)
      const connection = {
        force_symbols: JSON.stringify(symbols),
        selected_symbols: JSON.stringify(symbols),
        is_live_trade: "0",
        is_testnet: "1",
      }
      const initialState = {
        force_symbols: JSON.stringify(symbols),
        selected_symbols: JSON.stringify(symbols),
        symbol_selection_epoch: selectionEpoch,
        live_volume_factor: "1",
        config_set_symbols_total: String(symbols.length),
      }
      const initialFingerprint = buildProgressionFingerprint({
        connectionId,
        engineType: "main",
        connData: connection,
        tradeEngineState: initialState,
        connectionSettings: {},
      })
      await Promise.all([
        client.hset(connectionKey, connection),
        client.hset(scope.tradeEngineStateKey, initialState),
        client.hset(scope.progressionKey, {
          connection_id: connectionId,
          engine_started: "true",
          epoch: String(Date.now()),
          symbol_count: String(symbols.length),
          active_symbols_hash: symbolsHash,
          progress_settings_snapshot: JSON.stringify({ progression_fingerprint: initialFingerprint }),
        }),
        client.hset(scope.prehistoricKey, {
          is_complete: "1",
          historic_avg_profit_factor: "1.25",
          symbols_processed: String(symbols.length),
          symbols_total: String(symbols.length),
          symbol_selection_epoch: selectionEpoch,
          completed_progression_fingerprint: initialFingerprint,
          completed_symbols_hash: symbolsHash,
        }),
        client.sadd(`${scope.prehistoricKey}:symbols`, ...symbols),
        client.set(doneKeys.scoped, "1", { EX: 86400 }),
        client.set(firstPassKeys.scoped, "1", { EX: 86400 }),
        client.set(scope.prehistoricLoadedKey, "1", { EX: 86400 }),
        client.set(`prehistoric_loaded:${connectionId}`, "1", { EX: 86400 }),
        client.set(`realtime:${connectionId}`, "current-session-telemetry", { EX: 86400 }),
      ])

      const currentState = { ...initialState, live_volume_factor: "1.2" }
      await client.hset(scope.tradeEngineStateKey, currentState)
      const currentFingerprint = buildProgressionFingerprint({
        connectionId,
        engineType: "main",
        connData: connection,
        tradeEngineState: currentState,
        connectionSettings: {},
      })

      await expect(
        ProgressionStateManager.recoordinateForActualOne(connectionId, "main"),
      ).resolves.toEqual(expect.objectContaining({
        changed: false,
        reason: "runtime settings changed — Historic cache retained",
      }))

      const progression = await client.hgetall(scope.progressionKey)
      const refreshed = JSON.parse(progression.progress_settings_snapshot || "{}")
      expect(refreshed.progression_fingerprint).toBe(currentFingerprint)
      expect(progression.runtime_settings_reconciliation).toBe("hot-reload-preserved-historic-cache")
      await expect(client.get(doneKeys.scoped)).resolves.toBe("1")
      await expect(client.get(firstPassKeys.scoped)).resolves.toBe("1")
      await expect(client.get(scope.prehistoricLoadedKey)).resolves.toBe("1")
      await expect(client.get(`prehistoric_loaded:${connectionId}`)).resolves.toBe("1")
      await expect(client.get(`realtime:${connectionId}`)).resolves.toBe("current-session-telemetry")
    } finally {
      await client.del(...keys)
    }
  })

  test("historical indication snapshots stay namespaced and preserve replay time", async () => {
    const connectionId = `historic-indication-snapshot-${Date.now()}`
    const symbol = "BTCUSDT"
    const historicConnectionId = `${connectionId}:${symbol}:prehistoric`
    const client = getRedisClient()
    const keys = [
      `indications:${connectionId}`,
      `indications:${connectionId}:direction`,
      `indications_snapshot:${connectionId}:${symbol}`,
      `indications_snapshot:index:${connectionId}`,
      `indications:${historicConnectionId}`,
      `indications:${historicConnectionId}:direction`,
      `indications_snapshot:${historicConnectionId}:${symbol}`,
      `indications_snapshot:index:${historicConnectionId}`,
    ]
    const replayTimestamp = 1_786_521_600_000
    try {
      await client.del(...keys)
      await storeIndications(connectionId, symbol, [{
        type: "direction",
        marker: "live",
        timestamp: 1_786_608_000_000,
      }])
      await storeIndications(historicConnectionId, symbol, [{
        type: "direction",
        marker: "historic",
        timestamp: replayTimestamp,
      }], { preserveTimestamps: true })

      const [live, historic] = await Promise.all([
        getIndications(connectionId),
        getIndications(historicConnectionId),
      ])
      expect(live).toEqual(expect.arrayContaining([
        expect.objectContaining({ marker: "live" }),
      ]))
      expect(live).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ marker: "historic" }),
      ]))
      expect(historic).toEqual(expect.arrayContaining([
        expect.objectContaining({ marker: "historic", timestamp: replayTimestamp }),
      ]))
    } finally {
      await client.del(...keys)
    }
  })

  test("historical exact Set snapshots do not persist into the live Set keyspace", async () => {
    const connectionId = `historic-set-snapshot-${Date.now()}`
    const symbol = "BTCUSDT"
    const setKey = `indication_set:${connectionId}:${symbol}:direction:long:unit`
    const processor = new IndicationSetsProcessor(connectionId)
    const replayTimestamp = 1_786_521_600_000
    const client = getRedisClient()
    try {
      await client.del(setKey)
      ;(processor as any).currentCycleEntries = []
      ;(processor as any).currentCyclePersistenceEnabled = false
      ;(processor as any).currentCycleSnapshotTimestamp = replayTimestamp
      await (processor as any).batchSaveIndications([{
        setKey,
        indication: {
          direction: "long",
          profitFactor: 1,
          confidence: 0.8,
          metadata: { historicalSnapshot: true },
        },
        config: { range: 2 },
      }], "direction")

      expect((processor as any).currentCycleEntries).toEqual([
        expect.objectContaining({ setKey, timestamp: replayTimestamp }),
      ])
      await expect(client.exists(setKey)).resolves.toBe(0)
    } finally {
      await client.del(setKey)
    }
  })

  test("an incomplete processed-symbol set can never fabricate a done state", async () => {
    const connectionId = `historic-incomplete-${Date.now()}`
    const client = getRedisClient()
    const scope = buildProgressionScope(connectionId)
    const keys = [
      scope.progressionKey,
      `${scope.prehistoricKey}:symbols`,
      scope.prehistoricKey,
      `settings:${scope.engineProgressionKey}`,
    ]
    try {
      await client.del(...keys)
      await client.sadd(`${scope.prehistoricKey}:symbols`, "BTCUSDT")
      await ProgressionStateManager.completePrehistoricPhase(connectionId, 3, "epoch-incomplete")

      const prehistoric = await client.hgetall(scope.prehistoricKey)
      expect(prehistoric.symbols_processed).toBe("1")
      expect(prehistoric.symbols_total).toBe("3")
      expect(prehistoric.is_complete).toBe("0")
    } finally {
      await client.del(...keys)
    }
  })

  test("historic result and position batches are idempotent inside one generation", async () => {
    const connectionId = `historic-dedupe-${Date.now()}`
    const configId = "cfg-1"
    const client = getRedisClient()
    const indicationKey = `indication:${connectionId}:config:${configId}:results`
    const strategyKey = `strategy:${connectionId}:config:${configId}:positions`
    const indicationDedupeKey = `${indicationKey}:historic_complete:epoch-1:BTCUSDT`
    const strategyDedupeKey = `${strategyKey}:historic_complete:epoch-1:BTCUSDT`
    try {
      await client.del(indicationKey, strategyKey, indicationDedupeKey, strategyDedupeKey)
      const indicationManager = new IndicationConfigManager(connectionId)
      const strategyManager = new StrategyConfigManager(connectionId)
      const indications = [{
        timestamp: "2026-07-26T10:00:00.000Z",
        symbol: "BTCUSDT",
        value: 1,
        signal: "buy" as const,
      }]
      const positions = [{
        entry_time: "2026-07-26T10:00:00.000Z",
        symbol: "BTCUSDT",
        entry_price: 100,
        take_profit: 101,
        stop_loss: 99,
        status: "closed" as const,
        result: 1,
        exit_time: "2026-07-26T10:01:00.000Z",
        exit_price: 101,
      }]

      await expect(indicationManager.addResults(configId, indications, "epoch-1:BTCUSDT")).resolves.toBe(1)
      await expect(indicationManager.addResults(configId, indications, "epoch-1:BTCUSDT")).resolves.toBe(0)
      await expect(strategyManager.addPositions(configId, positions, "epoch-1:BTCUSDT")).resolves.toBe(1)
      await expect(strategyManager.addPositions(configId, positions, "epoch-1:BTCUSDT")).resolves.toBe(0)
      await expect(client.llen(indicationKey)).resolves.toBe(1)
      await expect(client.llen(strategyKey)).resolves.toBe(1)
    } finally {
      await client.del(indicationKey, strategyKey, indicationDedupeKey, strategyDedupeKey)
    }
  })

  test("completed historic generations remove bounded list completion guards", async () => {
    const connectionId = `historic-marker-cleanup-${Date.now()}`
    const client = getRedisClient()
    const indicationMarker =
      `indication:${connectionId}:config:cfg-a:results:historic_complete:epoch-1:BTCUSDT`
    const strategyMarker =
      `strategy:${connectionId}:config:cfg-b:positions:historic_complete:epoch-1:BTCUSDT`
    const unrelated = `indication:${connectionId}:config:cfg-a:results`
    try {
      await client.set(indicationMarker, "1")
      await client.set(strategyMarker, "1")
      await client.set(unrelated, "durable")

      await expect(
        clearHistoricListCompletionMarkers(client, connectionId),
      ).resolves.toBe(2)
      await expect(client.get(indicationMarker)).resolves.toBeNull()
      await expect(client.get(strategyMarker)).resolves.toBeNull()
      await expect(client.get(unrelated)).resolves.toBe("durable")
    } finally {
      await client.del(indicationMarker, strategyMarker, unrelated)
    }
  })

  test("forward outcome lists and PF aggregates are atomically indexed", async () => {
    const connectionId = `outcome-index-${Date.now()}`
    const client = getRedisClient()
    const setKey = `indication_set:${connectionId}:BTCUSDT:active:long:test`
    const outcomesKey = `${setKey}:outcomes`
    const statsKey = `${setKey}:outcome_stats`
    const indexKey = `indication_sets:outcome_keys:index:${connectionId}`
    try {
      const processor = new IndicationSetsProcessor(connectionId)
      await (processor as any).recordOutcomeSample(setKey, { profit: 0.01, loss: 0 })

      await expect(client.smembers(indexKey)).resolves.toEqual(
        expect.arrayContaining([outcomesKey, statsKey]),
      )
      await expect(client.llen(outcomesKey)).resolves.toBe(1)
      await expect(client.hgetall(statsKey)).resolves.toMatchObject({
        grossProfit: "0.01",
        grossLoss: "0",
        count: "1",
      })
    } finally {
      await client.del(outcomesKey, statsKey, indexKey)
    }
  })

  test("reuses normalized forward candles and preserves inclusive timestamp filtering", () => {
    const processor = Object.create(IndicationSetsProcessor.prototype) as any
    processor.forwardCandleSeriesCache = new WeakMap()
    const newestFirst = [
      { timestamp: 1_786_608_120, close: 103 },
      { timestamp: 1_786_608_060, close: 102 },
      { timestamp: 1_786_608_000, close: 101 },
    ]
    const marketData = {
      candles: newestFirst,
      forwardCandles: newestFirst,
    }

    const complete = processor.getForwardCandles(marketData)
    expect(complete.map((candle: any) => candle.close)).toEqual([101, 102, 103])
    expect(processor.getForwardCandles(marketData)).toBe(complete)
    expect(
      processor.getForwardCandles(marketData, 1_786_608_060_000)
        .map((candle: any) => candle.close),
    ).toEqual([102, 103])
  })

  test("closes Base-PF pending rows exactly once and persists the realized aggregate", async () => {
    const connectionId = `pending-outcome-close-${Date.now()}`
    const symbol = "BTCUSDT"
    const client = getRedisClient()
    const setKey = `indication_set:${connectionId}:${symbol}:direction:long:test`
    const pendingKey = `indication_outcomes_pending:${connectionId}:${symbol}`
    const guardKey = `indication_outcomes_pending_guard:${connectionId}:${symbol}`
    const outcomesKey = `${setKey}:outcomes`
    const statsKey = `${setKey}:outcome_stats`
    const dedupeKey = `${setKey}:outcome_closed_ids`
    const outcomeIndexKey = `indication_sets:outcome_keys:index:${connectionId}`
    const setIndexes = [
      `indication_sets:index:${connectionId}`,
      `indication_sets:index:${connectionId}:${symbol}`,
      `indication_sets:index:${connectionId}:${symbol}:direction`,
    ]
    const openedAt = Date.now() - 180_000
    const pendingPayload = JSON.stringify({
      setKey,
      direction: "long",
      openedAt,
    })
    const pendingEntry = {
      id: "pending-base-row",
      timestamp: new Date(openedAt).toISOString(),
      type: "direction",
      direction: "long",
      profitFactor: 0.8,
      metadata: {
        direction: "long",
        outcomePending: true,
        positionCostRatio: 0.8,
      },
    }

    try {
      await client.del(
        setKey,
        pendingKey,
        guardKey,
        outcomesKey,
        statsKey,
        dedupeKey,
        outcomeIndexKey,
        ...setIndexes,
      )
      await client.rpush(setKey, JSON.stringify(pendingEntry))
      await client.rpush(pendingKey, pendingPayload)
      await client.sadd(guardKey, setKey)

      const processor = new IndicationSetsProcessor(connectionId)
      await (processor as any).settingsReady
      const marketData = {
        executionPrice: 100,
        candles: [
          { timestamp: openedAt, open: 100, high: 100.05, low: 99.95, close: 100 },
          { timestamp: openedAt + 60_000, open: 100, high: 101, low: 99.95, close: 100.8 },
          { timestamp: openedAt + 120_000, open: 100.8, high: 101.5, low: 100.7, close: 101.2 },
        ],
      }

      await expect(
        (processor as any).closePendingRealtimeOutcomes(symbol, marketData),
      ).resolves.toBe(true)

      const rows = await client.lrange(setKey, 0, -1)
      const realized = JSON.parse(rows.at(-1) || "{}")
      expect(realized.metadata?.outcomePending).toBe(false)
      expect(realized.metadata?.profitFactorSource).toBe(
        "position_cost_relative_realized_outcomes",
      )
      expect(Number(realized.profitFactor)).toBe(Number(realized.metadata?.positionCostRatio))
      expect(Number(realized.profitFactor)).not.toBe(0.8)
      await expect(client.llen(pendingKey)).resolves.toBe(0)
      await expect(client.sismember(guardKey, setKey)).resolves.toBe(0)
      await expect(client.llen(outcomesKey)).resolves.toBe(1)
      await expect(client.hgetall(statsKey)).resolves.toMatchObject({ count: "1" })

      // A second close sees an empty atomic drain and cannot double-count.
      await expect(
        (processor as any).closePendingRealtimeOutcomes(symbol, marketData),
      ).resolves.toBe(false)
      await expect(client.llen(outcomesKey)).resolves.toBe(1)
    } finally {
      await client.del(
        setKey,
        pendingKey,
        guardKey,
        outcomesKey,
        statsKey,
        dedupeKey,
        outcomeIndexKey,
        ...setIndexes,
      )
    }
  })

  test("shares identical bounded detail rows while keeping config identities addressable", async () => {
    const connectionId = `historic-result-reference-${Date.now()}`
    const leaderId = "leader"
    const aliasId = "alias"
    const client = getRedisClient()
    const manager = new IndicationConfigManager(connectionId)
    const leaderKey = `indication:${connectionId}:config:${leaderId}:results`
    const aliasKey = `indication:${connectionId}:config:${aliasId}:results`
    const aliasReferenceKey = `${aliasKey}:ref`
    const indication = {
      timestamp: "2026-08-10T10:00:00.000Z",
      symbol: "BTCUSDT",
      value: 1.25,
      signal: "buy" as const,
    }
    const second = {
      ...indication,
      timestamp: "2026-08-10T10:00:01.000Z",
      value: -0.75,
      signal: "sell" as const,
    }
    try {
      await client.del(leaderKey, aliasKey, aliasReferenceKey)
      await manager.addResults(leaderId, [indication], "generation-a:BTCUSDT")
      await manager.addResults(aliasId, [indication], "generation-a:BTCUSDT")

      await manager.setResultReferences([
        { configId: leaderId, referenceConfigId: leaderId },
        { configId: aliasId, referenceConfigId: leaderId },
      ])

      await expect(client.llen(aliasKey)).resolves.toBe(0)
      await expect(client.get(aliasReferenceKey)).resolves.toBe(leaderId)
      await expect(manager.getResults(aliasId)).resolves.toEqual([indication])
      await expect(manager.getResultCount(aliasId)).resolves.toBe(1)

      await expect(
        manager.addResults(aliasId, [second], "generation-b:BTCUSDT"),
      ).resolves.toBe(1)
      await expect(manager.getResultCount(leaderId)).resolves.toBe(2)
      await expect(manager.getResultCount(aliasId)).resolves.toBe(2)
    } finally {
      await client.del(
        leaderKey,
        aliasKey,
        aliasReferenceKey,
        `${leaderKey}:historic_complete:generation-a:BTCUSDT`,
        `${aliasKey}:historic_complete:generation-a:BTCUSDT`,
        `${leaderKey}:historic_complete:generation-b:BTCUSDT`,
      )
    }
  })

  test("overlapping historic writers atomically accept each entry once", async () => {
    const connectionId = `historic-overlap-${Date.now()}`
    const configId = "cfg-overlap"
    const scope = "epoch-overlap:BTCUSDT"
    const client = getRedisClient()
    const indicationKey = `indication:${connectionId}:config:${configId}:results`
    const strategyKey = `strategy:${connectionId}:config:${configId}:positions`
    const indicationDedupeKey = `${indicationKey}:historic_complete:${scope}`
    const strategyDedupeKey = `${strategyKey}:historic_complete:${scope}`
    const indicationManager = new IndicationConfigManager(connectionId)
    const strategyManager = new StrategyConfigManager(connectionId)
    const indication = {
      timestamp: "2026-07-26T10:00:00.000Z",
      symbol: "BTCUSDT",
      value: 1,
      signal: "buy" as const,
    }
    const position = {
      entry_time: "2026-07-26T10:00:00.000Z",
      symbol: "BTCUSDT",
      entry_price: 100,
      take_profit: 101,
      stop_loss: 99,
      status: "closed" as const,
      result: 1,
      exit_time: "2026-07-26T10:01:00.000Z",
      exit_price: 101,
    }

    try {
      await client.del(indicationKey, strategyKey, indicationDedupeKey, strategyDedupeKey)
      const [indicationA, indicationB, positionA, positionB] = await Promise.all([
        indicationManager.addResults(configId, [indication], scope),
        indicationManager.addResults(configId, [indication], scope),
        strategyManager.addPositionsWithAccepted(configId, [position], scope),
        strategyManager.addPositionsWithAccepted(configId, [position], scope),
      ])

      expect(indicationA + indicationB).toBe(1)
      expect(positionA.accepted.length + positionB.accepted.length).toBe(1)
      await expect(client.llen(indicationKey)).resolves.toBe(1)
      await expect(client.llen(strategyKey)).resolves.toBe(1)
    } finally {
      await client.del(indicationKey, strategyKey, indicationDedupeKey, strategyDedupeKey)
    }
  })

  test("a persisted list entry heals a missing dedupe ledger without duplicating", async () => {
    const connectionId = `historic-interruption-${Date.now()}`
    const configId = "cfg-interruption"
    const scope = "epoch-interruption:BTCUSDT"
    const client = getRedisClient()
    const key = `indication:${connectionId}:config:${configId}:results`
    const dedupeKey = `${key}:historic_complete:${scope}`
    const manager = new IndicationConfigManager(connectionId)
    const indication = {
      timestamp: "2026-07-26T11:00:00.000Z",
      symbol: "BTCUSDT",
      value: -1,
      signal: "sell" as const,
    }
    const serialized = `${indication.timestamp}|${indication.symbol}|${indication.value}|${indication.signal}`

    try {
      await client.del(key, dedupeKey)
      // Simulate a process interruption after LPUSH but before its ledger write.
      await client.lpush(key, serialized)
      await expect(manager.addResults(configId, [indication], scope)).resolves.toBe(0)
      await expect(client.llen(key)).resolves.toBe(1)
    } finally {
      await client.del(key, dedupeKey)
    }
  })

  test("historic aggregates are complete and incremented exactly once per config batch", async () => {
    const connectionId = `historic-aggregate-${Date.now()}`
    const markerKey = `historic:aggregate-marker:${connectionId}:strategy:cfg-1:epoch-1:BTCUSDT`
    const aggregateKey = `historic:aggregate:${connectionId}:strategies:epoch-1`
    const markerCollectionKey = historicAggregateMarkerCollectionKey(aggregateKey)
    const client = getRedisClient()
    try {
      await client.del(markerKey, markerCollectionKey, aggregateKey)
      const results = await Promise.all(
        Array.from({ length: 8 }, () => incrementHistoricAggregateOnce(
          client as any,
          markerKey,
          aggregateKey,
          [
            { field: "position_count", value: 3 },
            { field: "closed_count", value: 2 },
            { field: "gross_profit", value: 1.25 },
            { field: "gross_loss", value: 0.5 },
          ],
          3600,
        )),
      )

      expect(results.filter(Boolean)).toHaveLength(1)
      await expect(client.hgetall(aggregateKey)).resolves.toMatchObject({
        position_count: "3",
        closed_count: "2",
        gross_profit: "1.25",
        gross_loss: "0.5",
      })
      await expect(client.get(markerKey)).resolves.toBeNull()
      await expect(client.smembers(markerCollectionKey)).resolves.toEqual([markerKey])
    } finally {
      await client.del(markerKey, markerCollectionKey, aggregateKey)
    }
  })

  test("a fresh historic generation clears aggregates and interval checkpoints together", async () => {
    const connectionId = `historic-reset-${Date.now()}`
    const aggregateKey = `historic:aggregate:${connectionId}:four-hour:generation-a`
    const markerKey = `${aggregateKey}:markers`
    const legacyMarkerKey = `historic:aggregate-marker:${connectionId}:strategy:cfg:generation-a:BTCUSDT`
    const legacyIntervalsKey = `prehistoric:${connectionId}:BTCUSDT:processed_intervals`
    const scopedIntervalsKey = historicProcessedIntervalsKey(connectionId, "BTCUSDT", "generation-a")
    const unrelatedKey = `strategy:${connectionId}:config:cfg:positions`
    const client = getRedisClient()
    try {
      await client.hset(aggregateKey, { complete: "1", position_count: "99" })
      await client.sadd(markerKey, "cfg")
      await client.set(legacyMarkerKey, "1")
      await client.set(legacyIntervalsKey, "[]")
      await client.set(scopedIntervalsKey, "[]")
      await client.lpush(unrelatedKey, "durable-position")

      await expect(clearHistoricCalculationState(client, connectionId)).resolves.toBeGreaterThanOrEqual(5)
      await expect(client.hgetall(aggregateKey)).resolves.toEqual({})
      await expect(client.get(legacyMarkerKey)).resolves.toBeNull()
      await expect(client.get(legacyIntervalsKey)).resolves.toBeNull()
      await expect(client.get(scopedIntervalsKey)).resolves.toBeNull()
      await expect(client.lrange(unrelatedKey, 0, -1)).resolves.toEqual(["durable-position"])
    } finally {
      await client.del(
        aggregateKey,
        markerKey,
        legacyMarkerKey,
        legacyIntervalsKey,
        scopedIntervalsKey,
        unrelatedKey,
      )
    }
  })

  test("legacy scalar aggregate markers remain idempotent during marker compaction", async () => {
    const connectionId = `historic-legacy-marker-${Date.now()}`
    const markerKey = `historic:aggregate-marker:${connectionId}:strategy:cfg-1:epoch-1:BTCUSDT`
    const aggregateKey = `historic:aggregate:${connectionId}:strategies:epoch-1`
    const markerCollectionKey = historicAggregateMarkerCollectionKey(aggregateKey)
    const client = getRedisClient()
    try {
      await client.del(markerKey, markerCollectionKey, aggregateKey)
      await client.set(markerKey, "1", { EX: 3600 })
      await expect(incrementHistoricAggregateOnce(
        client as any,
        markerKey,
        aggregateKey,
        [{ field: "position_count", value: 3 }],
        3600,
      )).resolves.toBe(false)
      await expect(client.hgetall(aggregateKey)).resolves.toEqual({})
      await expect(client.smembers(markerCollectionKey)).resolves.toEqual([markerKey])
    } finally {
      await client.del(markerKey, markerCollectionKey, aggregateKey)
    }
  })

  test("historic indication aliases aggregate atomically in one batch", async () => {
    const connectionId = `historic-alias-batch-${Date.now()}`
    const aggregateKey = `historic:aggregate:${connectionId}:indications:epoch-1`
    const markerCollectionKey = historicAggregateMarkerCollectionKey(aggregateKey)
    const markerKeys = ["cfg-1", "cfg-2", "cfg-3"].map(
      (id) => `historic:aggregate-marker:${connectionId}:indication:${id}:epoch-1:BTCUSDT`,
    )
    const client = getRedisClient()
    try {
      await client.del(aggregateKey, markerCollectionKey, ...markerKeys)
      await expect(incrementHistoricAggregatesOnce(
        client as any,
        markerKeys,
        aggregateKey,
        [
          { field: "result_count", value: 7 },
          { field: "buy_count", value: 2 },
        ],
        3600,
      )).resolves.toBe(3)
      await expect(client.hgetall(aggregateKey)).resolves.toMatchObject({
        result_count: "21",
        buy_count: "6",
      })
      await expect(incrementHistoricAggregatesOnce(
        client as any,
        markerKeys,
        aggregateKey,
        [{ field: "result_count", value: 7 }],
        3600,
      )).resolves.toBe(0)
      await expect(client.hgetall(aggregateKey)).resolves.toMatchObject({ result_count: "21" })
      await expect(client.smembers(markerCollectionKey)).resolves.toEqual(expect.arrayContaining(markerKeys))
    } finally {
      await client.del(aggregateKey, markerCollectionKey, ...markerKeys)
    }
  })

  test("compact aggregate members preserve exact-once counts and migrate an older full-key member", async () => {
    const connectionId = `historic-compact-marker-${Date.now()}`
    const markerKey = `historic:aggregate-marker:${connectionId}:strategy:cfg:with:colon:epoch-1:BTCUSDT`
    const aggregateKey = `historic:aggregate:${connectionId}:strategies:epoch-1`
    const markerCollectionKey = historicAggregateMarkerCollectionKey(aggregateKey)
    const compactMember = JSON.stringify(["cfg:with:colon", "BTCUSDT"])
    const client = getRedisClient()
    try {
      await client.del(markerKey, markerCollectionKey, aggregateKey)
      await expect(incrementHistoricAggregateOnce(
        client as any,
        markerKey,
        aggregateKey,
        [{ field: "position_count", value: 3 }],
        3600,
        compactMember,
      )).resolves.toBe(true)
      await expect(incrementHistoricAggregateOnce(
        client as any,
        markerKey,
        aggregateKey,
        [{ field: "position_count", value: 3 }],
        3600,
        compactMember,
      )).resolves.toBe(false)
      await expect(client.smembers(markerCollectionKey)).resolves.toEqual([compactMember])

      await client.del(markerCollectionKey, aggregateKey)
      await client.sadd(markerCollectionKey, markerKey)
      await expect(incrementHistoricAggregateOnce(
        client as any,
        markerKey,
        aggregateKey,
        [{ field: "position_count", value: 3 }],
        3600,
        compactMember,
      )).resolves.toBe(false)
      await expect(client.hgetall(aggregateKey)).resolves.toEqual({})
      await expect(client.smembers(markerCollectionKey)).resolves.toEqual(
        expect.arrayContaining([markerKey, compactMember]),
      )
    } finally {
      await client.del(markerKey, markerCollectionKey, aggregateKey)
    }
  })

  test("superseded and failed historic runs stay gated and retry real work", () => {
    const manager = source("lib/trade-engine/engine-manager.ts")
    const processor = source("lib/trade-engine/config-set-processor.ts")

    expect(manager).toContain("PrehistoricRunSupersededError")
    expect(manager).toContain("prehistoricBootstrapGeneration")
    expect(manager).toContain("requestPrehistoricRecoordination")
    expect(manager).toContain("return 20 * 60_000")
    expect(manager).toContain("preserveProgressOnRetry")
    expect(manager).toContain("sameSelectionRetry")
    expect(processor).toContain("hasCompleteAggregate")
    expect(processor).toContain("historicAggregateKey(this.connectionId, \"strategies\"")
    expect(manager).toContain('prehistoric_bootstrap_status: "retry_wait"')
    expect(manager).toContain("entry_processors_gated: true")
    expect(manager).not.toContain("prehistoric failure fallback")
    expect(manager).not.toContain("Live stage ACTIVE — prehistoric failed")
    expect(processor.indexOf("await client.set(processedKey")).toBeGreaterThan(
      processor.indexOf("const [indicationResults, strategyPositions]"),
    )
    expect(processor).toContain("hadProcessedIntervals")
    expect(processor).toContain("? []")
  })

  test("a superseded realtime cycle stops before strategy and live dispatch", async () => {
    let current = true
    const processStrategy = jest.fn(async () => ({
      strategiesEvaluated: 1,
      liveReady: 1,
    }))
    const result = await runIndStratCycle(
      "generation-guard",
      "BTCUSDT",
      "realtime",
      {
        indication: {
          processIndication: async () => {
            current = false
            return [{ type: "direction" }]
          },
        } as any,
        strategy: { processStrategy } as any,
        realtime: {
          updateOpenPseudoPositionsForSymbol: jest.fn(async () => 1),
        } as any,
        shouldContinue: () => current,
      },
    )

    expect(result.indicationCount).toBe(0)
    expect(result.strategiesEvaluated).toBe(0)
    expect(processStrategy).not.toHaveBeenCalled()
  })

  test("a fresh empty realtime result still advances the scoped strategy fast path", async () => {
    const processStrategy = jest.fn(async () => ({
      strategiesEvaluated: 2,
      liveReady: 1,
    }))

    const result = await runIndStratCycle(
      "realtime-snapshot-reuse",
      "BTCUSDT",
      "realtime",
      {
        indication: {
          processIndication: async () => [],
          isRealtimeSnapshotReady: () => true,
        } as any,
        strategy: { processStrategy } as any,
        realtime: {
          updateOpenPseudoPositionsForSymbol: jest.fn(async () => 0),
        } as any,
        enableStrategyFlow: true,
      },
    )

    expect(result).toMatchObject({
      indicationCount: 0,
      strategiesEvaluated: 2,
      liveReady: 1,
    })
    expect(processStrategy).toHaveBeenCalledWith(
      "BTCUSDT",
      [],
      false,
      expect.any(Function),
      "realtime",
    )
  })

  test("an empty realtime result without a fresh snapshot cannot reuse stale strategy rows", async () => {
    const processStrategy = jest.fn(async () => ({
      strategiesEvaluated: 1,
      liveReady: 1,
    }))

    const result = await runIndStratCycle(
      "realtime-snapshot-stale",
      "BTCUSDT",
      "realtime",
      {
        indication: {
          processIndication: async () => [],
          isRealtimeSnapshotReady: () => false,
        } as any,
        strategy: { processStrategy } as any,
        realtime: {
          updateOpenPseudoPositionsForSymbol: jest.fn(async () => 0),
        } as any,
        enableStrategyFlow: true,
      },
    )

    expect(result.strategiesEvaluated).toBe(0)
    expect(processStrategy).not.toHaveBeenCalled()
  })

  test("the shared historic pipeline forwards isolated mode and skips live handling", async () => {
    const processStrategy = jest.fn(async () => ({
      strategiesEvaluated: 3,
      liveReady: 0,
    }))
    const updateOpenPseudoPositionsForSymbol = jest.fn(async () => 1)
    const indications = [{ type: "direction", validated: true }]

    const result = await runIndStratCycle(
      "historic-mode-forwarding",
      "BTCUSDT",
      "historical",
      {
        indication: {
          processIndication: async () => indications,
        } as any,
        strategy: { processStrategy } as any,
        realtime: { updateOpenPseudoPositionsForSymbol } as any,
        enableStrategyFlow: true,
      },
    )

    expect(result).toMatchObject({
      mode: "historical",
      indicationCount: 1,
      strategiesEvaluated: 3,
      liveReady: 0,
      pseudoUpdates: 0,
    })
    expect(updateOpenPseudoPositionsForSymbol).not.toHaveBeenCalled()
    expect(processStrategy).toHaveBeenCalledWith(
      "BTCUSDT",
      indications,
      true,
      expect.any(Function),
      "prehistoric",
    )
  })

  test("the live handoff rechecks generation before every exchange submission", () => {
    const coordinator = source("lib/strategy-coordinator.ts")
    const liveStage = source("lib/trade-engine/stages/live-stage.ts")

    expect(coordinator).toContain("shouldContinue?: () => boolean")
    expect(coordinator).toContain("executeLivePosition(")
    expect(coordinator).toContain("connector,")
    expect(coordinator).toContain("isCurrent,")
    expect(liveStage).toContain("Execution generation changed before submission")
    expect(liveStage).toContain("if (!isCurrent())")
    expect(liveStage.indexOf("if (!isCurrent())")).toBeLessThan(
      liveStage.indexOf("return exchangeConnector.placeOrder("),
    )
  })

  test("historic strategy calculation keeps live events, snapshots, and active exposure isolated", () => {
    const coordinator = source("lib/strategy-coordinator.ts")
    const pipeline = source("lib/trade-engine/shared-ind-strat-pipeline.ts")
    const processor = source("lib/trade-engine/strategy-processor.ts")
    const indicationProcessor = source("lib/trade-engine/indication-processor-fixed.ts")
    const indicationSets = source("lib/indication-sets-processor.ts")

    expect(coordinator).toContain("if (!isPrehistoric) {\n        emitCanonicalEvent({ type: \"strategy.stageChanged\"")
    expect(coordinator).toContain("if (!isPrehistoric) {\n        await this.logStrategyProgression(symbol, results)")
    expect(coordinator).toContain("!isPrehistoric,\n        !isPrehistoric,")
    expect(coordinator).toContain("persistStats = true")
    expect(coordinator).toContain("includeCurrentActive = true")
    expect(coordinator).toContain("includeCurrentActive ? this.getUnavailableBlockKeys(symbol) : Promise.resolve(new Set<string>())")
    expect(pipeline).toContain('mode === "historical" ? "prehistoric" : "realtime"')
    expect(processor).toContain("getStrategyCoordinator(this.connectionId, mode)")
    expect(processor).toContain("skipLiveDispatch || isPrehistoric")
    expect(processor).toContain("if (!isPrehistoric) {")
    expect(coordinator).toContain("getStrategySetLedgerSnapshot(this.connectionId)")
    expect(coordinator).toContain("const exactSetLedgerSnapshot: StrategySetLedgerSnapshot = isPrehistoric")
    expect(indicationProcessor).toContain("const indicationStorageConnectionId = isHistorical")
    expect(indicationProcessor).toContain("preserveTimestamps: isHistorical")
    expect(indicationProcessor).toContain("if (!isHistorical && indications.length > 0)")
    expect(indicationSets).toContain("this.currentCyclePersistenceEnabled = !isHistoricalSnapshot")
    expect(indicationSets).toContain("if (!this.currentCyclePersistenceEnabled) return")
  })

  test("the header monitor exposes bounded system, processing, settings, alert, warning, and error sections", () => {
    const route = source("app/api/trade-engine/detailed-logs/route.ts")
    const button = source("components/dashboard/detailed-logs-button.tsx")
    const dashboard = source("components/dashboard/dashboard.tsx")

    expect(dashboard).toContain("<DetailedLogsButton />")
    expect(route).toContain("SystemLogger.getLogs(undefined, 200)")
    expect(route).toContain("getFreshestProcessorHeartbeat")
    expect(route).toContain("withinMonitorDeadline")
    expect(route).toContain("generationMatches")
    expect(route).toContain("settingsSynchronized")
    expect(route).toContain("prehistoric_bootstrap_started_at")
    expect(route).not.toContain("toEpochMs((state as any).updated_at)")
    expect(route).toContain("sectionCounts")
    expect(route).toContain("signalCapacity: item.signalCapacity")
    expect(route).not.toContain("client.keys(`prehistoric:")
    for (const label of ["Overview", "Activity", "Processing", "Settings", "Orders", "Warnings", "Errors", "System"]) {
      expect(button).toContain(`label: "${label}"`)
    }
    expect(button).toContain("Connection lifecycle")
    expect(button).toContain("Alerts and warnings")
    expect(button).toContain("text-[10px]")
  })

  test("healthy engine-cycle logs stay globally coalesced and bounded", () => {
    const indicationSets = source("lib/indication-sets-processor.ts")
    const liveStage = source("lib/trade-engine/stages/live-stage.ts")

    expect(indicationSets).toContain("logRuntimeInfo(")
    expect(indicationSets).toContain("logRuntimeWarning(")
    expect(indicationSets).toContain("60_000")
    expect(indicationSets).toContain("if (didLogSummary)")
    expect(indicationSets).toContain("if (didLogWarning)")
    expect(indicationSets).not.toContain("_setsLogBucket")
    expect(indicationSets).not.toContain("shortPriceHistoryWarnings")

    expect(liveStage).toContain("logRuntimeInfo(")
    expect(liveStage).toContain("30_000")
    expect(liveStage).toContain("sync-skip")
  })
})

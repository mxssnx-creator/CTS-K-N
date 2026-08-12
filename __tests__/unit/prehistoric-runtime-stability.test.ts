import { readFileSync } from "node:fs"
import { join } from "node:path"
import { getRedisClient, setSettings } from "@/lib/redis-db"
import { buildProgressionScope } from "@/lib/progression-scope"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { IndicationConfigManager } from "@/lib/indication-config-manager"
import { IndicationSetsProcessor } from "@/lib/indication-sets-processor"
import { StrategyConfigManager } from "@/lib/strategy-config-manager"
import { getCanonicalSymbolSelection } from "@/lib/trade-engine/symbol-selection-ownership"
import { runIndStratCycle } from "@/lib/trade-engine/shared-ind-strat-pipeline"
import {
  clearHistoricListCompletionMarkers,
  historicAggregateMarkerCollectionKey,
  incrementHistoricAggregateOnce,
  incrementHistoricAggregatesOnce,
} from "@/lib/redis-idempotent-list"
import {
  groupHistoricIndicationCalculationConfigs,
  groupHistoricIndicationCalculationGroupsByGeometry,
} from "@/lib/trade-engine/config-set-processor"

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8")
}

describe("historic runtime generation stability", () => {
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

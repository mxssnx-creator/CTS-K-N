import { readFileSync } from "node:fs"
import { join } from "node:path"
import { getRedisClient, setSettings } from "@/lib/redis-db"
import { buildProgressionScope } from "@/lib/progression-scope"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { IndicationConfigManager } from "@/lib/indication-config-manager"
import { StrategyConfigManager } from "@/lib/strategy-config-manager"
import { getCanonicalSymbolSelection } from "@/lib/trade-engine/symbol-selection-ownership"
import { runIndStratCycle } from "@/lib/trade-engine/shared-ind-strat-pipeline"

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8")
}

describe("historic runtime generation stability", () => {
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
        symbols: ["BTCUSDT", "ETHUSDT"],
        total: 2,
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
    const indicationDedupeKey = `${indicationKey}:historic_dedupe:epoch-1:BTCUSDT`
    const strategyDedupeKey = `${strategyKey}:historic_dedupe:epoch-1:BTCUSDT`
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

  test("overlapping historic writers atomically accept each entry once", async () => {
    const connectionId = `historic-overlap-${Date.now()}`
    const configId = "cfg-overlap"
    const scope = "epoch-overlap:BTCUSDT"
    const client = getRedisClient()
    const indicationKey = `indication:${connectionId}:config:${configId}:results`
    const strategyKey = `strategy:${connectionId}:config:${configId}:positions`
    const indicationDedupeKey = `${indicationKey}:historic_dedupe:${scope}`
    const strategyDedupeKey = `${strategyKey}:historic_dedupe:${scope}`
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
    const dedupeKey = `${key}:historic_dedupe:${scope}`
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

  test("superseded and failed historic runs stay gated and retry real work", () => {
    const manager = source("lib/trade-engine/engine-manager.ts")
    const processor = source("lib/trade-engine/config-set-processor.ts")

    expect(manager).toContain("PrehistoricRunSupersededError")
    expect(manager).toContain("prehistoricBootstrapGeneration")
    expect(manager).toContain("requestPrehistoricRecoordination")
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

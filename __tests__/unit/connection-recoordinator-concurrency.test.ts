const hashes = new Map<string, Record<string, any>>()
const writeLog: Array<{ key: string; patch: Record<string, any> }> = []

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

jest.mock("@/lib/settings-coordinator", () => ({
  notifySettingsChanged: jest.fn(async () => undefined),
  detectChangedFields: jest.fn(() => []),
}))

jest.mock("@/lib/events/emitter", () => ({
  emitCanonicalEvent: jest.fn((event: any) => ({ id: `${event.type}:event`, settingsVersion: "test-version", ...event })),
}))

jest.mock("@/lib/redis-db", () => ({
  getRedisClient: jest.fn(() => ({
    hset: jest.fn(async (key: string, patch: Record<string, any>) => {
      writeLog.push({ key, patch: { ...patch } })
      hashes.set(key, { ...(hashes.get(key) || {}), ...patch })
      return 1
    }),
    hdel: jest.fn(async (key: string, ...fields: string[]) => {
      const hash = { ...(hashes.get(key) || {}) }
      for (const field of fields) delete hash[field]
      hashes.set(key, hash)
      return fields.length
    }),
    del: jest.fn(async (...keys: string[]) => {
      for (const key of keys) hashes.delete(key)
      return keys.length
    }),
    hgetall: jest.fn(async () => ({ operator_intent: "stopped" })),
  })),
}))

jest.mock("@/lib/progression-state-manager", () => ({
  ProgressionStateManager: {
    recoordinateForActualOne: jest.fn(async (connectionId: string) => {
      await sleep(25)
      return { changed: true, reason: "symbol-basket-or-mode-change", newEpoch: hashes.get(`trade_engine_state:${connectionId}`)?.symbol_selection_epoch }
    }),
  },
}))

jest.mock("@/lib/strategy-coordinator", () => ({
  StrategyCoordinator: { forceNextSettingsReload: jest.fn() },
}))

jest.mock("@/lib/engine-refresh-queue", () => ({
  queueEngineRefreshRequest: jest.fn(async () => undefined),
}))

jest.mock("@/lib/connection-coordinator", () => ({
  ConnectionCoordinator: { getInstance: jest.fn(() => ({ refreshConnection: jest.fn(async () => undefined) })) },
}))

jest.mock("@/lib/trade-engine", () => ({
  getGlobalTradeEngineCoordinator: jest.fn(() => ({
    getEngineManager: jest.fn(() => null),
    applyPendingChangesNow: jest.fn(async () => undefined),
    isEngineRunning: jest.fn(() => false),
  })),
}))

jest.mock("@/lib/connection-state-utils", () => ({
  isConnectionMainProcessing: jest.fn(() => false),
  hasConnectionCredentials: jest.fn(() => false),
  isTruthyFlag: jest.fn((value: any) => value === true || value === "1" || value === "true"),
}))

describe("connection recoordinator serialization", () => {
  beforeEach(() => {
    hashes.clear()
    writeLog.length = 0
    jest.clearAllMocks()
  })

  test("concurrent symbol-basket and strategy saves leave epoch, fields, and flags coherent", async () => {
    const { recoordinateAfterSettingsChange } = await import("@/lib/connection-recoordinator")
    const before = { id: "conn-concurrent", symbols: ["BTC-USDT"], mainProfitFactor: 1.2 }

    await Promise.all([
      recoordinateAfterSettingsChange(
        "conn-concurrent",
        before,
        { ...before, symbols: ["ETH-USDT", "SOL-USDT"] },
        { logTag: "symbol-save", changedFieldsOverride: ["symbols"] },
      ),
      recoordinateAfterSettingsChange(
        "conn-concurrent",
        before,
        { ...before, mainProfitFactor: 1.8 },
        { logTag: "strategy-save", changedFieldsOverride: ["mainProfitFactor"] },
      ),
    ])

    const engineState = hashes.get("trade_engine_state:conn-concurrent") || {}
    const mirroredEngineState = hashes.get("settings:trade_engine_state:conn-concurrent") || {}
    const progression = hashes.get("progression:conn-concurrent") || {}

    expect(engineState.symbol_selection_epoch).toEqual(expect.any(String))
    expect(mirroredEngineState.symbol_selection_epoch).toBe(engineState.symbol_selection_epoch)
    expect(engineState.quickstart_symbol_generation).toBe(engineState.symbol_selection_epoch)
    expect(progression.settings_recoordination_fields).toBe(JSON.stringify(["mainProfitFactor"]))
    expect(progression.settings_recoordination_pending).toBe("0")
    expect(progression.settings_recoordination_completed).toBe("1")
    expect(progression.settings_recoordination_completed_at).toEqual(expect.any(String))
    expect(progression.strategy_recompute_requested).toBe("1")
    expect(progression.stats_recalculation_requested).toBe("1")

    const firstStrategyProgressionWrite = writeLog.findIndex(
      (entry) => entry.key === "progression:conn-concurrent" && entry.patch.settings_recoordination_fields === JSON.stringify(["mainProfitFactor"]),
    )
    const symbolCompletionWrite = writeLog.findIndex(
      (entry) => entry.key === "progression:conn-concurrent" && entry.patch.settings_recoordination_reason === "symbol-basket-or-mode-change",
    )

    expect(symbolCompletionWrite).toBeGreaterThanOrEqual(0)
    expect(firstStrategyProgressionWrite).toBeGreaterThan(symbolCompletionWrite)
  })
})

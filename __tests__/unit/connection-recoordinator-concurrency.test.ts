const hashes = new Map<string, Record<string, any>>()
const writeLog: Array<{ key: string; patch: Record<string, any> }> = []
let activeProgressionRecoordinates = 0
let maxActiveProgressionRecoordinates = 0

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
      activeProgressionRecoordinates++
      maxActiveProgressionRecoordinates = Math.max(
        maxActiveProgressionRecoordinates,
        activeProgressionRecoordinates,
      )
      try {
        await sleep(25)
        return { changed: true, reason: "symbol-basket-or-mode-change", newEpoch: hashes.get(`trade_engine_state:${connectionId}`)?.symbol_selection_epoch }
      } finally {
        activeProgressionRecoordinates--
      }
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
  isConnectionLiveTradeEnabled: jest.fn(() => false),
  isConnectionPresetTradeEnabled: jest.fn(() => false),
  hasConnectionCredentials: jest.fn(() => false),
  isTruthyFlag: jest.fn((value: any) => value === true || value === "1" || value === "true"),
}))

describe("connection recoordinator serialization", () => {
  beforeEach(() => {
    hashes.clear()
    writeLog.length = 0
    activeProgressionRecoordinates = 0
    maxActiveProgressionRecoordinates = 0
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
    // Saving only queues the newest settings generation. A bounded Kilo owner
    // sets completed=1 after it has actually processed and atomically ACKed it.
    expect(progression.settings_recoordination_pending).toBe("1")
    expect(progression.settings_recoordination_completed).toBe("0")
    expect(progression.settings_recoordination_completed_at).toBe("")
    expect(progression.strategy_recompute_requested).toBe("1")
    expect(progression.stats_recalculation_requested).toBe("1")

    const firstStrategyProgressionWrite = writeLog.findIndex(
      (entry) => entry.key === "progression:conn-concurrent" && entry.patch.settings_recoordination_fields === JSON.stringify(["mainProfitFactor"]),
    )
    const symbolQueuedWrite = writeLog.findIndex(
      (entry) => entry.key === "progression:conn-concurrent" && entry.patch.settings_recoordination_reason === "symbol-basket-or-mode-change:queued-for-processing",
    )

    expect(symbolQueuedWrite).toBeGreaterThanOrEqual(0)
    expect(firstStrategyProgressionWrite).toBeGreaterThan(symbolQueuedWrite)
  })

  test("three concurrent destructive saves form one strict per-connection queue", async () => {
    const { recoordinateAfterSettingsChange } = await import("@/lib/connection-recoordinator")
    const { ProgressionStateManager } = await import("@/lib/progression-state-manager")
    const before = { id: "conn-three-save-race", symbols: ["BTC-USDT"] }

    await Promise.all([
      recoordinateAfterSettingsChange(
        "conn-three-save-race",
        before,
        { ...before, symbols: ["ETH-USDT"] },
        { logTag: "save-1", changedFieldsOverride: ["symbols"] },
      ),
      recoordinateAfterSettingsChange(
        "conn-three-save-race",
        before,
        { ...before, symbols: ["SOL-USDT"] },
        { logTag: "save-2", changedFieldsOverride: ["symbols"] },
      ),
      recoordinateAfterSettingsChange(
        "conn-three-save-race",
        before,
        { ...before, symbols: ["XRP-USDT"] },
        { logTag: "save-3", changedFieldsOverride: ["symbols"] },
      ),
    ])

    expect(ProgressionStateManager.recoordinateForActualOne).toHaveBeenCalledTimes(3)
    expect(maxActiveProgressionRecoordinates).toBe(1)
    expect(activeProgressionRecoordinates).toBe(0)
  })

  test("reports a superseded refresh as durably queued for the existing stronger owner job", async () => {
    const { queueEngineRefreshRequest } = await import("@/lib/engine-refresh-queue")
    ;(queueEngineRefreshRequest as jest.Mock).mockResolvedValueOnce({
      refreshQueued: false,
      refreshSuperseded: true,
      refresh_queued_at: "2026-07-21T00:00:00.000Z",
      retryCount: 0,
      immediateDrainAttempted: false,
      immediateDrainApplied: false,
    })

    const { recoordinateAfterSettingsChange } = await import("@/lib/connection-recoordinator")
    const before = { id: "conn-superseded", mainProfitFactor: 1.2 }
    const completion = await recoordinateAfterSettingsChange(
      "conn-superseded",
      before,
      { ...before, mainProfitFactor: 1.3 },
      { logTag: "superseded-refresh", changedFieldsOverride: ["mainProfitFactor"] },
    )

    expect(completion.refreshStatus).toMatchObject({
      refreshQueued: false,
      refreshSuperseded: true,
    })
    expect(completion.refreshQueued).toBe(true)
    expect(completion.queuedForOwner).toBe(true)
    expect(completion.appliedLocally).toBe(false)
  })

  test("live sizing save gets an owner-ACK generation without resetting Historic/Main", async () => {
    const { recoordinateAfterSettingsChange } = await import("@/lib/connection-recoordinator")
    const { ProgressionStateManager } = await import("@/lib/progression-state-manager")
    const before = { id: "conn-live-sizing", live_volume_factor: 1 }

    await recoordinateAfterSettingsChange(
      "conn-live-sizing",
      before,
      { ...before, live_volume_factor: 1.2 },
      { logTag: "live-volume-save", changedFieldsOverride: ["live_volume_factor"] },
    )

    const progression = hashes.get("progression:conn-live-sizing") || {}
    const liveState = hashes.get("trade_engine_state:conn-live-sizing") || {}
    expect(progression).toMatchObject({
      settings_recoordination_pending: "1",
      settings_recoordination_completed: "0",
      settings_recoordination_fields: JSON.stringify(["live_volume_factor"]),
      settings_recoordination_requested_version: expect.any(String),
      settings_recoordination_requested_event_id: "settings.saved:event",
      settings_recoordination_reason: "live-order-settings-reload:queued-for-processing",
    })
    expect(progression.stats_recalculation_requested).toBeUndefined()
    expect(liveState.live_order_settings_fields).toBe(JSON.stringify(["live_volume_factor"]))
    expect(ProgressionStateManager.recoordinateForActualOne).not.toHaveBeenCalled()
  })
})

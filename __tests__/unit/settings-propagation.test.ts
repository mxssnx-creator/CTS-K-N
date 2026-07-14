/**
 * Regression coverage for save-while-running settings propagation.
 *
 * Scenario: an operator saves a Main Connection PF threshold while the engine
 * is running. The PATCH handler persists the new flat threshold and calls the
 * settings recoordinator; this test covers the durable signal contract that
 * makes the engine-owning process consume the new threshold on the next (or
 * immediate) strategy cycle and lets the UI refresh without manual stop/start.
 */

const writes: Array<{ key: string; value: unknown }> = []
const redisSets: Array<{ key: string; value: string; options?: unknown }> = []
const hsets: Array<{ key: string; value: unknown }> = []
const store = new Map<string, unknown>()

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getConnection: jest.fn(async () => null),
  getSettings: jest.fn(async (key: string) => store.get(key) ?? null),
  setSettings: jest.fn(async (key: string, value: unknown) => {
    writes.push({ key, value })
    store.set(key, value)
  }),
  getRedisClient: jest.fn(() => ({
    set: jest.fn(async (key: string, value: string, options?: unknown) => {
      if ((options as any)?.NX && store.has(key)) return null
      redisSets.push({ key, value, options })
      store.set(key, value)
      return "OK"
    }),
    get: jest.fn(async (key: string) => String(store.get(key) ?? "") || null),
    incr: jest.fn(async (key: string) => {
      const next = Number(store.get(key) ?? 0) + 1
      store.set(key, String(next))
      return next
    }),
    del: jest.fn(async (key: string) => {
      const direct = store.delete(key)
      const logical = key.startsWith("settings:") ? store.delete(key.slice("settings:".length)) : false
      return direct || logical ? 1 : 0
    }),
    hset: jest.fn(async (key: string, value: unknown) => {
      hsets.push({ key, value })
      return 1
    }),
    hdel: jest.fn(async () => 1),
  })),
}))

describe("settings propagation", () => {
  beforeEach(() => {
    writes.length = 0
    redisSets.length = 0
    hsets.length = 0
    store.clear()
    store.set("trade_engine_state:conn-main", { status: "running" })
  })

  test("PF-only PATCH changes persist dirty flag and reload envelope before success", async () => {
    const { notifySettingsChanged } = await import("@/lib/settings-coordinator")

    await notifySettingsChanged(
      "conn-main",
      ["strategies", "mainProfitFactor", "connection_settings"],
      { connection_settings: { strategies: { main: { main: { min_profit_factor: 1.2 } } } } },
      { connection_settings: { strategies: { main: { main: { min_profit_factor: 1.8 } } } } },
    )

    expect(writes.map((w) => w.key)).toContain("settings_change:conn-main")
    expect(writes.some((w) => w.key === "settings:dirty:conn-main")).toBe(false)
    expect(redisSets).toContainEqual({
      key: "settings:dirty:conn-main",
      value: "1",
      options: { EX: 300 },
    })
    expect(writes.find((w) => w.key === "settings_change:conn-main")?.value).toMatchObject({
      connectionId: "conn-main",
      changeType: "reload",
      changedFields: ["strategies", "mainProfitFactor", "connection_settings"],
    })
    expect(hsets.find((w) => w.key === "settings:trade_engine_state:conn-main")?.value).toMatchObject({
      reload_required: "1",
      reload_fields: JSON.stringify(["strategies", "mainProfitFactor", "connection_settings"]),
    })
    expect(store.get("settings:settings_change_counter:conn-main:value")).toBe("1")
    expect(hsets.find((w) => w.key === "progression:conn-main")?.value).toHaveProperty("settings_changed_at")
  })

  test("in-process settings event fires after durable reload state is written", async () => {
    const { notifySettingsChanged, onSettingsChanged } = await import("@/lib/settings-coordinator")
    const observed: Array<{ hasReloadState: boolean; pendingExists: boolean }> = []
    const unsubscribe = onSettingsChanged("conn-main", () => {
      observed.push({
        hasReloadState: hsets.some(
          (w) => w.key === "settings:trade_engine_state:conn-main" && (w.value as any)?.reload_required === "1",
        ),
        pendingExists: writes.some((w) => w.key === "settings_change:conn-main"),
      })
    })

    try {
      await notifySettingsChanged("conn-main", ["strategies"])
      await Promise.resolve()
    } finally {
      unsubscribe()
    }

    expect(observed).toEqual([{ hasReloadState: true, pendingExists: true }])
  })

  test("in-process settings event handler failures do not fail durable settings save", async () => {
    const { notifySettingsChanged, onSettingsChanged } = await import("@/lib/settings-coordinator")
    const unsubscribe = onSettingsChanged("conn-main", () => {
      throw new Error("subscriber failed")
    })

    try {
      await expect(notifySettingsChanged("conn-main", ["strategies"])).resolves.toMatchObject({
        connectionId: "conn-main",
        changeType: "reload",
      })
    } finally {
      unsubscribe()
    }

    expect(writes.some((w) => w.key === "settings_change:conn-main")).toBe(true)
    expect(hsets.some((w) => w.key === "settings:trade_engine_state:conn-main")).toBe(true)
  })

  test("settings counter stays numeric beyond nine and pending cleanup is event-owned", async () => {
    const { notifySettingsChanged, getChangeCounter, getPendingChanges, clearPendingChanges } = await import(
      "@/lib/settings-coordinator"
    )

    let firstEvent: Awaited<ReturnType<typeof notifySettingsChanged>> | undefined
    let latestEvent: Awaited<ReturnType<typeof notifySettingsChanged>> | undefined
    for (let index = 0; index < 12; index++) {
      latestEvent = await notifySettingsChanged(
        "conn-main",
        [index % 2 === 0 ? "strategies" : "live_volume_factor"],
        { api_secret: "must-not-be-retained", updated_at: `2026-07-14T12:00:${String(index).padStart(2, "0")}.000Z` },
        { api_key: "must-not-be-retained", updated_at: `2026-07-14T12:00:${String(index + 1).padStart(2, "0")}.000Z` },
      )
      firstEvent ||= latestEvent
    }

    await expect(getChangeCounter("conn-main")).resolves.toBe(12)
    const pending = await getPendingChanges("conn-main")
    expect(pending?.changedFields).toEqual(expect.arrayContaining(["strategies", "live_volume_factor"]))
    expect(pending?.previousValues).not.toHaveProperty("api_secret")
    expect(pending?.newValues).not.toHaveProperty("api_key")
    await expect(clearPendingChanges("conn-main", firstEvent)).resolves.toBe(false)
    await expect(getPendingChanges("conn-main")).resolves.toMatchObject({ eventId: latestEvent?.eventId })
    await expect(clearPendingChanges("conn-main", latestEvent)).resolves.toBe(true)
    await expect(getPendingChanges("conn-main")).resolves.toBeNull()
  })

  test("legacy connection-settings writer mirrors engine stores and recoordinates", () => {
    const fs = require("fs")
    const path = require("path")
    const source = fs.readFileSync(
      path.join(process.cwd(), "lib/connection-settings.ts"),
      "utf8",
    )

    expect(source).toContain("mirrorEngineSettingsStores")
    expect(source).toContain("connection_settings:${connectionId}")
    expect(source).toContain("settings:connection_settings:${connectionId}")
    expect(source).toContain("extractConnectionTopLevelMirror")
    for (const field of [
      "live_volume_factor",
      "preset_volume_factor",
      "volume_step_ratio",
      "force_symbols",
      "symbol_count",
      "is_live_trade",
      "position_mode",
      "margin_type",
    ]) {
      expect(source).toContain(field)
    }
    expect(source).toContain("recoordinateAfterSettingsChange")
    expect(source).toContain("notifySettingsChanged")
  })

  test("canonical settings PATCH has no pre-recoordination partial Redis writes", () => {
    const fs = require("fs")
    const path = require("path")
    const source = fs.readFileSync(path.join(process.cwd(), "app/api/settings/connections/[id]/settings/route.ts"), "utf8")
    const patchSource = source.slice(source.indexOf("export async function PATCH"))
    const beforeApply = patchSource.slice(0, patchSource.indexOf("const { connection: appliedConnection, completion: recoordination } = await applyMainConnectionSettingsChange("))

    expect(beforeApply).toContain("let effectiveConnection = updated")
    expect(beforeApply).not.toContain("updateConnection(id, updated)")
    expect(beforeApply).not.toContain("redis.hset(`connection_settings:${id}`")
    expect(beforeApply).not.toContain("redis.hset(`trade_engine_state:${id}`")
    expect(beforeApply).not.toContain("setSettings(stateKey")
    expect(beforeApply).not.toContain("updateConnection(id, {")
  })

  test("notifySettingsChanged writes dirty flags through raw Redis instead of setSettings", () => {
    const fs = require("fs")
    const path = require("path")
    const source = fs.readFileSync(
      path.join(process.cwd(), "lib/settings-coordinator.ts"),
      "utf8",
    )
    const notifyBody = source.match(/export async function notifySettingsChanged[\s\S]*?\n}\n\n\/\*\*/)

    expect(notifyBody?.[0]).toContain('client.set(`settings:dirty:${connectionId}`, "1"')
    expect(notifyBody?.[0]).not.toContain('setSettings(`settings:dirty:${connectionId}`')
  })


  test("strategy settings save pending flags are cleared only after engine applyPendingChangesNow consumes the change", () => {
    const fs = require("fs")
    const path = require("path")
    const manager = fs.readFileSync(path.join(process.cwd(), "lib/trade-engine/engine-manager.ts"), "utf8")
    const recoordinator = fs.readFileSync(path.join(process.cwd(), "lib/connection-recoordinator.ts"), "utf8")
    const quickstart = fs.readFileSync(path.join(process.cwd(), "app/api/trade-engine/quick-start/route.ts"), "utf8")

    expect(recoordinator).toContain('settings_recoordination_pending: "1"')
    expect(recoordinator).toContain('strategy_recompute_requested: "1"')
    expect(recoordinator).toContain("settings_recoordination_requested_event_id: settingsEvent.id")
    expect(recoordinator).toContain("await coordinator.applyPendingChangesNow(id)")

    const applyBlock = manager.slice(
      manager.indexOf("private async applyPendingSettingsChange()"),
      manager.indexOf("private async applyHotReload"),
    )
    expect(applyBlock).toContain("await this.applyHotReload(fields)")
    expect(applyBlock).toContain("await clearPendingChanges(this.connectionId, event)")
    expect(applyBlock).toContain("if (!cleared) this.settingsApplyQueued = true")
    expect(applyBlock).toContain("await this.stampSettingsRecoordinationApplied(event)")
    expect(manager).toContain('settings_recoordination_pending: "0"')
    expect(manager).toContain('strategy_recompute_requested: "0"')
    expect(manager).toContain("settings_recoordination_completed_at")
    expect(manager).toContain("settings_recoordination_applied_event_id")
    expect(manager).toContain("settings_recoordination_last_error")
    expect(manager).toContain("settingsWatcherGeneration")
    expect(manager).toContain("watcherGeneration !== this.settingsWatcherGeneration")
    expect(manager).toContain("throw err")

    expect(quickstart).toContain("it no longer clears")
    expect(quickstart).toContain('...(quickstartEngineAlreadyRunning ? {} : { settings_recoordination_pending: "0" })')
  })

  test("continuous, Block, trailing, and DCA settings are reload/progress affecting", async () => {
    const { classifyChange } = await import("@/lib/settings-coordinator")

    for (const field of [
      "axisContEnabled",
      "axisContMaxWindow",
      "blockPauseCountRatio",
      "blockActiveRealEnabled",
      "blockActiveLiveEnabled",
      "strategyBaseTrailingVariants",
      "dcaMaxSteps",
      "dcaStepVolumeMultipliers",
      "dcaStepDistancesPct",
      "dcaTakeProfitMode",
      "dcaBreakevenProfitPct",
      "dcaCooldownSeconds",
    ]) {
      expect(classifyChange([field])).toBe("reload")
    }
  })

  test("engine hot reload treats continuous, Block, trailing, and DCA knobs as strategy-affecting", async () => {
    const { hasStrategyAffectingChange } = await import("@/lib/trade-engine/settings-change-fields")

    for (const field of [
      "axisContEnabled",
      "axisContMaxWindow",
      "blockPauseCountRatio",
      "blockActiveRealEnabled",
      "blockActiveLiveEnabled",
      "strategyBaseTrailingVariants",
      "dcaMaxSteps",
      "dcaStepVolumeMultipliers",
      "dcaStepDistancesPct",
      "dcaTakeProfitMode",
      "dcaBreakevenProfitPct",
      "dcaCooldownSeconds",
    ]) {
      expect(hasStrategyAffectingChange([field])).toBe(true)
      expect(hasStrategyAffectingChange([`connection_settings.${field}`])).toBe(true)
    }
  })

})

describe("System tab capacity controls", () => {
  test("exposes capacity and stage controls using canonical settings keys", () => {
    const fs = require("fs")
    const path = require("path")
    const source = fs.readFileSync(
      path.join(process.cwd(), "components/settings/tabs/system-tab.tsx"),
      "utf8",
    )

    expect(source).toContain("Capacity & Stage Limits")
    for (const key of [
      "symbolOrderType",
      "numberOfSymbolsToSelect",
      "mainSymbols",
      "forcedSymbols",
      "setCompactionFloor",
      "setCompactionThresholdPct",
      "setCompactionByType",
      "indication.direction",
      "indication.move",
      "indication.active",
      "indication.optimal",
      "indication.active_advanced",
      "strategy.base",
      "strategy.main",
      "strategy.real",
      "strategy.live",
      "indicationTimeoutMs",
      "indication_state_retention_hours",
      "maxRealSets",
      "stageMinPosCountBase",
      "stageMinPosCountMain",
      "stageMinPosCountReal",
      "baseProfitFactor",
      "mainProfitFactor",
      "realProfitFactor",
      "liveProfitFactor",
      "maxDrawdownTimeMainHours",
      "maxDrawdownTimeRealHours",
      "maxDrawdownTimeLiveHours",
    ]) {
      expect(source).toContain(key)
    }

    expect(source).not.toContain('handleSettingChange("symbolCount"')
    expect(source).not.toContain('handleSettingChange("capacity')
  })
})

describe("engine refresh queue status", () => {
  test("queued refresh status and queued-vs-local application are surfaced", () => {
    const fs = require("fs")
    const path = require("path")
    const queueSource = fs.readFileSync(path.join(process.cwd(), "lib/engine-refresh-queue.ts"), "utf8")
    const recoordinatorSource = fs.readFileSync(path.join(process.cwd(), "lib/connection-recoordinator.ts"), "utf8")
    const quickStartSource = fs.readFileSync(path.join(process.cwd(), "app/api/trade-engine/quick-start/route.ts"), "utf8")
    const settingsRouteSource = fs.readFileSync(path.join(process.cwd(), "app/api/settings/connections/[id]/settings/route.ts"), "utf8")

    expect(queueSource).toContain("refresh_queued_at")
    expect(queueSource).toContain("refresh_last_attempt_at")
    expect(queueSource).toContain("refresh_last_error")
    expect(queueSource).toContain("refresh_processed_at")
    expect(queueSource).toContain("await recordEngineRefreshRequestFailure(queuedRequest, drain.error)")
    expect(recoordinatorSource).toContain("queuedForOwner: !!refreshStatus?.refreshQueued && !appliedLocally")
    expect(recoordinatorSource).toContain("appliedLocally")
    expect(quickStartSource).toContain("quickstartRecoordinationApplied ? \"0\" : \"1\"")
    expect(quickStartSource).toContain("queued_for_owner")
    expect(quickStartSource).toContain("applied_locally")
    expect(settingsRouteSource).toContain("refreshQueued: recoordination.refreshQueued === true")
    expect(settingsRouteSource).toContain("refreshStatus: recoordination.refreshStatus")
  })
})

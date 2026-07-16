import {
  DEFAULT_MAIN_INDICATION_PROFILE,
  DEFAULT_PRESET_INDICATION_PROFILE,
  indicationProfilesToFlat,
  normalizeIndicationChannels,
  readStoredIndicationProfile,
} from "@/lib/active-indication-profile"
import { changedSettingKeys, settingsValuesEqual } from "@/lib/settings-diff"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("settings continuity", () => {
  test("canonical comparison ignores object order and Redis scalar encoding", () => {
    expect(settingsValuesEqual(
      { variants: { block: true, dca: false }, count: 12 },
      { count: "12", variants: { dca: "false", block: "true" } },
    )).toBe(true)
  })

  test("a full snapshot reports only effective changes", () => {
    const before = {
      symbols: ["BTCUSDT", "ETHUSDT"],
      symbol_count: 2,
      coordination_settings: { variants: { trailing: true, block: true, dca: false } },
    }
    const after = {
      symbols: ["BTCUSDT", "ETHUSDT"],
      symbol_count: "2",
      coordination_settings: { variants: { dca: true, block: true, trailing: true } },
    }
    expect(changedSettingKeys(before, after, Object.keys(after))).toEqual(["coordination_settings"])
  })

  test("normalizes complete indication channels and bounds unsafe values", () => {
    const channels = normalizeIndicationChannels({
      main: { direction: { enabled: "false", range: 9999, timeout: 0, interval: 0 } },
    })
    expect(channels.main.direction).toEqual({ enabled: false, range: 500, timeout: 1, interval: 0.1 })
    expect(channels.preset).toEqual(DEFAULT_PRESET_INDICATION_PROFILE)
  })

  test("flat indication storage round-trips booleans and numeric values", () => {
    const flat = indicationProfilesToFlat(DEFAULT_MAIN_INDICATION_PROFILE, DEFAULT_PRESET_INDICATION_PROFILE)
    expect(readStoredIndicationProfile(flat, "", DEFAULT_MAIN_INDICATION_PROFILE)).toEqual(DEFAULT_MAIN_INDICATION_PROFILE)
    expect(readStoredIndicationProfile(flat, "_preset", DEFAULT_PRESET_INDICATION_PROFILE)).toEqual(DEFAULT_PRESET_INDICATION_PROFILE)
  })

  test("global partial POST preserves unrelated settings in Redis and cache", async () => {
    jest.resetModules()
    const setAppSettings = jest.fn().mockResolvedValue(undefined)
    jest.doMock("@/lib/redis-db", () => ({
      initRedis: jest.fn().mockResolvedValue(undefined),
      getAppSettings: jest.fn().mockResolvedValue({ keepMe: 17, changed: 1 }),
      setAppSettings,
      getAllConnections: jest.fn().mockResolvedValue([]),
    }))
    jest.doMock("@/lib/engine-progression-logs", () => ({ logProgressionEvent: jest.fn() }))
    jest.doMock("@/lib/sets-compaction", () => ({ invalidateCompactionCache: jest.fn() }))
    jest.doMock("@/lib/settings-coordinator", () => ({ notifySettingsChanged: jest.fn() }))

    const { POST } = await import("../../app/api/settings/route")
    const response = await POST(new Request("http://localhost/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changed: 2 }),
    }))

    expect(response.status).toBe(200)
    expect(setAppSettings).toHaveBeenCalledWith({ keepMe: 17, changed: 2 })
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      success: true,
      settings: { keepMe: 17, changed: 2 },
    }))
  })

  test("atomic connection writer publishes the live connection gate last", async () => {
    jest.resetModules()
    const writes: string[] = []
    const redis = {
      hset: jest.fn(async (key: string) => { writes.push(`hset:${key}`); return 1 }),
    }
    const notifySettingsChanged = jest.fn()
    const before = { id: "conn-atomic", exchange: "bingx", is_live_trade: "0" }
    jest.doMock("@/lib/redis-db", () => ({
      initRedis: jest.fn().mockResolvedValue(undefined),
      updateConnection: jest.fn(async (_id: string, patch: Record<string, unknown>) => {
        writes.push("connection:commit")
        return patch
      }),
      getRedisClient: jest.fn(() => redis),
      getRedisBackend: jest.fn(() => "inline-local"),
      getConnection: jest.fn().mockResolvedValue({ ...before, is_live_trade: "1" }),
      setSettings: jest.fn(async (key: string) => { writes.push(`settings:${key}`) }),
      persistNow: jest.fn().mockResolvedValue(true),
    }))
    jest.doMock("@/lib/settings-coordinator", () => ({
      notifySettingsChanged,
      detectChangedFields: jest.fn(() => []),
    }))
    jest.doMock("@/lib/events/emitter", () => ({ emitCanonicalEvent: jest.fn() }))
    jest.doMock("@/lib/progression-scope", () => ({
      buildProgressionScope: jest.fn(() => ({
        engineType: "main",
        tradeEngineStateKey: "scope:trade-engine:conn-atomic",
      })),
    }))

    const { applyMainConnectionSettingsChange } = await import("@/lib/connection-recoordinator")
    await applyMainConnectionSettingsChange("conn-atomic", before, {
      settingsPatch: { variantBlockEnabled: "true" },
      tradeEngineStatePatch: { variantBlockEnabled: "true" },
      additionalSettingsPatches: [{
        settingsKey: "active_indications:conn-atomic",
        settingsPatch: { direction: "true" },
      }],
      connectionPatch: { is_live_trade: "1" },
      changedFieldsOverride: [],
      logTag: "test",
    })

    const commitIndex = writes.indexOf("connection:commit")
    expect(commitIndex).toBeGreaterThan(-1)
    expect(writes.slice(0, commitIndex)).toEqual(expect.arrayContaining([
      "hset:connection_settings:conn-atomic",
      "hset:settings:connection_settings:conn-atomic",
      "settings:active_indications:conn-atomic",
      "hset:trade_engine_state:conn-atomic",
      "hset:settings:trade_engine_state:conn-atomic",
      "hset:scope:trade-engine:conn-atomic",
    ]))
    expect(writes.slice(commitIndex + 1).some((entry) => entry.startsWith("hset:"))).toBe(false)
    expect(notifySettingsChanged).not.toHaveBeenCalled()
  })

  test("concurrent connection commits re-read queued state and retain sibling fields", async () => {
    jest.resetModules()
    let stored: Record<string, any> = {
      id: "conn-commit-race",
      exchange: "bingx",
      connection_settings: { coordination_settings: { variants: { block: true, dca: false } } },
    }
    let activeCommits = 0
    let maxActiveCommits = 0
    jest.doMock("@/lib/redis-db", () => ({
      initRedis: jest.fn().mockResolvedValue(undefined),
      getRedisClient: jest.fn(() => ({ hset: jest.fn().mockResolvedValue(1) })),
      getRedisBackend: jest.fn(() => "inline-local"),
      getConnection: jest.fn(async () => ({ ...stored })),
      updateConnection: jest.fn(async (_id: string, patch: Record<string, unknown>) => {
        activeCommits++
        maxActiveCommits = Math.max(maxActiveCommits, activeCommits)
        try {
          await new Promise((resolve) => setTimeout(resolve, 15))
          stored = { ...stored, ...patch }
          return { ...stored }
        } finally {
          activeCommits--
        }
      }),
      setSettings: jest.fn().mockResolvedValue(undefined),
      persistNow: jest.fn().mockResolvedValue(true),
    }))
    jest.doMock("@/lib/settings-coordinator", () => ({
      notifySettingsChanged: jest.fn(),
      detectChangedFields: jest.fn(() => []),
    }))
    jest.doMock("@/lib/events/emitter", () => ({ emitCanonicalEvent: jest.fn() }))

    const { applyMainConnectionSettingsChange } = await import("@/lib/connection-recoordinator")
    const before = { ...stored }
    await Promise.all([
      applyMainConnectionSettingsChange("conn-commit-race", before, {
        connectionPatch: {
          live_volume_factor: "0.7",
          connection_settings: { coordination_settings: { variants: { block: false } } },
        },
        changedFieldsOverride: [],
        logTag: "volume-save",
      }),
      applyMainConnectionSettingsChange("conn-commit-race", before, {
        connectionPatch: {
          is_live_trade: "1",
          connection_settings: { coordination_settings: { variants: { dca: true } } },
        },
        changedFieldsOverride: [],
        logTag: "live-save",
      }),
    ])

    expect(maxActiveCommits).toBe(1)
    expect(stored).toEqual(expect.objectContaining({
      live_volume_factor: "0.7",
      is_live_trade: "1",
    }))
    expect(stored.connection_settings.coordination_settings.variants).toEqual({
      block: false,
      dca: true,
    })
  })

  test("settings races and pseudo creation leases retain token ownership", () => {
    const recoordinator = readFileSync(join(process.cwd(), "lib/connection-recoordinator.ts"), "utf8")
    const pseudo = readFileSync(join(process.cwd(), "lib/trade-engine/pseudo-position-manager.ts"), "utf8")
    const dialog = readFileSync(join(process.cwd(), "components/settings/connection-settings-dialog.tsx"), "utf8")

    expect(recoordinator).toContain(".then(work)")
    expect(recoordinator).toContain("inFlightRecoordinations.set(connectionId, current)")
    expect(recoordinator).toContain("inFlightSettingsCommits.set(connectionId, current)")
    expect(recoordinator).toContain("connection_settings_commit_lock:")
    expect(recoordinator).toContain("PX: SETTINGS_COMMIT_LOCK_TTL_MS")
    expect(pseudo).toContain("refreshDirectionCreationLock")
    expect(pseudo).toContain("expired worker must never write after a newer creator")
    expect(dialog).toContain("symbolRequestSequenceRef")
    expect(dialog).toContain("indication_channels:  { main: indMain, preset: indPreset }")
  })
})

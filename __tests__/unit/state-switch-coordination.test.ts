import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  buildMainConnectionDisableUpdate,
  buildMainConnectionEnableUpdate,
  buildMainConnectionRemoveUpdate,
} from "@/lib/connection-state-helpers"
import { maskConnectionSecrets, preserveMaskedConnectionSecrets } from "@/lib/connection-secrets"
import { shouldReplaceEngineRefreshRequest } from "@/lib/engine-refresh-queue"

describe("state switch coordination", () => {
  test("main-state helpers return field-only patches and never copy stale settings or secrets", () => {
    const stale = {
      id: "conn-race",
      api_secret: "must-not-copy",
      live_volume_factor: "0.1",
      unrelated_setting: "stale",
    }

    for (const patch of [
      buildMainConnectionEnableUpdate(stale),
      buildMainConnectionDisableUpdate(stale),
      buildMainConnectionRemoveUpdate(stale),
    ]) {
      expect(patch).not.toHaveProperty("api_secret")
      expect(patch).not.toHaveProperty("live_volume_factor")
      expect(patch).not.toHaveProperty("unrelated_setting")
      expect(patch).toHaveProperty("updated_at")
    }
  })

  test("connection responses mask every supported credential alias and masked form values round-trip safely", () => {
    const stored = {
      api_key: "abcdefghijkl",
      api_secret: "secret-value",
      api_passphrase: "passphrase-value",
      apiKey: "camel-key-value",
      apiSecret: "camel-secret-value",
      apiPassphrase: "camel-pass-value",
      connection_settings: JSON.stringify({ api_secret: "nested-string-secret", nested: { apiKey: "nested-key" } }),
      settings: { nested: { secretKey: "another-secret" } },
      name: "BingX",
    }
    const safe = maskConnectionSecrets(stored)
    expect(safe.name).toBe("BingX")
    for (const field of ["api_key", "api_secret", "api_passphrase", "apiKey", "apiSecret", "apiPassphrase"]) {
      expect(String((safe as any)[field])).toMatch(/^••••/)
      expect((safe as any)[field]).not.toBe((stored as any)[field])
    }
    expect(JSON.parse(safe.connection_settings).api_secret).toMatch(/^••••/)
    expect(JSON.parse(safe.connection_settings).nested.apiKey).toMatch(/^••••/)
    expect(safe.settings.nested.secretKey).toMatch(/^••••/)
    expect(preserveMaskedConnectionSecrets(safe, stored)).toMatchObject({
      name: "BingX",
      connection_settings: safe.connection_settings,
      settings: safe.settings,
    })
  })

  test("runtime switch routes use the Redis generation allocator and never call the pure local increment helper", () => {
    for (const file of [
      "app/api/settings/connections/[id]/toggle-dashboard/route.ts",
      "app/api/settings/connections/[id]/live-trade/route.ts",
      "app/api/settings/connections/[id]/preset-toggle/route.ts",
      "app/api/settings/connections/[id]/active/route.ts",
      "app/api/settings/connections/[id]/enable/route.ts",
      "app/api/settings/connections/[id]/dashboard/route.ts",
      "app/api/settings/connections/add-to-active/route.ts",
    ]) {
      const source = readFileSync(join(process.cwd(), file), "utf8")
      expect(source).toContain("allocateStateSwitchVersion")
      expect(source).not.toContain("nextStateSwitchVersion(")
    }
  })

  test("base Settings toggle remains independent from Live and Preset order switches", () => {
    const source = readFileSync(join(process.cwd(), "components/settings/exchange-connection-manager.tsx"), "utf8")
    const toggleBody = source.slice(
      source.indexOf("const toggleEnabled"),
      source.indexOf("const toggleDashboard"),
    )
    expect(toggleBody).toContain("JSON.stringify({ is_enabled: enabled })")
    expect(toggleBody).not.toContain("is_live_trade:")
    expect(toggleBody).not.toContain("is_preset_trade:")
  })

  test("refresh queue ordering cannot replace a newer state action with stale reload work", () => {
    const base = {
      connectionId: "conn-refresh-race",
      reason: "test",
    }
    const current = {
      ...base,
      action: "stop",
      state_switch_version: "9",
      timestamp: "2026-07-14T12:00:02.000Z",
    }
    expect(shouldReplaceEngineRefreshRequest(current, {
      ...base,
      action: "start",
      state_switch_version: "8",
      timestamp: "2026-07-14T12:00:03.000Z",
    })).toBe(false)
    expect(shouldReplaceEngineRefreshRequest(current, {
      ...base,
      action: "refresh",
      state_switch_version: "9",
      timestamp: "2026-07-14T12:00:04.000Z",
    })).toBe(false)
    expect(shouldReplaceEngineRefreshRequest(current, {
      ...base,
      action: "start",
      state_switch_version: "10",
      timestamp: "2026-07-14T12:00:01.000Z",
    })).toBe(true)
  })

  test("Redis allocator advances above the persisted floor and remains unique", async () => {
    jest.resetModules()
    let counter = 0
    jest.doMock("@/lib/redis-db", () => ({
      getRedisClient: jest.fn(() => ({
        incr: jest.fn(async () => ++counter),
        incrby: jest.fn(async (_key: string, amount: number) => (counter += amount)),
      })),
      getSettings: jest.fn(),
      setSettings: jest.fn(),
    }))
    jest.doMock("@/lib/engine-event-bus", () => ({ publishEngineEvent: jest.fn() }))

    const { allocateStateSwitchVersion } = await import("@/lib/engine-refresh-queue")
    await expect(allocateStateSwitchVersion("conn-floor", { state_switch_version: "7" })).resolves.toBe("8")
    await expect(allocateStateSwitchVersion("conn-floor", { state_switch_version: "8" })).resolves.toBe("9")
  })

  test("shared connection writer persists only the supplied patch fields", () => {
    const source = readFileSync(join(process.cwd(), "lib/redis-db.ts"), "utf8")
    const updateBody = source.slice(
      source.indexOf("export async function updateConnection"),
      source.indexOf("export async function createPosition"),
    )
    expect(updateBody).toContain("client.hset(`connection:${id}`, connectionPatch)")
    expect(updateBody).not.toContain("client.hset(`connection:${id}`, updated)")
    expect(updateBody).toContain("await client.hgetall(`connection:${id}`)")
    expect(updateBody).toContain("proposed <= current")
    expect(updateBody).toContain("updateConnectionState")
    const refreshQueue = readFileSync(join(process.cwd(), "lib/engine-refresh-queue.ts"), "utf8")
    expect(refreshQueue).toContain("persistLatestEngineRefreshRequest")
    expect(refreshQueue).toContain("currentGeneration > proposedGeneration")
    expect(refreshQueue).toContain("currentRequestId")
    expect(refreshQueue).toContain("clearEngineRefreshRequest(request.connectionId, request)")
    expect(refreshQueue).toContain("renewRefreshClaim")
    expect(refreshQueue).toContain("PEXPIRE")
    expect(refreshQueue).toContain("options.staleAfterMs ?? ENGINE_REFRESH_REQUEST_TTL_MS")
    expect(source).toContain("options.relatedHashPatches")
    expect(source).toContain("redis.call('EXISTS', KEYS[1])")
    expect(source).toContain("options?.PX")
  })
})

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { InlineLocalRedis } from "@/lib/redis-db"
import { migrateProtectionFloorDefaults, raiseProtectionFloorDefaults } from "@/lib/protection-floor-migration"

describe("protection floor defaults 0.5 % -> 0.6 % (migration 109)", () => {
  test("only a stored previous default moves; operator values stay", () => {
    const document: Record<string, any> = {
      minStopLossPct: "0.5",
      minTrailingStopDistancePct: 0.8,
      min_stop_loss_pct: 0.5,
      unrelated: "0.5",
    }
    expect(raiseProtectionFloorDefaults(document)).toBe(true)
    expect(document).toEqual({
      minStopLossPct: "0.6",
      minTrailingStopDistancePct: 0.8,
      min_stop_loss_pct: 0.6,
      unrelated: "0.5",
    })
    expect(raiseProtectionFloorDefaults({ minStopLossPct: 0.45 })).toBe(false)
  })

  test("raises saved app, Signal and connection settings in place", async () => {
    const client = new InlineLocalRedis()
    await client.hset("settings:app_settings", { minStopLossPct: "0.5", minTrailingStopDistancePct: "0.5", leverage: "5" })
    await client.hset("settings:all_settings", { minStopLossPct: "0.7" })
    await client.set("indications:signal", JSON.stringify({ minStopLossPct: 0.5, minTrailingStopDistancePct: 1.2, enabled: true }))
    await client.hset("connection_settings:bingx-x02", { minTrailingStopDistancePct: "0.5" })

    const updated = await migrateProtectionFloorDefaults(client)

    expect(updated).toBe(3)
    expect(await client.hgetall("settings:app_settings")).toMatchObject({ minStopLossPct: "0.6", minTrailingStopDistancePct: "0.6", leverage: "5" })
    expect(await client.hget("settings:all_settings", "minStopLossPct")).toBe("0.7")
    expect(JSON.parse(String(await client.get("indications:signal")))).toEqual({ minStopLossPct: 0.6, minTrailingStopDistancePct: 1.2, enabled: true })
    expect(await client.hget("connection_settings:bingx-x02", "minTrailingStopDistancePct")).toBe("0.6")
    // Idempotent: a second pass changes nothing.
    expect(await migrateProtectionFloorDefaults(client)).toBe(0)
  })
})

describe("Settings -> Strategy writes the keys the engines read", () => {
  const source = readFileSync(join(process.cwd(), "components/settings/tabs/strategy-tab.tsx"), "utf8")

  test("the Main Block and DCA switches drive variantBlockEnabled / variantDcaEnabled", () => {
    expect(source).toContain('handleSettingChange("variantBlockEnabled", checked)')
    expect(source).toContain('handleSettingChange("variantDcaEnabled", checked)')
    // DCA shows off unless enabled, exactly like the engine default.
    expect(source).toContain("parseStoredBoolean(settings.variantDcaEnabled ?? settings.dcaAdjustment, false)")
  })

  test("Preset Block controls never write the Main engine's runtime keys", () => {
    expect(source).not.toMatch(/updatePresetBlockSetting\("preset[A-Za-z]+", "[A-Za-z]+"/)
    expect(source).not.toContain('updatePresetBlockSetting("presetBlockEnabled", "variantBlockEnabled"')
  })

  test("protection floors and the exchange-result switch-over are editable", () => {
    expect(source).toContain('"minStopLossPct"')
    expect(source).toContain('"minTrailingStopDistancePct"')
    expect(source).toContain('handleSettingChange("liveOutcomeMinCloses", count)')
  })
})

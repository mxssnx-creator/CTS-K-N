import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runAsOperatorVolumeEdit, isOperatorVolumeEdit, withoutImplicitVolumeReset } from "@/lib/connection-volume-guard"

describe("an operator's channel volume factor is only lowered to the minimum by the volume control", () => {
  const stored = { live_volume_factor: "10", volume_factor_live: "10", preset_volume_factor: "2", signal_volume_factor: "0.1" }
  test("a write of the 0.1 minimum over a higher stored factor is dropped, with a record of what was blocked", () => {
    const r = withoutImplicitVolumeReset(stored, { live_volume_factor: "0.1", active_symbols: "[\"A\"]" })
    expect(r.patch).toEqual({ active_symbols: "[\"A\"]" })
    expect(r.blocked).toEqual([{ field: "live_volume_factor", stored: "10", attempted: "0.1" }])
  })
  test("numbers and every alias are covered", () => {
    const r = withoutImplicitVolumeReset(stored, { volume_factor_live: 0.1, preset_volume_factor: 0.1 })
    expect(r.patch).toEqual({})
    expect(r.blocked.map((b) => b.field).sort()).toEqual(["preset_volume_factor", "volume_factor_live"])
  })
  test("raising, keeping, and setting a factor that was at the minimum are untouched", () => {
    expect(withoutImplicitVolumeReset(stored, { live_volume_factor: "10" }).blocked).toEqual([])
    expect(withoutImplicitVolumeReset(stored, { live_volume_factor: "12" }).blocked).toEqual([])
    expect(withoutImplicitVolumeReset(stored, { signal_volume_factor: "0.1" }).blocked).toEqual([])
    expect(withoutImplicitVolumeReset({}, { live_volume_factor: "0.1" }).blocked).toEqual([])
    expect(withoutImplicitVolumeReset(null, { live_volume_factor: "0.1" }).blocked).toEqual([])
  })
  test("a lowering to something above the minimum is the operator's choice and passes", () => {
    expect(withoutImplicitVolumeReset(stored, { live_volume_factor: "3" }).blocked).toEqual([])
  })
  test("inside the operator volume edit the minimum is allowed, outside it is not", async () => {
    expect(isOperatorVolumeEdit()).toBe(false)
    await runAsOperatorVolumeEdit(async () => {
      expect(isOperatorVolumeEdit()).toBe(true)
      await new Promise((r) => setTimeout(r, 5))
      expect(withoutImplicitVolumeReset(stored, { live_volume_factor: "0.1" }).blocked).toEqual([])
    })
    expect(isOperatorVolumeEdit()).toBe(false)
    expect(withoutImplicitVolumeReset(stored, { live_volume_factor: "0.1" }).blocked).toHaveLength(1)
  })
  test("both connection write functions apply the guard and only the volume route is exempt", () => {
    const db = readFileSync(resolve(process.cwd(), "lib/redis-db.ts"), "utf8")
    expect(db).toContain('recordVolumeResetBlocked(client, id, "updateConnection", guarded.blocked)')
    expect(db).toContain('recordVolumeResetBlocked(client, id, "updateConnectionState", guarded.blocked)')
    const volume = readFileSync(resolve(process.cwd(), "app/api/settings/connections/[id]/volume/route.ts"), "utf8")
    expect(volume).toContain("runAsOperatorVolumeEdit(() => applyMainConnectionSettingsChange(")
  })
})

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { __liveStageTest } from "@/lib/trade-engine/stages/live-stage"

const { isHandoffInProgressOnly, isEntrySlotProtectionHalted } = __liveStageTest as any

describe("a hand-off in progress is a short slot hold, not a 24 h halt (X02: 20 slots closed for a day)", () => {
  test("the X02 pictures are hand-offs in progress", () => {
    expect(isHandoffInProgressOnly(["owned_quantity_mutation_pending", "owned_shared_stopLoss_missing", "owned_shared_stopLoss_quantity_mismatch"])).toBe(true)
    expect(isHandoffInProgressOnly(["owned_quantity_mutation_pending", "owned_slot_security_stop_incomplete", "owned_slot_security_quantity_mismatch"])).toBe(true)
    expect(isHandoffInProgressOnly(["owned_entry_confirmation_pending", "owned_control_scope_transition_pending", "owned_slot_controls_incomplete"])).toBe(true)
  })
  test("without a pending marker, or with anything outside a hand-off, it stays genuine", () => {
    expect(isHandoffInProgressOnly(["owned_shared_stopLoss_missing"])).toBe(false)
    expect(isHandoffInProgressOnly(["owned_quantity_mutation_pending", "owned_slot_orphan_controls_present"])).toBe(false)
    expect(isHandoffInProgressOnly(["owned_quantity_mutation_pending", "owned_slot_security_quantity_mismatch", "venue_quantity_exceeds_system"])).toBe(false)
    expect(isHandoffInProgressOnly([])).toBe(false)
    expect(isHandoffInProgressOnly(undefined)).toBe(false)
  })
  const fakeRedis = (value: string | null) => {
    const store = new Map<string, string>()
    return {
      store,
      get: async (k: string) => (store.has(k) ? store.get(k)! : value),
      del: async (k: string) => { store.delete(k); value = null; return 1 },
    }
  }
  test("an existing hand-off-only halt older than the short hold heals; a fresh one and a genuine one hold", async () => {
    const old = JSON.stringify({ at: Date.now() - 10 * 60_000, violations: ["owned_quantity_mutation_pending", "owned_shared_stopLoss_missing"] })
    const fresh = JSON.stringify({ at: Date.now() - 10_000, violations: ["owned_quantity_mutation_pending", "owned_shared_stopLoss_missing"] })
    const genuine = JSON.stringify({ at: Date.now() - 10 * 60_000, violations: ["owned_slot_orphan_controls_present"] })
    expect(await isEntrySlotProtectionHalted(fakeRedis(old), "c", "SOLUSDT", "short")).toBe(false)
    expect(await isEntrySlotProtectionHalted(fakeRedis(fresh), "c", "SOLUSDT", "short")).toBe(true)
    expect(await isEntrySlotProtectionHalted(fakeRedis(genuine), "c", "SOLUSDT", "short")).toBe(true)
    expect(await isEntrySlotProtectionHalted(fakeRedis("not json"), "c", "SOLUSDT", "short")).toBe(true)
    expect(await isEntrySlotProtectionHalted(fakeRedis(null), "c", "SOLUSDT", "short")).toBe(false)
  })
  test("the halt wrapper keeps hand-offs slot-scoped with the short TTL (no connection halt)", () => {
    const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
    expect(src).toContain("const slotHaltTtlSeconds = handoffOnly ? TRANSIENT_ENTRY_HALT_TTL_SECONDS : GENUINE_ENTRY_HALT_TTL_SECONDS")
    expect(src).toContain("transient: handoffOnly")
    expect(src).toMatch(/const transientOnly = decision\.violations\.length > 0\n\s+&& decision\.violations\.every\(\(violation\) => TRANSIENT_PROTECTION_VIOLATIONS\.has\(violation\)\)\n/)
  })
})

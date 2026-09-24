import { readFileSync } from "node:fs"
import { resolve } from "node:path"
const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
describe("one entry at a time per physical slot", () => {
  test("the lock is taken before the entry is prepared and a second entry is deferred", () => {
    const lock = src.indexOf("const slotEntryLocked = await slotEntryClient.set(slotEntryLockKey, slotEntryLockToken, { NX: true, PX: 60_000 })")
    const prepared = src.indexOf('livePosition.submissionState = "prepared"', lock)
    expect(lock).toBeGreaterThan(0)
    expect(prepared).toBeGreaterThan(lock)
    expect(src).toContain('pushStep(livePosition, "slot_entry_serialized", false, livePosition.statusReason)')
  })
  test("the lock is released after the post-entry audit, on rollback and on success, only by its holder", () => {
    expect(src).toContain("if (holder === slotEntryLockToken) await slotEntryClient.del(slotEntryLockKey)")
    expect((src.match(/await releaseSlotEntryLock\(\)/g) || []).length).toBeGreaterThanOrEqual(2)
  })
})
describe("capacity reservations are released on every exit path", () => {
  test("saving a row that is no longer active removes it from the capacity index", () => {
    const fn = src.slice(src.indexOf("async function savePosition("), src.indexOf("async function savePosition(") + 1500)
    expect(fn).toContain("if (position?.id && !isActiveSignalPosition(position as unknown as Record<string, unknown>)) {")
    expect(fn).toContain("await updateSignalAdmissionIndexes(client, position)")
  })
})

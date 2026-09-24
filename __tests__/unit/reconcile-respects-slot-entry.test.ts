import { readFileSync } from "node:fs"
import { resolve } from "node:path"
const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
describe("no reconciler arms protection on a slot whose entry is still running", () => {
  test("a slot with a held entry lock is skipped unless the caller holds that lock", () => {
    const fn = src.slice(src.indexOf("async function reconcileAggregateProtectionBook("))
    expect(fn).toContain(".get(`live:slot-entry:${connectionId}:${normalizeProtectionSlotSymbol(slotSymbol)}:${slotDirection}`)")
    expect(fn).toContain("if (holder && holder !== options.entryLockToken) {")
  })
  test("the lock key matches the one the entry takes", () => {
    expect(src).toContain("const slotEntryLockKey = `live:slot-entry:${connectionId}:${normalizeProtectionSlotSymbol(realPosition.symbol)}:${realPosition.direction}`")
  })
  test("the entry's own initial security reconcile passes its token", () => {
    expect(src).toContain("{ entryLockToken: slotEntryLockToken },")
  })
})

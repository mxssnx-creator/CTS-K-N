import { readFileSync } from "node:fs"
import { resolve } from "node:path"
const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
describe("an entry that ends before any venue order releases its lane lock", () => {
  const save = src.slice(src.indexOf("async function savePosition("), src.indexOf("async function savePosition(") + 4000)
  test("savePosition releases the lock for rejected / blocked / error / cancelled rows that never placed", () => {
    expect(save).toContain('["rejected", "error", "blocked", "cancelled", "canceled"].includes(endedStatus)')
    expect(save).toContain('const neverPlaced = !String(position?.orderId || "").trim() && !(Number(position?.executedQuantity || 0) > 0)')
    expect(save).toContain("await releaseLock(String(position.connectionId || \"\"), String(position.symbol || \"\"), liveLockDirection(position as any), token)")
  })
  test("the release is token-verified, so another worker's lock is never freed", () => {
    const rel = src.slice(src.indexOf("async function releaseLock("), src.indexOf("async function releaseLock(") + 700)
    expect(rel).toContain("evalLockLua(client, RELEASE_LOCK_LUA, key, [token])")
  })

  test("the release runs before a transient row is discarded, so unpersisted exits release too", () => {
    const save = src.slice(src.indexOf("async function savePosition("), src.indexOf("async function savePosition(") + 5000)
    const release = save.indexOf("await releaseLock(")
    const discard = save.indexOf("await discardTransientLivePosition(client, position)")
    expect(release).toBeGreaterThan(0)
    expect(release).toBeLessThan(discard)
  })

  test("the capacity release also runs before a transient row is discarded", () => {
    const save = src.slice(src.indexOf("async function savePosition("), src.indexOf("async function savePosition(") + 6000)
    expect(save.indexOf("await updateSignalAdmissionIndexes(client, position)")).toBeLessThan(save.indexOf("await discardTransientLivePosition(client, position)"))
  })
})

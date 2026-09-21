import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
const fn = src.slice(src.indexOf("async function pruneDanglingLiveIndexEntries("))

describe("an open-index entry without its row hash is removed", () => {
  test("only a definite absence prunes — a failed read never does", () => {
    // exists() failing defaults to 1, so the entry is kept.
    expect(fn).toContain(".catch(() => 1)")
    expect(fn).toContain("if (Number(exists) !== 0) continue")
  })

  test("nothing on the venue is touched — the repair is local", () => {
    const body = fn.slice(0, fn.indexOf("async function collectSweepableLivePositions("))
    for (const call of ["placeOrder", "cancelOrder", "closePosition", "getPositions"]) {
      expect([call, body.includes(call)]).toEqual([call, false])
    }
    expect(body).toContain("client.lrem(indexKey, 0, rawId)")
  })

  test("it runs before the index is read, so the read is already clean", () => {
    const collect = src.slice(src.indexOf("async function collectSweepableLivePositions("))
    const prune = collect.indexOf("await pruneDanglingLiveIndexEntries(connectionId)")
    const read = collect.indexOf("const indexed = await getLivePositions(connectionId)")
    expect(prune).toBeGreaterThanOrEqual(0)
    expect(prune).toBeLessThan(read)
  })

  test("a missing Redis capability is a no-op, not a crash", () => {
    expect(fn).toContain('typeof client?.lrange !== "function" || typeof client?.lrem !== "function"')
  })

  test("the repair is reported when it does something, and silent otherwise", () => {
    expect(fn).toContain("if (pruned > 0) {")
    expect(fn).toContain("whose row hash no longer exists")
  })
})

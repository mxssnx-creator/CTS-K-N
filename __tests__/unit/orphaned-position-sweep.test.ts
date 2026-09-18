import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { isStuckPreFillPlacement } from "@/lib/trade-engine/stages/live-stage"

const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")

describe("rows outside the open index can still be cleaned up", () => {
  test("the sweep enumerates orphans, not just the index", () => {
    expect(src).toContain("const rows = await collectSweepableLivePositions(connectionId)")
    const fn = src.slice(src.indexOf("async function collectSweepableLivePositions("))
    expect(fn).toContain("const indexed = await getLivePositions(connectionId)")
    expect(fn).toContain("typeof client.scan !== \"function\"")
    expect(fn).toContain("if (!id || seen.has(id)) continue")
  })

  test("only non-terminal orphans are swept; closed history is left alone", () => {
    const fn = src.slice(src.indexOf("async function collectSweepableLivePositions("))
    expect(fn).toContain("isActiveLiveSlotStatus(String(row.status || \"\"))")
  })

  test("an unscannable store still runs the indexed sweep", () => {
    const fn = src.slice(src.indexOf("async function collectSweepableLivePositions("))
    const catchBlock = fn.slice(fn.indexOf("} catch {"))
    expect(catchBlock).toContain("return indexed")
    expect(fn).toContain("guard < 200")
  })

  test("the production zombie shape is recognised as stuck", () => {
    // status pending, quantity 0, no venue handle, 10.7 days old.
    const tenDaysAgo = Date.now() - 10.7 * 24 * 60 * 60 * 1000
    expect(isStuckPreFillPlacement({
      status: "pending", executedQuantity: 0, orderId: undefined,
      exchangeData: undefined, createdAt: tenDaysAgo, updatedAt: tenDaysAgo + 2,
      pendingSystemAction: undefined,
    } as any)).toBe(true)
  })

  test("a row with a venue handle or a fill is never swept", () => {
    const old = Date.now() - 10 * 24 * 60 * 60 * 1000
    expect(isStuckPreFillPlacement({ status: "pending", executedQuantity: 1, createdAt: old } as any)).toBe(false)
    expect(isStuckPreFillPlacement({ status: "pending", executedQuantity: 0, orderId: "abc", createdAt: old } as any)).toBe(false)
    expect(isStuckPreFillPlacement({ status: "open", executedQuantity: 0, createdAt: old } as any)).toBe(false)
    expect(isStuckPreFillPlacement({
      status: "pending", executedQuantity: 0, createdAt: old, pendingSystemAction: "close",
    } as any)).toBe(false)
  })
})

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
const live = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
const cron = readFileSync(resolve(process.cwd(), "app/api/cron/close-accounting/route.ts"), "utf8")

describe("a row is reconciled to its own share of the slot, never to its siblings' fills", () => {
  test("the authoritative slot quantity is reduced by the other own rows on the slot", () => {
    expect(live).toContain("const slotShare = Math.max(0, slotExchangeQuantity - await ownSiblingSlotQuantity(position))")
  })
  test("siblings are only this connection's own active rows on the same physical slot", () => {
    const fn = live.slice(live.indexOf("async function ownSiblingSlotQuantity("), live.indexOf("async function ownSiblingSlotQuantity(") + 1400)
    expect(fn).toContain("if (!isExactSystemPositionOwner(row as any, connectionId)) continue")
    expect(fn).toContain("aggregateProtectionSlot(row.symbol, rowDirection) !== slot")
    expect(fn).toContain('if (String(row.id) === String(position.id)) continue')
  })
  test("the production case: 0.76 on the venue with siblings 0.02 + 0.01 gives the row 0.73, not 0.76", () => {
    const share = (slot: number, siblings: number[]) => Math.max(0, slot - siblings.reduce((a, b) => a + b, 0))
    expect(share(0.76, [0.02, 0.01])).toBeCloseTo(0.73, 10)
    expect(share(0.76, [])).toBeCloseTo(0.76, 10)
  })
})

describe("deferred accounting reaches every row", () => {
  test("each run resumes where the previous run stopped and wraps around", () => {
    expect(cron).toContain("const cursorKey = `close-accounting:cursor:${connectionId}`")
    expect(cron).toContain("const keys = [...allKeys.slice(startAt), ...allKeys.slice(0, startAt)]")
    expect(cron).toContain("const nextCursor = allKeys.length > 0 ? (startAt + visited) % allKeys.length : 0")
  })
})

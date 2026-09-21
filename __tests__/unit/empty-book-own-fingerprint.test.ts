import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
const fp = src.slice(src.indexOf("function emptyBookProtectionFingerprint("), src.indexOf("async function reconcileEmptyBookProtectionHalt("))

describe("the empty-book proof fingerprints only OUR state", () => {
  test("foreign venue positions no longer enter the fingerprint", () => {
    // Another system's churn changed the hash every tick, so two identical
    // observations never occurred and the halt could not retire.
    expect(fp).toContain("_venuePositions")
    expect(fp).not.toContain("venuePositionQuantityForEmptyBook(row)")
  })

  test("only CTS-owned order ids are hashed, by client-order-id prefix", () => {
    expect(fp).toContain("isConnectionOwnedClientOrderId(clientOrderId, connectionId)")
    expect(fp).toContain("ownOrderIds")
    expect(fp).not.toContain("orderIds: [...liveOrderIds]")
  })

  test("every blocking condition is named, and logged once per change", () => {
    for (const name of ["local_open_rows=", "open_orders_unreadable", "venue_positions_unreadable", "venue_book_not_flat", "own_open_orders="]) {
      expect([name, src.includes(name)]).toEqual([name, true])
    }
    expect(src).toContain("if (lastEmptyBookBlocker.get(connectionId) === signature) return")
  })

  test("an unreadable venue still blocks — the proof never fails open", () => {
    const cond = src.slice(src.indexOf("function emptyBookFailingConditions("))
    expect(cond).toContain('if (!state.liveOrderIdsReadable) failing.push("open_orders_unreadable")')
    expect(cond).toContain('if (!state.venuePositionsReadable) failing.push("venue_positions_unreadable")')
  })
})

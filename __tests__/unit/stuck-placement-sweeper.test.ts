import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { isStuckPreFillPlacement } from "@/lib/trade-engine/stages/live-stage"

const NOW = 1_800_000_000_000
const TEN_MIN = 10 * 60_000
const zombie = { status: "pending", executedQuantity: 0, orderId: undefined, exchangeData: { markPrice: 1.5, syncedAt: NOW }, createdAt: NOW - 9 * 60 * 60_000, updatedAt: NOW, pendingSystemAction: undefined } as any

describe("stuck pre-fill placement sweeper", () => {
  test("a pending row with no fill, no venue handle and old createdAt is stuck even if the sync keeps updating it", () => {
    expect(isStuckPreFillPlacement(zombie, NOW, TEN_MIN)).toBe(true)
    for (const status of ["placed", "pending_fill", "placed_unconfirmed"]) {
      expect(isStuckPreFillPlacement({ ...zombie, status }, NOW, TEN_MIN)).toBe(true)
    }
  })

  test("rows that are young, filled, handled, in-flight or in another status are not stuck", () => {
    expect(isStuckPreFillPlacement({ ...zombie, createdAt: NOW - 5 * 60_000 }, NOW, TEN_MIN)).toBe(false)
    expect(isStuckPreFillPlacement({ ...zombie, executedQuantity: 3.27 }, NOW, TEN_MIN)).toBe(false)
    expect(isStuckPreFillPlacement({ ...zombie, orderId: "2099930939179143168" }, NOW, TEN_MIN)).toBe(false)
    expect(isStuckPreFillPlacement({ ...zombie, exchangeData: { positionId: "2099691117889982466" } }, NOW, TEN_MIN)).toBe(false)
    expect(isStuckPreFillPlacement({ ...zombie, pendingSystemAction: { reason: "sys-close" } }, NOW, TEN_MIN)).toBe(false)
    expect(isStuckPreFillPlacement({ ...zombie, status: "open" }, NOW, TEN_MIN)).toBe(false)
    expect(isStuckPreFillPlacement({ ...zombie, createdAt: 0 }, NOW, TEN_MIN)).toBe(false)
  })

  test("the sweeper runs in periodic reconciliation without a connector and finalizes locally", () => {
    const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
    const sim = src.indexOf("const simResult = await processSimulatedPositions(connectionId)")
    const hook = src.indexOf("const stuck = await sweepStuckPreFillPlacements(connectionId)")
    expect(sim).toBeGreaterThan(0)
    expect(hook).toBeGreaterThan(sim)
    expect(src).toContain('closeLivePosition(connectionId, position.id, exitPrice, null, "placement_stuck_no_venue_handle")')
    // closeLivePosition finalizes pre-fill rows locally only when no connector is passed.
    expect(src).toContain("const mayFinalizeClose = exchangeCloseSuccess || (!exchangeConnector && localOnlyCloseAllowed)")
  })
})

describe("closing a pending pre-fill row without a venue handle", () => {
  test("closeLivePosition admits `pending` into the closing transition only for pre-fill rows without a venue handle", () => {
    const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
    const fn = src.slice(src.indexOf("export async function closeLivePosition("))
    expect(fn).toContain("const pendingPreFillWithoutHandle =")
    expect(fn).toContain('isPreFillWithoutExchangeHandle(position, position.status, hasSystemVenueHandle(position))')
    expect(fn).toContain('...(pendingPreFillWithoutHandle ? ["pending"] : [])')
    expect(fn).toContain("mutatePositionWithVersionCheck(position, closingTransitionFrom, draft => {")
    // The base list still excludes pending: an in-flight submission is never closed from outside.
    expect(fn).toMatch(/"open", "filled", "partially_filled", "placed", "pending_fill", "placed_unconfirmed", "simulated", "closing", "closing_partial",\n\s+\.\.\.\(pendingPreFillWithoutHandle/)
  })

  test("the sweeper also runs from the realtime processor, which owns the sync of engine-active connections", () => {
    const rt = readFileSync(resolve(process.cwd(), "lib/trade-engine/realtime-processor.ts"), "utf8")
    expect(rt).toContain("await sweepStuckPreFillPlacements(this.connectionId).catch(() => undefined)")
  })
})

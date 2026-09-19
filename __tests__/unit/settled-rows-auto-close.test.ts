import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
const fn = src.slice(src.indexOf("async function closeRowsSettledOnVenue("))
const body = fn.slice(0, fn.indexOf("async function pruneDanglingLiveIndexEntries("))

describe("a row settled by its own protection is closed, not treated as unprotected", () => {
  test("only rows that actually reached the venue are candidates", () => {
    expect(body).toContain('if (status !== "filled" && status !== "open") return false')
    expect(body).toContain("Number(row?.executedQuantity || 0) <= 0")
    expect(body).toContain("Boolean(hasSystemVenueHandle(row))")
  })

  test("an unreadable venue snapshot closes nothing", () => {
    expect(body).toContain("if (!Array.isArray(venue) || !Array.isArray(orders)) return 0")
  })

  test("a position still on the venue is never closed", () => {
    expect(body).toContain("if (stillOnVenue) continue")
  })

  test("an own open order on the symbol keeps the row open; foreign orders do not", () => {
    expect(body).toContain("isConnectionOwnedProtectionOrderForSlot(order, connectionId,")
    expect(body).toContain("if (ownOrderOpen) continue")
  })

  test("the row is re-read before mutation, so a concurrent close is not overwritten", () => {
    const reread = body.indexOf("await readLivePositionSnapshot(")
    const mutate = body.indexOf('current.status = "closed"')
    expect(reread).toBeGreaterThan(0)
    expect(reread).toBeLessThan(mutate)
    expect(body).toContain("if (!current || !isActiveLiveSlotStatus(String(current.status || \"\"))) continue")
  })

  test("it runs inside reconcile before the sweep and the halt logic", () => {
    const reconcile = src.slice(src.indexOf("export async function reconcileLivePositions("))
    const settle = reconcile.indexOf("await closeRowsSettledOnVenue(connectionId, exchangeConnector)")
    const sweep = reconcile.indexOf("await sweepStuckPreFillPlacements(connectionId)")
    expect(settle).toBeGreaterThanOrEqual(0)
    expect(settle).toBeLessThan(sweep)
  })

  test("the closure states its reason and is logged only when it acted", () => {
    expect(body).toContain("settled_by_protection:")
    expect(body).toContain("if (closed > 0) {")
  })
})

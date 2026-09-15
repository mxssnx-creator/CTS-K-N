import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { hasSystemVenueHandle } from "@/lib/trade-engine/stages/live-stage"

describe("adopted live rows are closable by the system close path", () => {
  test("a venue position id recorded at adoption counts as a system venue handle", () => {
    expect(hasSystemVenueHandle({ orderId: undefined, exchangeData: { positionId: "2099691117889982466" } } as any)).toBe(true)
    expect(hasSystemVenueHandle({ orderId: undefined, exchangeData: { exchangePositionId: "x" } } as any)).toBe(true)
    expect(hasSystemVenueHandle({ orderId: "2099691117864816640", exchangeData: {} } as any)).toBe(true)
  })

  test("a reserved local slot without any venue handle is still not closable on the venue", () => {
    expect(hasSystemVenueHandle({ orderId: undefined, exchangeData: {} } as any)).toBe(false)
    expect(hasSystemVenueHandle({ orderId: "", exchangeData: undefined } as any)).toBe(false)
  })

  test("closeLivePosition decides on the helper and backs off an unconfirmed close instead of looping every cycle", () => {
    const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
    expect(src).toContain("const hasSystemOrderId = hasSystemVenueHandle(position)")
    expect(src).not.toContain("const hasSystemOrderId = !!(position.orderId || position.exchangeData?.exchangePositionId)")
    const unconfirmed = src.indexOf("if (!mayFinalizeClose) {")
    const backoff = src.indexOf("scheduleSystemCloseRetry(position, exchangeCloseReason === \"skipped\" ? \"invalid_response\" : lastErrorMsgForBackoff)")
    const keptOpen = src.indexOf("close_failed_exchange_unconfirmed: ${closeReason}; position kept open;")
    expect(unconfirmed).toBeGreaterThan(0)
    expect(backoff).toBeGreaterThan(unconfirmed)
    expect(keptOpen).toBeGreaterThan(backoff)
  })
})

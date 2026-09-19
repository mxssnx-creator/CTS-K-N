import { auditLiveEntryProtectionAdmission } from "@/lib/live-entry-protection-admission"
import { connectionTrackingId, systemTrackingPrefix } from "@/lib/system-order-ownership"

const CONN = "bingx-x02"
const base = {
  connectionId: CONN, symbol: "BTCUSDT", direction: "long" as const,
  venuePositions: [] as any[], openOrders: [] as any[],
  protectionPolicy: { requireSecurityStop: true } as any,
}
const ownRow = (extra: Record<string, any>) => ({
  id: "live:bingx-x02:BTCUSDT:long:x", connectionId: CONN, symbol: "BTCUSDT", direction: "long",
  status: "pending", executedQuantity: 0, clientOrderId: "ctsbingxx02-entry-1",
  // Exact system ownership, as production rows carry it.
  system_tracking_id: `${systemTrackingPrefix(CONN)}abc123`,
  connection_tracking_id: connectionTrackingId(CONN),
  ...extra,
})

describe("a row that never reached the venue is not exposure", () => {
  test("pending, no order id, no fill -> no owned violations, admission not halted by it", () => {
    const out = auditLiveEntryProtectionAdmission({ ...base, positions: [ownRow({})] } as any)
    expect(out.violations.filter((v: string) => v.startsWith("owned_"))).toEqual([])
  })

  // A filled own row with nothing protecting it on the venue MUST still be
  // flagged — the exclusion applies only to rows that never reached the venue.
  test("a fill without protection is still owned exposure and is still flagged", () => {
    const out = auditLiveEntryProtectionAdmission({
      ...base,
      positions: [ownRow({ status: "open", executedQuantity: 0.5, orderId: "2101" })],
      venuePositions: [{ symbol: "BTCUSDT", positionSide: "LONG", positionAmt: "0.5",
        system_tracking_id: `${systemTrackingPrefix(CONN)}abc123`, connection_tracking_id: connectionTrackingId(CONN), connectionId: CONN }],
    } as any)
    expect(out.violations.some((v: string) => v.startsWith("owned_"))).toBe(true)
  })

  test("the exclusion keys on the absence of ANY venue handle, in every spelling", () => {
    const src = require("node:fs").readFileSync(require("node:path").resolve(process.cwd(), "lib/live-entry-protection-admission.ts"), "utf8")
    const fn = src.slice(src.indexOf("const neverReachedVenue ="))
    expect(fn).toContain("quantityOf(row) <= 0")
    expect(fn).toContain("!text(row.orderId)")
    expect(fn).toContain("!text(row.exchangeOrderId)")
    expect(fn).toContain("!text(row.exchangeData?.orderId)")
  })
})

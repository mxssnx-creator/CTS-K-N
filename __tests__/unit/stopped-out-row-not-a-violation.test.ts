import { auditLiveEntryProtectionAdmission } from "@/lib/live-entry-protection-admission"
import { connectionTrackingId, systemTrackingPrefix } from "@/lib/system-order-ownership"

const base = (over: Record<string, any> = {}) => ({
  id: "r1", connectionId: "bingx-x01",
  system_tracking_id: `${systemTrackingPrefix("bingx-x01")}r1`,
  connection_tracking_id: connectionTrackingId("bingx-x01"),
  symbol: "TAKEUSDT", direction: "short", status: "open", executedQuantity: 36.22,
  stopLossOrderId: "SL1", takeProfitOrderId: "TP1", orderId: "E1", ...over,
})
const run = (rows: any[], liveOrderIds: string[], venuePositions: any[] = []) =>
  auditLiveEntryProtectionAdmission({
    connectionId: "bingx-x01", symbol: "TAKEUSDT", direction: "short", candidateId: "new",
    positions: rows as any, venuePositions: venuePositions as any, liveOrderIds: new Set(liveOrderIds),
  } as any)

describe("a row closed by its own stop or take profit is not 'missing protection'", () => {
  test("the production case: own SL filled, venue holds nothing -> no row violation", () => {
    const v = run([base()], ["TP1"], []).violations
    expect(v).not.toContain("owned_row_stop_loss_missing")
    expect(v).not.toContain("owned_row_take_profit_missing")
  })
  test("a row the venue still holds is still checked", () => {
    const v = run([base()], ["TP1"], [{ symbol: "TAKEUSDT", positionSide: "SHORT", positionAmt: "-36.22" }]).violations
    expect(v).toContain("owned_row_stop_loss_missing")
  })
  test("a row with both controls open is never affected", () => {
    const v = run([base()], ["SL1", "TP1"], [{ symbol: "TAKEUSDT", positionSide: "SHORT", positionAmt: "-36.22" }]).violations
    expect(v).not.toContain("owned_row_stop_loss_missing")
    expect(v).not.toContain("owned_row_take_profit_missing")
  })
})

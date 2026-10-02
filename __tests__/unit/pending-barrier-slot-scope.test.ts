import { auditLiveEntryProtectionAdmission } from "@/lib/live-entry-protection-admission"
import { aggregateProtectionSlot } from "@/lib/aggregate-protection-coordination"

const CONN = "bingx-x02"
// the owned-row shape of live-entry-protection-admission.test.ts (system / connection tracking ids make it ours)
const row = (over: Record<string, any> = {}) => ({
  id: "btc-1", connectionId: CONN,
  system_tracking_id: `sys-${CONN}-${over.id || "btc-1"}`, connection_tracking_id: `conn-${CONN}`,
  status: "open", symbol: "BTCUSDT", direction: "long", executedQuantity: 0.001, quantityStep: 0.001,
  stopLossOrderId: "sl-a", takeProfitOrderId: "tp-a", securityStopOrderId: "sec-slot",
  stopLossArmedQuantity: 0.001, takeProfitArmedQuantity: 0.001, securityStopArmedQuantity: 0.001,
  aggregateProtectionMutationRequestedAt: Date.now() - 60_000,
  ...over,
})
const audit = (symbol: string, direction: "long" | "short", positions: any[]) => auditLiveEntryProtectionAdmission({
  connectionId: CONN, symbol, direction, positions, venuePositions: [{ symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.001" }],
  liveOrderIds: new Set<string>(), } as any) as any

describe("pending barriers belong to their slot, not to the connection", () => {
  test("an accumulation in flight on BTC long is attributed to that slot", () => {
    const a = audit("NEARUSDT", "short", [row()])
    expect(a.violations).toContain("owned_quantity_mutation_pending")
    expect(a.offendingSlots).toContain(aggregateProtectionSlot("BTCUSDT", "long"))
    expect(a.offendingSlots).not.toContain(aggregateProtectionSlot("NEARUSDT", "short"))
    expect(a.connectionLevelViolation).toBe(false)
  })
  test("a candidate on the same slot still sees its own slot offending", () => {
    const a = audit("BTCUSDT", "long", [row()])
    expect(a.offendingSlots).toContain(aggregateProtectionSlot("BTCUSDT", "long"))
  })
  test("pending entry confirmations and closes are attributed the same way", () => {
    const a = audit("NEARUSDT", "short", [
      row({ id: "e", symbol: "ETHUSDT", status: "pending", aggregateProtectionMutationRequestedAt: 0 }),
      row({ id: "c", symbol: "SOLUSDT", direction: "short", status: "closing", aggregateProtectionMutationRequestedAt: 0 }),
    ])
    expect(a.offendingSlots).toEqual(expect.arrayContaining([aggregateProtectionSlot("SOLUSDT", "short")]))
    expect(a.offendingSlots).not.toContain(aggregateProtectionSlot("NEARUSDT", "short"))
  })
  test("the row driving its own mutation is no barrier to itself", () => {
    const a = auditLiveEntryProtectionAdmission({
      connectionId: CONN, symbol: "BTCUSDT", direction: "long", positions: [row()], venuePositions: [],
      liveOrderIds: new Set<string>(["sl-a", "tp-a", "sec-slot"]), mutatingRowId: "btc-1",
    } as any) as any
    expect(a.violations).not.toContain("owned_quantity_mutation_pending")
  })
})

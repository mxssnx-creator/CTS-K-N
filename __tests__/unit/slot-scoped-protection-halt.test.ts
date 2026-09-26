import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { auditLiveEntryProtectionAdmission } from "@/lib/live-entry-protection-admission"
import { connectionTrackingId, systemTrackingPrefix } from "@/lib/system-order-ownership"

const own = (id: string, extra: Record<string, any>) => ({
  id, connectionId: "c1", system_tracking_id: `${systemTrackingPrefix("c1")}${id}`,
  connection_tracking_id: connectionTrackingId("c1"), status: "open", orderId: `E${id}`, ...extra,
})
const audit = (rows: any[], venue: any[], live: string[], symbol = "BTCUSDT") =>
  auditLiveEntryProtectionAdmission({ connectionId: "c1", symbol, direction: "long", candidateId: "new",
    positions: rows as any, venuePositions: venue as any, liveOrderIds: new Set(live) } as any) as any

describe("a protection violation is attributed to the slot that caused it", () => {
  const wld = own("w", { symbol: "WLDUSDT", direction: "long", executedQuantity: 10, stopLossOrderId: "S1", takeProfitOrderId: "T1" })
  test("an unprotected WLD row blames WLD, not the BTC entry being admitted", () => {
    const r = audit([wld], [{ symbol: "WLDUSDT", positionSide: "LONG", positionAmt: "10" }], ["T1"])
    expect(r.violations).toContain("owned_row_stop_loss_missing")
    expect(r.offendingSlots).toEqual(["WLDUSDT|long"])
    expect(r.connectionLevelViolation).toBe(false)
  })
  test("a pending mutation marker cannot be tied to a slot: the whole connection halts (fail-safe)", () => {
    const pending = own("p", { symbol: "WLDUSDT", direction: "long", executedQuantity: 10, stopLossOrderId: "S1", takeProfitOrderId: "T1", pendingSystemAction: { kind: "close" } })
    const r = audit([pending], [{ symbol: "WLDUSDT", positionSide: "LONG", positionAmt: "10" }], ["S1", "T1"])
    expect(r.violations).toContain("owned_quantity_mutation_pending")
    expect(r.connectionLevelViolation).toBe(true)
  })
  test("a clean book has no offending slot", () => {
    const r = audit([], [], [])
    expect(r.offendingSlots).toEqual([])
    expect(r.connectionLevelViolation).toBe(false)
  })
})

describe("genuine halts are scoped to their slots and enforced per entry", () => {
  const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
  test("fully slot-attributed genuine violations write per-slot halts; anything else keeps the connection halt", () => {
    expect(src).toContain("if (!transientOnly && !decision.connectionLevelViolation && scopedSlots.length > 0) {")
    expect(src).toContain("entryProtectionSlotHaltKeyOf(input.connectionId, slotKey)")
  })
  test("both entry-path checks consult the connection halt AND this entry's slot halt", () => {
    expect((src.match(/isEntrySlotProtectionHalted\(client, connectionId, realPosition\.symbol, realPosition\.direction\)/g) || []).length).toBe(2)
  })

  test("slot violations that end in 'continue' are still attributed to their slot", () => {
    for (const code of ["owned_slot_venue_cardinality_mismatch", "owned_slot_aggregate_plan_invalid"]) {
      const at = src.indexOf(`violations.push("${code}")`)
      const next = src.indexOf("\n      continue\n", at)
      const attributed = src.indexOf("offendingSlots.add(memberSlotKey)", at)
      expect(attributed).toBeGreaterThan(at)
      expect(attributed).toBeLessThan(next)
    }
  })
})

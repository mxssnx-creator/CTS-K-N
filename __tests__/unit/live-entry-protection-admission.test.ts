import { auditLiveEntryProtectionAdmission } from "@/lib/live-entry-protection-admission"

const owned = (overrides: Record<string, any> = {}) => ({
  id: "row-a",
  connectionId: "bingx-x02",
  system_tracking_id: "sys-bingx-x02-row-a",
  connection_tracking_id: "conn-bingx-x02",
  status: "open",
  symbol: "BTCUSDT",
  direction: "long",
  executedQuantity: 0.01,
  quantityStep: 0.001,
  stopLossOrderId: "sl-a",
  takeProfitOrderId: "tp-a",
  securityStopOrderId: "sec-slot",
  stopLossArmedQuantity: 0.01,
  takeProfitArmedQuantity: 0.01,
  securityStopArmedQuantity: 0.01,
  ...overrides,
})

describe("live entry protectability and physical ownership", () => {
  test("admits another independent row only when all existing controls are live", () => {
    const result = auditLiveEntryProtectionAdmission({
      connectionId: "bingx-x02",
      symbol: "BTCUSDT",
      direction: "long",
      positions: [owned()],
      venuePositions: [{ symbol: "BTC-USDT", positionSide: "LONG", size: "0.01" }],
      liveOrderIds: new Set(["sl-a", "tp-a", "sec-slot"]),
    })
    expect(result).toMatchObject({ safe: true, physicalSlotRows: 1, requiredNewControlOrders: 2 })
  })

  test.each([
    { rows: [owned({ stopLossOrderId: undefined })], orders: ["tp-a", "sec-slot"], code: "owned_row_stop_loss_missing" },
    { rows: [owned({ takeProfitArmedQuantity: 0.02 })], orders: ["sl-a", "tp-a", "sec-slot"], code: "owned_row_take_profit_quantity_mismatch" },
    { rows: [owned({ securityStopOrderId: undefined })], orders: ["sl-a", "tp-a"], code: "owned_slot_security_stop_incomplete" },
  ])("blocks an existing protection gap: $code", ({ rows, orders, code }) => {
    const result = auditLiveEntryProtectionAdmission({
      connectionId: "bingx-x02",
      symbol: "ETHUSDT",
      direction: "short",
      positions: rows,
      venuePositions: [{ symbol: "BTCUSDT", positionSide: "LONG", size: 0.01 }],
      liveOrderIds: new Set(orders),
    })
    expect(result.safe).toBe(false)
    expect(result.violations).toContain(code)
  })

  test.each([
    { pendingAccumulation: { clientOrderId: "acc-1" } },
    { pendingReduction: { clientOrderId: "reduce-1" } },
    { pendingQuantityMutation: { phase: "control_cancel" } },
    { pendingSystemAction: { phase: "submitted" } },
    { aggregateProtectionMutationRequestedAt: Date.now() },
  ])("blocks an open-status row with a durable quantity mutation: %o", (pending) => {
    const result = auditLiveEntryProtectionAdmission({
      connectionId: "bingx-x02",
      symbol: "ETHUSDT",
      direction: "short",
      positions: [owned(pending)],
      venuePositions: [{ symbol: "BTCUSDT", positionSide: "LONG", size: 0.01 }],
      liveOrderIds: new Set(["sl-a", "tp-a", "sec-slot"]),
    })
    expect(result.safe).toBe(false)
    expect(result.violations).toContain("owned_quantity_mutation_pending")
  })

  test("blocks a foreign or mixed physical venue slot without adopting it", () => {
    const external = auditLiveEntryProtectionAdmission({
      connectionId: "bingx-x02",
      symbol: "SOLUSDT",
      direction: "short",
      positions: [],
      venuePositions: [{ symbol: "SOL-USDT", positionSide: "SHORT", size: 3 }],
      liveOrderIds: new Set(),
    })
    expect(external.violations).toContain("venue_physical_slot_external")

    const mixed = auditLiveEntryProtectionAdmission({
      connectionId: "bingx-x02",
      symbol: "BTCUSDT",
      direction: "long",
      positions: [owned()],
      venuePositions: [{ symbol: "BTCUSDT", positionSide: "LONG", size: 0.02 }],
      liveOrderIds: new Set(["sl-a", "tp-a", "sec-slot"]),
    })
    expect(mixed.violations).toContain("venue_physical_slot_quantity_not_fully_owned")
  })

  test("ignores rows owned by another connection and reserves three controls for a new slot", () => {
    const result = auditLiveEntryProtectionAdmission({
      connectionId: "bingx-x02",
      candidateId: "candidate",
      symbol: "XRPUSDT",
      direction: "long",
      positions: [
        owned({
          id: "foreign",
          connectionId: "bingx-x01",
          system_tracking_id: "sys-bingx-x01-row",
          connection_tracking_id: "conn-bingx-x01",
        }),
      ],
      venuePositions: [],
      liveOrderIds: new Set(),
    })
    expect(result).toMatchObject({ safe: true, ownedActiveRows: 0, requiredNewControlOrders: 3 })
  })
})

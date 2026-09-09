const { isRetirableUnsubmittedFailure, TRANSIENT_FAILURE_GRACE_MS } = require("@/lib/unsubmitted-live-retention.cjs")

describe("legacy unsubmitted failure retirement", () => {
  const now = 10 * TRANSIENT_FAILURE_GRACE_MS
  const row = { status: "rejected", executionMode: "live", createdAt: now - 2 * TRANSIENT_FAILURE_GRACE_MS, executedQuantity: "0", fills: "[]", exchangeData: "{}" }
  it("retires only aged, never-submitted failures, including native Redis scalars", () => {
    expect(isRetirableUnsubmittedFailure(row, now)).toBe(true)
    expect(isRetirableUnsubmittedFailure({ ...row, updatedAt: now }, now)).toBe(false)
    expect(isRetirableUnsubmittedFailure({ ...row, createdAt: "invalid" }, now)).toBe(false)
  })
  it.each(["open", "filled", "pending", "placed", "pending_fill", "closed", "closing"])("preserves %s lifecycle records", status => {
    expect(isRetirableUnsubmittedFailure({ ...row, status }, now)).toBe(false)
  })
  it.each([
    { orderId: "venue-order" }, { clientOrderId: "prepared-request" }, { stopLossOrderId: "control" },
    { executedQuantity: "0.01" }, { closedQuantity: "0.01" }, { executedQuantity: "NaN" },
    { fills: '[{"quantity":1}]' }, { exchangeData: '{"orderId":"venue"}' },
    { pendingQuantityMutation: '{"phase":"prepared"}' }, { submissionState: "unconfirmed" },
    { exchangeData: "malformed" }, { executionMode: "simulation" },
  ])("preserves exchange or recovery evidence %j", evidence => {
    expect(isRetirableUnsubmittedFailure({ ...row, ...evidence }, now)).toBe(false)
  })
})

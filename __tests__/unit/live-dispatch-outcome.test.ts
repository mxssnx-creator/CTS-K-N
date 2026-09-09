import { classifyLiveDispatchResult } from "@/lib/live-dispatch-outcome"

describe("live dispatch outcome classification", () => {
  test("keeps successful and pending exchange lifecycle states distinct", () => {
    expect(classifyLiveDispatchResult({ status: "filled" })).toBe("filled")
    expect(classifyLiveDispatchResult({ status: "partially_filled" })).toBe("filled")
    expect(classifyLiveDispatchResult({ status: "pending_fill" })).toBe("pending")
  })

  test("counts expected coordination decisions as deferred", () => {
    expect(classifyLiveDispatchResult({
      status: "rejected",
      statusReason: "deduplication lock held — will retry next cycle",
    })).toBe("deferred")
    expect(classifyLiveDispatchResult({
      status: "rejected",
      statusReason: "DCA waits for authoritative parent fill",
    })).toBe("deferred")
    expect(classifyLiveDispatchResult({
      status: "rejected",
      statusReason: "capacity reached; lower-ranked candidate deferred",
    })).toBe("deferred")
    expect(classifyLiveDispatchResult({
      status: "rejected",
      statusReason: "Skipped — exchange circuit breaker active; resumes in <5min",
    })).toBe("deferred")
  })

  test("keeps safety blocks ahead of textual deferral wording", () => {
    expect(classifyLiveDispatchResult({
      status: "rejected",
      executionMode: "blocked",
      statusReason: "entry deferred until reconciliation",
    })).toBe("blocked")
    expect(classifyLiveDispatchResult({
      status: "error",
      executionBlockCode: "entry_protection_halt",
    })).toBe("blocked")
  })

  test("separates venue rejects and unexpected errors", () => {
    expect(classifyLiveDispatchResult({ status: "rejected", statusReason: "BingX margin rejected" })).toBe("rejected")
    expect(classifyLiveDispatchResult({ status: "error", errorCode: "101204" })).toBe("rejected")
    expect(classifyLiveDispatchResult({ status: "error", error: "timeout" })).toBe("errored")
    expect(classifyLiveDispatchResult({ status: "unknown" })).toBe("other")
  })
})

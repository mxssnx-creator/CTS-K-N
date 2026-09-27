import { idleLiveDispatchSymbolFields } from "@/lib/strategy-coordinator"

test("a symbol with nothing executable resets its dispatch counters", () => {
  const fields = idleLiveDispatchSymbolFields("ETHUSDT")
  expect(fields["s:ETHUSDT:dispatch_candidates"]).toBe("0")
  expect(fields["s:ETHUSDT:dispatch_filled_count"]).toBe("0")
  expect(fields["s:ETHUSDT:dispatch_selected"]).toBe("[]")
  expect(Object.keys(fields).every((key) => key.startsWith("s:ETHUSDT:dispatch_"))).toBe(true)
})

import { canRetainQuickStartPrehistoricCoverage } from "@/lib/quickstart-bootstrap-state"

describe("QuickStart historic bootstrap retention", () => {
  const completed = {
    engineRunning: true,
    needsFreshProcessing: false,
    expectedSelectionEpoch: "epoch-32",
    engineState: { symbol_selection_epoch: "epoch-32", prehistoric_data_loaded: "1" },
    prehistoricState: { symbol_selection_epoch: "epoch-32", is_complete: "1" },
  }

  test("retains only a verified completion for the same symbol generation", () => {
    expect(canRetainQuickStartPrehistoricCoverage(completed)).toBe(true)
  })

  test("does not turn an in-flight engine into a completed historic run", () => {
    expect(canRetainQuickStartPrehistoricCoverage({
      ...completed,
      engineState: { ...completed.engineState, prehistoric_data_loaded: "0" },
      prehistoricState: { ...completed.prehistoricState, is_complete: "0" },
    })).toBe(false)
  })

  test("does not retain a completed previous symbol generation", () => {
    expect(canRetainQuickStartPrehistoricCoverage({
      ...completed,
      prehistoricState: { ...completed.prehistoricState, symbol_selection_epoch: "old-epoch" },
    })).toBe(false)
  })
})

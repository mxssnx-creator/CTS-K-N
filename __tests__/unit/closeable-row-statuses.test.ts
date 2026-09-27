import { isSystemCloseableRowStatus } from "@/lib/closeable-row-statuses"

describe("system close row statuses", () => {
  test("close-all, emergency close and margin call include own rows already closing", () => {
    for (const s of ["open", "filled", "partially_filled", "closing", "closing_partial", "CLOSING"]) {
      expect(isSystemCloseableRowStatus(s)).toBe(true)
    }
    for (const s of ["closed", "pending", "placed", "rejected", "", undefined]) {
      expect(isSystemCloseableRowStatus(s)).toBe(false)
    }
  })
})

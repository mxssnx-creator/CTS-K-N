import { consensusBaselineEvaluations } from "@/lib/signal-indication"

const evaluation = (sourceId: string) => ({ sourceId } as any)
const lifecycle = new Map([["old", "established"], ["new-ok", "candidate"], ["new-raw", "candidate"]])

test("validated (active) candidates count fully in the consensus baseline; unvalidated never do", () => {
  const view = { statuses: new Map([["new-ok", "active"], ["new-raw", "candidate"]]), ranks: new Map(), negativeHoursUtc: new Map() } as any
  const ids = consensusBaselineEvaluations([evaluation("old"), evaluation("new-ok"), evaluation("new-raw")], lifecycle, view)
    .map((row) => row.sourceId)
  expect(ids).toEqual(["old", "new-ok"])
})

test("without a validation snapshot only established sources form the baseline", () => {
  const ids = consensusBaselineEvaluations([evaluation("old"), evaluation("new-ok")], lifecycle, null).map((row) => row.sourceId)
  expect(ids).toEqual(["old"])
})

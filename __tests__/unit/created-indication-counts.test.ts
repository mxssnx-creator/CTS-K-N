import { readCreatedIndicationCounts, overlayCreatedIndicationCounts } from "@/lib/created-indication-counts"

test("a cache overlay reads current created counters, including authoritative zero and hash fallback", async () => {
  const values: Record<string, string> = { "indications:c:direction:count": "774", "indications:c:signal:count": "0" }
  const redis = { get: jest.fn(async (key: string) => values[key] ?? null) }
  const counts = await readCreatedIndicationCounts(redis, "c", { indications_direction_count: "767", indications_signal_count: "23700", indications_move_count: "878" })
  expect(counts).toEqual({ direction: 774, signal: 0, move: 878 })
  const body: any = { indicationsByType: { direction: 767, signal: 23700 },
    breakdown: { indications: { direction: 767, signal: 23700, total: 24467 } },
    activeProgressing: { indications: { direction: { trackings: 767, sets: 3 }, total: { trackings: 24467 } } },
    mainIndications: { types: { direction: { trackings: 767 }, move: { trackings: 870 } }, totals: { trackings: 1637 } } }
  overlayCreatedIndicationCounts(body, counts)
  expect(body.indicationsByType).toEqual(counts)
  expect(body.breakdown.indications).toMatchObject({ direction: 774, move: 878, signal: 0, total: 1652 })
  expect(body.activeProgressing.indications.direction).toEqual({ trackings: 774, sets: 3 })
  expect(body.mainIndications.totals.trackings).toBe(1652)
  values["indications:c:direction:count"] = "780"
  overlayCreatedIndicationCounts(body, await readCreatedIndicationCounts(redis, "c", { indications_move_count: "878" }))
  expect(body.indicationsByType.direction).toBe(780)
})

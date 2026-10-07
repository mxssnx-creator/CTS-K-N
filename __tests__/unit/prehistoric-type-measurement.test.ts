import { parseTypeMeasurement } from "@/lib/prehistoric-type-measurement"

/**
 * The stats route publishes the last prehistoric per-type measurement from
 * the prehistoric hash. Absent before the first run, tolerant of a damaged
 * summary, and never passes through foreign keys or NaN.
 */
describe("parseTypeMeasurement", () => {
  test("absent before the first completed run", () => {
    expect(parseTypeMeasurement(undefined)).toBeNull()
    expect(parseTypeMeasurement({ range_hours: "24" })).toBeNull()
  })

  test("parses buckets keyed type:direction", () => {
    const parsed = parseTypeMeasurement({
      type_measurement_closes: "9",
      type_measurement_summary: JSON.stringify({
        "trend:long": { closed: 6, wins: 5, losses: 1, netPctSum: 2.4, positionCostRatio: 1.4 },
        "direction:short": { closed: 3, wins: 1, losses: 2, netPctSum: -0.9, positionCostRatio: null },
      }),
    })
    expect(parsed).toEqual({
      closes: 9,
      byTypeDirection: {
        "trend:long": { closed: 6, wins: 5, losses: 1, netPctSum: 2.4, positionCostRatio: 1.4 },
        "direction:short": { closed: 3, wins: 1, losses: 2, netPctSum: -0.9, positionCostRatio: null },
      },
    })
  })

  test("a damaged summary yields no buckets, foreign keys and NaN are dropped", () => {
    expect(parseTypeMeasurement({ type_measurement_closes: "4", type_measurement_summary: "{oops" }))
      .toEqual({ closes: 4, byTypeDirection: {} })
    const parsed = parseTypeMeasurement({
      type_measurement_closes: "x",
      type_measurement_summary: JSON.stringify({
        "__proto__:long": { closed: 1 },
        "move:sideways": { closed: 1 },
        "move:long": { closed: "NaN", wins: -1, netPctSum: "abc", positionCostRatio: "nope" },
      }),
    })
    expect(parsed).toEqual({
      closes: 0,
      byTypeDirection: { "move:long": { closed: 0, wins: 0, losses: 0, netPctSum: 0, positionCostRatio: null } },
    })
  })
})

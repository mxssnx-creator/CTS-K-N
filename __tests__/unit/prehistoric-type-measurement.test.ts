import { parseRollingTypeMeasurement, parseTypeMeasurement } from "@/lib/prehistoric-type-measurement"

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
      status: null,
      backfill: null,
    })
  })

  test("reports the measurement status and the backfill of thin buckets", () => {
    const parsed = parseTypeMeasurement({
      type_measurement_closes: "12",
      type_measurement_summary: "{}",
      type_measurement_status: "measured",
      type_measurement_backfill: JSON.stringify({ maxHours: 48, closes: 7, thin: ["BTCUSDT:optimal:short"] }),
    })
    expect(parsed?.status).toBe("measured")
    expect(parsed?.backfill).toEqual({ maxHours: 48, closes: 7, thin: ["BTCUSDT:optimal:short"] })
    expect(parseTypeMeasurement({ type_measurement_closes: "0", type_measurement_status: "skipped:forced_simulation" })?.status)
      .toBe("skipped:forced_simulation")
  })

  test("a damaged summary yields no buckets, foreign keys and NaN are dropped", () => {
    expect(parseTypeMeasurement({ type_measurement_closes: "4", type_measurement_summary: "{oops" }))
      .toEqual({ closes: 4, byTypeDirection: {}, status: null, backfill: null })
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
      status: null,
      backfill: null,
    })
  })
})

describe("parseRollingTypeMeasurement", () => {
  test("absent before the first realtime advance", () => {
    expect(parseRollingTypeMeasurement({})).toBeNull()
    expect(parseRollingTypeMeasurement(null)).toBeNull()
  })

  test("builds buckets from the counters and sums", () => {
    expect(parseRollingTypeMeasurement({
      closes: "3",
      last_at: "1700000000000",
      "n:trend:short": "2",
      "w:trend:short": "1",
      "l:trend:short": "1",
      "net:trend:short": "0.2",
      "ratio:trend:short": "2.2",
      "n:move:long": "1",
      "net:move:long": "-0.7",
      "ratio:move:long": "0.3",
      "n:bogus": "4",
    })).toEqual({
      closes: 3,
      lastAt: 1700000000000,
      byTypeDirection: {
        "trend:short": { closed: 2, wins: 1, losses: 1, netPctSum: 0.2, positionCostRatio: 1.1 },
        "move:long": { closed: 1, wins: 0, losses: 0, netPctSum: -0.7, positionCostRatio: 0.3 },
      },
    })
  })
})

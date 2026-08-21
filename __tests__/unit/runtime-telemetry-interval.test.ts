import { intervalEventLoopUtilizationPct } from "@/lib/runtime-telemetry"

describe("runtime telemetry interval utilization", () => {
  test("does not classify cumulative cold-start work as the next interval", () => {
    expect(intervalEventLoopUtilizationPct({ active: 100, idle: 0 }, null)).toBe(0)
    expect(intervalEventLoopUtilizationPct(
      { active: 140, idle: 60 },
      { active: 100, idle: 40 },
    )).toBeCloseTo(66.666666, 5)
  })

  test("fails closed when counters have no positive interval", () => {
    expect(intervalEventLoopUtilizationPct(
      { active: 20, idle: 20 },
      { active: 30, idle: 30 },
    )).toBe(0)
  })
})

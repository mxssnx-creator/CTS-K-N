import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createThrottledRefresh } from "@/lib/throttled-refresh"

function fakeClock() {
  let t = 0; const timers: { at: number; fn: () => void }[] = []
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number) => { timers.push({ at: t + ms, fn }) },
    advance(ms: number) {
      const end = t + ms
      for (;;) { timers.sort((a, b) => a.at - b.at); const next = timers[0]; if (!next || next.at > end) break; timers.shift(); t = next.at; next.fn() }
      t = end
    },
  }
}

describe("SSE-forced connection reloads are throttled", () => {
  test("a burst of 4 events/s for 30 s reloads at most once per 5 s window (+1 trailing)", () => {
    const clock = fakeClock(); let runs = 0
    const refresh = createThrottledRefresh(() => { runs++ }, 5_000, clock)
    for (let i = 0; i < 120; i++) { refresh(); clock.advance(250) }
    clock.advance(10_000)
    // Production saw 17-22 reloads in 30 s; the throttle allows ~7.
    expect(runs).toBeLessThanOrEqual(8)
    expect(runs).toBeGreaterThanOrEqual(6)
  })
  test("the first event reloads immediately and the last change is never lost", () => {
    const clock = fakeClock(); let runs = 0
    const refresh = createThrottledRefresh(() => { runs++ }, 5_000, clock)
    refresh(); expect(runs).toBe(1)
    clock.advance(100); refresh(); refresh(); expect(runs).toBe(1)
    clock.advance(5_000); expect(runs).toBe(2) // single trailing reload
  })
  test("live stage changes never force a connection reload; they are batched in the hook", () => {
    const ctx = readFileSync(resolve(process.cwd(), "lib/exchange-context.tsx"), "utf8")
    const hook = readFileSync(resolve(process.cwd(), "lib/dashboard-events.ts"), "utf8")
    expect(ctx).toContain('["live.stageChanged", "strategy.stageChanged",')
    expect(ctx).toContain("createThrottledRefresh(")
    expect(hook).toMatch(/highFrequencyTypes = new Set\(\[[\s\S]*"live\.stageChanged"/)
  })
})

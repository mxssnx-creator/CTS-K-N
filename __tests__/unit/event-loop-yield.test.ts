import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { yieldToEventLoop } from "@/lib/event-loop-yield"
import { runHistoricTest } from "@/lib/historic-test-runner"
import { normalizeHistoricTestSettings } from "@/lib/historic-test-settings"

describe("CPU-bound loops let the HTTP server answer", () => {
  test("a timer fires while a loop awaits only microtasks IF it yields, and not if it does not", async () => {
    const timerTicks = async (yields: boolean) => {
      let ticks = 0
      const timer = setInterval(() => { ticks++ }, 1)
      const until = Date.now() + 30
      while (Date.now() < until) { await Promise.resolve(); if (yields) await yieldToEventLoop() }
      clearInterval(timer)
      return ticks
    }
    expect(await timerTicks(false)).toBe(0)
    expect(await timerTicks(true)).toBeGreaterThan(3)
  })

  test("the Historic Test replay does not starve timers while it runs (X02: 58 s in one pass)", async () => {
    const settings = normalizeHistoricTestSettings({ enabled: true, symbolCount: 30, strategies: { normal: true, trailing: true, axis: true, block: true, dca: false } })
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 1)
    let calls = 0
    // A simulator that answers at once from memory, like a replay over cached candles.
    const simulate = async () => { calls++; const until = Date.now() + 1; while (Date.now() < until) { /* 1 ms of CPU */ } return [] }
    const result = await runHistoricTest({
      connectionId: "bingx-x02", settings, now: 1_800_000_000_000,
      rankedSymbols: Array.from({ length: 30 }, (_, i) => `S${i}USDT`), indications: ["momentum", "breakout"],
      simulate,
    } as any)
    clearInterval(timer)
    expect(calls).toBeGreaterThanOrEqual(120)
    expect(result.scores.length).toBe(calls)
    expect(ticks).toBeGreaterThan(20) // a timer that fires every ms was served throughout the run
  })

  test("the replay loop yields once per combination, and the accounting sweep bounds venue calls inside a row", () => {
    const runner = readFileSync(resolve(process.cwd(), "lib/historic-test-runner.ts"), "utf8")
    expect(runner).toContain("await yieldToEventLoop()")
    const cron = readFileSync(resolve(process.cwd(), "app/api/cron/close-accounting/route.ts"), "utf8")
    expect(cron.match(/Date\.now\(\) - started > SWEEP_BUDGET_MS\) break/g) || []).toHaveLength(3) // sweep loop + two per-row loops
    expect(cron).toContain('typeof connector.getPositionHistory === "function" && Date.now() - started <= SWEEP_BUDGET_MS')
  })
})

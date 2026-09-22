import { readFileSync } from "node:fs"
import { resolve } from "node:path"
const cron = readFileSync(resolve(process.cwd(), "app/api/cron/bots/route.ts"), "utf8")
const md = readFileSync(resolve(process.cwd(), "lib/bots/market-data.ts"), "utf8")
describe("the bots cron never holds the scheduler", () => {
  test("ticks run in the background; the request returns at once", () => {
    expect(cron).toContain("void runBotTick(")
    expect(cron).not.toMatch(/await\s+runBotTick\(/)
    expect(cron).not.toMatch(/await Promise\.all\(due\.map/)
  })
  test("its declared duration stays well inside the scheduler's 58 s timeout", () => {
    const m = cron.match(/export const maxDuration = (\d+)/)
    expect(Number(m?.[1])).toBeLessThanOrEqual(30)
  })
  test("bots ticking in the same minute share one candle fetch", () => {
    expect(md).toContain("if (hit && Date.now() - hit.at < 45_000) return hit.value")
  })
})

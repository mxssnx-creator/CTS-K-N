import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { readRealClosedWindow } from "@/lib/real-closed-window"

const isReal = (r: any) => r.real === true
const list = (n: number, realEvery: number) => Array.from({ length: n }, (_, i) => ({ id: i, real: i % realEvery === 0 }))

describe("the 'last 50 real positions' window is filled with real positions", () => {
  test("when the newest rows are rollbacks the list is read further until 75 real ones are found", async () => {
    const all = [...list(400, 1000).map((r) => ({ ...r, real: false })), ...list(300, 1)] // 400 never-executed rows first, then 300 real
    const reads: number[] = []
    const w = await readRealClosedWindow(async (limit) => { reads.push(limit); return all.slice(0, limit) }, isReal)
    expect(w.real).toBeGreaterThanOrEqual(75)
    expect(reads).toEqual([75, 300, 800])
  })
  test("the old behaviour would have found only what fits into the first 75", async () => {
    const all = [...list(65, 1000).map((r) => ({ ...r, real: false })), ...list(500, 1)]
    const first = all.slice(0, 75).filter(isReal).length
    expect(first).toBe(10)
    const w = await readRealClosedWindow(async (limit) => all.slice(0, limit), isReal)
    expect(w.real).toBeGreaterThanOrEqual(75)
  })
  test("enough real rows in the first read means no further read", async () => {
    const reads: number[] = []
    const w = await readRealClosedWindow(async (limit) => { reads.push(limit); return list(200, 1).slice(0, limit) }, isReal)
    expect(reads).toEqual([75]); expect(w.real).toBe(75)
  })
  test("an exhausted list stops the scan and reports what exists", async () => {
    const reads: number[] = []
    const w = await readRealClosedWindow(async (limit) => { reads.push(limit); return list(40, 2).slice(0, limit) }, isReal)
    expect(reads).toEqual([75]); expect(w).toMatchObject({ scanned: 40, real: 20 })
  })
  test("the route reports the window it used", () => {
    const route = readFileSync(resolve(process.cwd(), "app/api/trade-engine/pnl-stats/route.ts"), "utf8")
    expect(route).toContain("window: { closed_rows_scanned: closedWindow.scanned, real_closed_in_window: closedWindow.real }")
    expect(route).toContain("readRealClosedWindow((limit) => getClosedLivePositions(connectionId, limit), isRealExchangePosition)")
  })
})

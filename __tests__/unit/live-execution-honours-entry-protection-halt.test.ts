import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { readLiveEntryReadiness } from "@/lib/live-entry-readiness"

const configured = {
  canPlaceRealOrders: true,
  executionMode: "live",
  requested: true,
  blockCode: null,
  blockReason: null,
} as any

describe("entry protection halt is enforced at execution, not only on status surfaces", () => {
  test("executeLivePosition projects runtime admission before deciding to place a venue entry", () => {
    const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
    expect(src).toContain('import { readLiveEntryReadiness } from "@/lib/live-entry-readiness"')
    const fnStart = src.indexOf("export async function executeLivePosition(")
    expect(fnStart).toBeGreaterThan(0)
    const body = src.slice(fnStart)
    const projection = body.indexOf("await readLiveEntryReadiness(client, connectionId, configuredReadiness)")
    const decision = body.indexOf("const isLiveTradeEnabled = liveReadiness.canPlaceRealOrders")
    expect(projection).toBeGreaterThan(0)
    expect(decision).toBeGreaterThan(projection)
    // The configured evaluation must no longer be assigned straight to the decision variable.
    expect(body).not.toMatch(/const liveReadiness = executionIntent === "direct"\n\s+\? evaluateDirectTradeLiveReadiness/)
  })

  test("a present halt key turns a configured-ready connection into blocked/entry_protection_halt", async () => {
    const client = { get: async (key: string) => (key === "live:entry-protection-halt:bingx-x02" ? "1" : null) }
    const readiness = await readLiveEntryReadiness(client, "bingx-x02", configured)
    expect(readiness.canPlaceRealOrders).toBe(false)
    expect(readiness.executionMode).toBe("blocked")
    expect(readiness.blockCode).toBe("entry_protection_halt")
  })

  test("without halt keys the configured readiness passes through unchanged", async () => {
    const client = { get: async () => null }
    const readiness = await readLiveEntryReadiness(client, "bingx-x02", configured)
    expect(readiness).toEqual(configured)
  })

  test("an unreadable admission store fails closed", async () => {
    const client = { get: async () => { throw new Error("redis down") } }
    const readiness = await readLiveEntryReadiness(client, "bingx-x02", configured)
    expect(readiness.canPlaceRealOrders).toBe(false)
    expect(readiness.blockCode).toBe("runtime_admission_unavailable")
  })
})

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
    const projection = body.indexOf("let admission = await readLiveEntryReadiness(client, connectionId, liveReadiness)")
    const submission = body.indexOf("Step 5: Place entry order with retry")
    const trace = body.indexOf("const orderTrace: LiveOrderTrace = newLiveOrderTrace(")
    expect(projection).toBeGreaterThan(0)
    // The interlock sits immediately before the single new-entry submission
    // point, after accumulation/dedup/partial reconciliation have returned.
    expect(submission).toBeGreaterThan(projection)
    expect(trace).toBeGreaterThan(submission)
    expect(body.slice(projection, submission)).toContain('pushStep(livePosition, "runtime_admission", false')
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

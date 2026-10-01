import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { clearLiveSyncPhase, describeLiveSyncPhase, markLiveSyncPhase, trackLiveSyncConnector } from "@/lib/trade-engine/live-sync-phase"

const CONN = "bingx-x02"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class FakeConnector {
  private positions = [{ symbol: "BTCUSDT" }]
  name = "fake"
  async getPositions() { return this.positions }
  async getOrderHistory(_symbol?: string, limit = 10) { await sleep(60); return Array.from({ length: limit }, (_, i) => i) }
  async failing() { throw new Error("venue 429") }
  syncMethod(a: number, b: number) { return a + b }
}

beforeEach(() => clearLiveSyncPhase(CONN))

describe("the live sync says where it is", () => {
  test("results, arguments, `this` and synchronous methods are unchanged by the wrapper", async () => {
    const wrapped = trackLiveSyncConnector(CONN, new FakeConnector())
    await expect(wrapped.getPositions()).resolves.toEqual([{ symbol: "BTCUSDT" }])
    await expect(wrapped.getOrderHistory(undefined, 3)).resolves.toEqual([0, 1, 2])
    expect(wrapped.syncMethod(2, 3)).toBe(5)
    expect(wrapped.name).toBe("fake")
    expect(wrapped instanceof FakeConnector).toBe(true)
    expect(typeof wrapped.getPositions).toBe("function")
  })
  test("a call in flight is the phase; after it settles the phase says 'after'", async () => {
    const wrapped = trackLiveSyncConnector(CONN, new FakeConnector())
    const pending = wrapped.getOrderHistory(undefined, 1)
    expect(describeLiveSyncPhase(CONN)).toMatch(/^phase: connector\.getOrderHistory for \d+s$/)
    await pending
    expect(describeLiveSyncPhase(CONN)).toMatch(/^phase: after connector\.getOrderHistory for \d+s$/)
  })
  test("a failing call rethrows its error unchanged and marks the phase failed", async () => {
    const wrapped = trackLiveSyncConnector(CONN, new FakeConnector())
    await expect(wrapped.failing()).rejects.toThrow("venue 429")
    expect(describeLiveSyncPhase(CONN)).toContain("after connector.failing (failed)")
  })
  test("the time in the phase is measured from its start", () => {
    markLiveSyncPhase(CONN, "connector.getPositions")
    expect(describeLiveSyncPhase(CONN, Date.now() + 88_400)).toBe("phase: connector.getPositions for 88s")
    expect(describeLiveSyncPhase("unknown-conn")).toBe("phase: unknown")
  })
  test("non-objects pass through and phases are kept per connection", () => {
    expect(trackLiveSyncConnector(CONN, null)).toBeNull()
    expect(trackLiveSyncConnector(CONN, undefined)).toBeUndefined()
    markLiveSyncPhase("a", "x"); markLiveSyncPhase("b", "y")
    expect(describeLiveSyncPhase("a")).toContain("x"); expect(describeLiveSyncPhase("b")).toContain("y")
    clearLiveSyncPhase("a"); expect(describeLiveSyncPhase("a")).toBe("phase: unknown")
  })
  test("the sync wraps its connector at the start and the deadline message carries the phase", () => {
    const stage = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
    expect(stage).toContain('markLiveSyncPhase(connectionId, "start")')
    expect(stage).toContain("exchangeConnector = trackLiveSyncConnector(connectionId, exchangeConnector)")
    const engine = readFileSync(resolve(process.cwd(), "lib/trade-engine/engine-manager.ts"), "utf8")
    expect(engine).toContain("syncDeadlineError.message = `${syncDeadlineError.message} [${describeLiveSyncPhase(this.connectionId)}]`")
  })
})

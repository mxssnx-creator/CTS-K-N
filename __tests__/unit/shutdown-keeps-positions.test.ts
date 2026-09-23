import { readFileSync } from "node:fs"
import { resolve } from "node:path"
const src = readFileSync(resolve(process.cwd(), "lib/error-handling-production.ts"), "utf8")
describe("a shutdown signal never flattens the book by default", () => {
  test("closing positions on SIGTERM requires an explicit opt-in", () => {
    const h = src.slice(src.indexOf("private static handleShutdownSignal("), src.indexOf("private static async emergencyCloseAllPositions("))
    const gate = h.indexOf('process.env.CTS_CLOSE_POSITIONS_ON_SHUTDOWN !== "1"')
    const close = h.indexOf("this.emergencyCloseAllPositions()")
    expect(gate).toBeGreaterThan(0)
    expect(gate).toBeLessThan(close)
    expect(h.slice(gate, close)).toContain("return")
  })
})

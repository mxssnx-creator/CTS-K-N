import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
const guard = src.slice(src.indexOf("const dropsProtectionIdentity ="), src.indexOf("position.version++", src.indexOf("const dropsProtectionIdentity =")))

describe("protection identity survives a concurrent write", () => {
  test("the guard only runs when a write would drop an id", () => {
    expect(guard).toContain("!String(position.stopLossOrderId ?? \"\").trim()")
    expect(guard).toContain("!String(position.takeProfitOrderId ?? \"\").trim()")
    expect(guard).toContain("!String(position.securityStopOrderId ?? \"\").trim()")
  })

  test("staleness is decided by version, not by the absent value", () => {
    // A deliberate clear carries the current version and must be honoured;
    // only a writer BEHIND the stored row has its ids restored.
    expect(guard).toContain("storedVersion > Number(position.version || 0)")
  })

  test("all three control ids are preserved, never just the stop-loss", () => {
    for (const field of ["stopLossOrderId", "takeProfitOrderId", "securityStopOrderId"]) {
      expect([field, guard.includes(`position.${field} = keep(stored.${field})`)]).toEqual([field, true])
    }
  })

  test("an unreadable stored row changes nothing", () => {
    expect(guard).toContain(".catch(() => null)")
    expect(guard).toContain("if (stored && storedVersion >")
  })

  test("the stale writer adopts the stored version so its bump cannot rewind it", () => {
    expect(guard).toContain("position.version = storedVersion")
  })

  test("the production evidence is recorded where the guard sits", () => {
    expect(src).toContain("SL 2101351899508334592")
    expect(src).toContain("only ONE position is ever open at a time")
  })
})

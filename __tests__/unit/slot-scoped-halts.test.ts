import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
const around = (marker: string, span = 700) => {
  const i = src.indexOf(marker)
  return i < 0 ? "" : src.slice(i - span, i + 200)
}

describe("uncertainty about one slot holds only that slot", () => {
  for (const reason of ["entry_protection_rollback_unconfirmed", "entry_fill_unconfirmed"]) {
    test(`${reason} writes the slot key, never the connection-wide halt`, () => {
      const block = around(`reason: "${reason}"`)
      expect(block).toContain("entryRollbackCooldownKeyOf(connectionId, realPosition.symbol, realPosition.direction)")
      // The write that carries this reason must not target the global key.
      const write = block.slice(block.lastIndexOf("await client.setex("))
      expect(write).not.toContain("entryProtectionHaltKey,")
    })
  }

  test("the slot hold lasts the full reconciliation window", () => {
    expect(src).toContain("export const UNCONFIRMED_SLOT_HOLD_SECONDS = 24 * 60 * 60")
  })

  test("the entry gate reads the slot key, so the held slot really cannot re-enter", () => {
    const gate = src.slice(src.indexOf("let admission = await readLiveEntryReadiness("))
    expect(gate.slice(0, 600)).toContain(
      ".get(entryRollbackCooldownKeyOf(connectionId, realPosition.symbol, realPosition.direction))",
    )
  })

  test("slot keys are per symbol AND direction, so two held slots never overwrite each other", () => {
    const keyFn = src.slice(src.indexOf("export function entryRollbackCooldownKeyOf("))
    const body = keyFn.slice(0, keyFn.indexOf("}") + 1)
    expect(body).toContain("symbol")
    expect(body).toContain("direction")
  })

  test("whole-book protection violations still halt the connection", () => {
    // A proven violation across the owned book is not a single-slot concern.
    const fn = src.slice(src.indexOf("async function verifyConnectionProtectionAndPersistHalt("))
    expect(fn.slice(0, 4000)).toContain("const haltKey = entryProtectionHaltKeyOf(input.connectionId)")
  })
})

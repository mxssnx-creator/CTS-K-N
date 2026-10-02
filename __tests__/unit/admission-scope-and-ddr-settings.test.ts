import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8")

describe("a protection violation of ANOTHER slot does not block this candidate (X02: 1513 selected, 5 placed in an hour)", () => {
  const stage = read("lib/trade-engine/stages/live-stage.ts")
  const start = stage.indexOf("const scopedSlots = decision.offendingSlots || []")
  const block = stage.slice(start, start + 2200)
  test("the other slots are still halted, the connection halt is replaced, and a clean candidate slot is admitted", () => {
    expect(block).toContain("entryProtectionSlotHaltKeyOf(input.connectionId, slotKey)")
    expect(block).toContain("await client.del(haltKey).catch(() => 0)")
    expect(block).toContain("const candidateSlot = aggregateProtectionSlot(input.symbol, candidateDirection as ProtectionSlotDirection)")
    expect(block).toContain("if (!scopedSlots.includes(candidateSlot)) {")
    expect(block).toContain("return { ...decision, safe: true, scopedToOtherSlots: scopedSlots } as typeof decision")
  })
  test("only for slot-scoped violations: connection-level and transient ones keep blocking", () => {
    expect(block.indexOf("if (!transientOnly && !decision.connectionLevelViolation && scopedSlots.length > 0) {")).toBe(
      block.indexOf("if (!transientOnly"),
    )
    // the candidate's own slot among the offenders still blocks it
    expect(block.indexOf("return decision")).toBeGreaterThan(block.indexOf("if (!scopedSlots.includes(candidateSlot)) {"))
  })
})

describe("the DDR ceilings are stored, fingerprinted and trigger recoordination (they were dropped by the settings route)", () => {
  const keys = ["maxDrawdownRatio", "maxDrawdownRatioMain", "maxDrawdownRatioReal", "maxDrawdownRatioLive"]
  test.each([
    "app/api/settings/connections/[id]/settings/route.ts",
    "lib/progression-fingerprint.ts",
    "lib/trade-engine/settings-change-fields.ts",
    "lib/connection-recoordinator.ts",
  ])("%s lists every DDR key", (file) => {
    const source = read(file)
    for (const key of keys) expect(source).toContain(`"${key}"`)
  })
})

describe("the entry path decides per candidate slot too (it calls the inner audit directly)", () => {
  const stage = read("lib/trade-engine/stages/live-stage.ts")
  test("the inner audit is safe when every violation belongs to another slot and nothing is connection-level", () => {
    expect(stage).toContain("const onlyOtherSlots = violations.length > 0")
    expect(stage).toContain("&& !offendingSlots.has(candidateSlotKey)")
    expect(stage).toContain("safe: violations.length === 0 || onlyOtherSlots,")
  })
  test("the halt wrapper keeps those other slots halted when the candidate is admitted", () => {
    const h = stage.indexOf("const haltKey = entryProtectionHaltKeyOf(input.connectionId)")
    const i = stage.indexOf("  if (decision.safe) {", h)
    expect(h).toBeGreaterThan(0)
    expect(stage.slice(i, i + 600)).toContain("for (const slotKey of ((decision as any).scopedToOtherSlots || []) as string[]) {")
  })
})

import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8")

describe("X02 exact-slot protection operator", () => {
  test("is hard-scoped to Prod-VST, maintenance, and inactive trading services", () => {
    const source = read("scripts/reconcile-bingx-x02-protection-slot.ts")

    expect(source).toContain('const CONNECTION_ID = "bingx-x02"')
    expect(source).toContain('process.env.BINGX_X02_API_KEY')
    expect(source).toContain('process.env.BINGX_X02_API_SECRET')
    expect(source).not.toContain("process.env.BINGX_API_KEY")
    expect(source).not.toContain("process.env.BINGX_API_SECRET")
    expect(source).toContain('environment?.environment !== "prod-vst"')
    expect(source).toContain("environment?.usesVirtualFunds !== true")
    expect(source).toContain('maintenance.reason !== "marker_present"')
    expect(source).toContain('"cts-kn.service"')
    expect(source).toContain('"cts-kn-scheduler.service"')
    expect(source).toContain('"cts-kn-direct-trade.service"')
    expect(source).toContain("X02_SLOT_PROTECTION_CONFIRM")
  })

  test("filters one slot before aggregate reconciliation and cleans only post-audit CTS orphans", () => {
    const source = read("lib/trade-engine/stages/live-stage.ts")
    const start = source.indexOf("export async function reconcileLiveProtectionSlot(")
    const end = source.indexOf("function aggregateProtectionPhysicalMutationIsInFlight", start)
    const block = source.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(block).toContain("exactProtectionSlotRows(")
    expect(block).toContain("exactProtectionVenueRows(")
    expect(block).toContain("assertEligibleProtectionSlotRows(slotRows)")
    expect(block).toContain("refused ambiguous local/venue quantity ownership")
    expect(block).toContain("reconcileAggregateProtectionBook(")
    expect(block).toContain("slotRows,")
    expect(block).toContain("slotVenuePositions,")
    expect(block.indexOf("if (!afterAudit.expectedComplete)")).toBeLessThan(
      block.indexOf("for (const orphan of afterAudit.orphanOrders)"),
    )
    expect(block).toContain("isConnectionOwnedProtectionOrderForSlot(")
    expect(block).toContain("maxOrphanCancellations")
    expect(block).not.toContain("reconcileLivePositions(")
  })

  test("publishes an explicit package command", () => {
    const pkg = JSON.parse(read("package.json"))
    expect(pkg.scripts["reconcile:bingx:x02:slot-protection"]).toContain(
      "reconcile-bingx-x02-protection-slot.ts",
    )
  })
})

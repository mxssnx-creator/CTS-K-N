import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = process.cwd()
const source = readFileSync(join(root, "scripts/flatten-bingx-x02-vst-positions.ts"), "utf8")

describe("X02 Prod-VST orphan-position flatten operator", () => {
  test("is hard-scoped to virtual X02 credentials and an offline maintenance window", () => {
    expect(source).toContain('const CONNECTION_ID = "bingx-x02"')
    expect(source).toContain("process.env.BINGX_X02_API_KEY")
    expect(source).toContain("process.env.BINGX_X02_API_SECRET")
    expect(source).not.toContain("process.env.BINGX_API_KEY")
    expect(source).not.toContain("process.env.BINGX_API_SECRET")
    expect(source).toContain('environment?.environment !== "prod-vst"')
    expect(source).toContain("environment?.usesVirtualFunds !== true")
    expect(source).toContain('maintenance.reason !== "marker_present"')
    expect(source).toContain('"cts-kn.service"')
    expect(source).toContain('"cts-kn-scheduler.service"')
    expect(source).toContain('"cts-kn-direct-trade.service"')
  })

  test("requires a reviewed immutable snapshot and only invokes reduce-only closePosition", () => {
    expect(source).toContain("X02_VST_FLATTEN_CONFIRM")
    expect(source).toContain('argument("--expect-snapshot")')
    expect(source).toContain("digest !== expectedDigest")
    expect(source).toContain("initialOrders.length > 0")
    expect(source).toContain("connector.closePosition(slot.symbol, slot.direction)")
    expect(source).not.toContain("connector.placeOrder(")
    expect(source).not.toContain("connector.cancelOrder(")
  })

  test("verifies the venue is flat and has no residual order", () => {
    expect(source).toContain("finalPositions.length !== 0 || finalOrders.length !== 0")
    expect(source).toContain("X02 VST final flat-state audit failed")
    expect(source).toContain("Credential redaction invariant failed")
  })

  test("publishes an explicit package command", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    expect(pkg.scripts["flatten:bingx:x02:vst"]).toContain(
      "flatten-bingx-x02-vst-positions.ts",
    )
  })
})

import fs from "node:fs"
import path from "node:path"

const read = (relativePath: string) => fs.readFileSync(path.join(process.cwd(), relativePath), "utf8")

describe("QuickStart live admission presentation", () => {
  test("uses current engine readiness instead of historical blocked counters", () => {
    const source = read("components/dashboard/quickstart-section.tsx")

    expect(source).toContain("/api/connections/${encodeURIComponent(id)}/engine-states")
    expect(source).toContain("liveReadiness?.executionMode === \"blocked\"")
    expect(source).toContain("Live angefordert; neue Entries pausiert")
    expect(source).not.toContain('label:  stats.liveDispatchBlocked > 0 && stats.liveOrdersFilled === 0 ? "Live blocked"')
  })

  test("keeps requested Live intent visible when an entry gate blocks execution", () => {
    const source = read("components/dashboard/quickstart-section.tsx")
    const toggle = source.slice(
      source.indexOf("const handleToggleLiveTrade"),
      source.indexOf("// Sync live-trade status", source.indexOf("const handleToggleLiveTrade")),
    )

    expect(toggle).toContain("setLiveTradeActive(requestedState)")
    expect(toggle).toContain("setLiveReadiness")
    expect(toggle).toContain("live_trade_blocked_reason")
  })

  test("the procedure reports connection-scoped admission separately from infrastructure health", () => {
    const source = read("components/dashboard/quickstart-test-procedure-dialog.tsx")

    expect(source).toContain('id: "live_readiness"')
    expect(source).toContain("/api/connections/${encodeURIComponent(connectionId)}/engine-states")
    expect(source).toContain('status: "warning"')
    expect(source).toContain("warningSteps")
    expect(source).toContain("connection-scoped Live admission")
  })
})

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { stageSnapshotCount, stageSnapshotFreshness } from "@/components/dashboard/quickstart-overview-snapshot"

const overview = {
  counts: { baseStrategies: 120, mainStrategies: 40, realStrategies: 0, liveStrategies: 0 },
  stageSnapshots: {
    base: { coveredSymbols: 4, freshSymbols: 3 },
    main: { coveredSymbols: 4, freshSymbols: 4 },
    real: { coveredSymbols: 2, freshSymbols: 2 },
    live: { coveredSymbols: 0, freshSymbols: 0 },
  },
}

describe("QuickStart functional overview", () => {
  test("a stage with observed rows shows its snapshot count, including a real zero", () => {
    expect(stageSnapshotCount(overview, "base")).toBe(120)
    expect(stageSnapshotCount(overview, "real")).toBe(0)
    expect(stageSnapshotFreshness(overview, "base")).toBe("3/4 fresh")
  })

  test("a stage without any observed row has no snapshot yet instead of a 0", () => {
    expect(stageSnapshotCount(overview, "live")).toBeNull()
    expect(stageSnapshotFreshness(overview, "live")).toBeNull()
    expect(stageSnapshotCount({ counts: { baseStrategies: 5 } }, "base")).toBeNull()
    expect(stageSnapshotCount(null, "main")).toBeNull()
  })

  test("the overview is polled while shown and stops with the panel instead of freezing the first read", () => {
    const ui = readFileSync(resolve(process.cwd(), "components/dashboard/quick-start-button.tsx"), "utf8")
    expect(ui).toContain("usePoll(loadFunctionalOverview, {")
    expect(ui).toContain("enabled: overviewVisible,")
    expect(ui).toContain("setOverviewVisible(true)")
    expect(ui).toContain("onClick={hideOverview}")
    expect(ui).not.toContain('timedFetch("/api/trade-engine/functional-overview"')
    const interval = Number(ui.match(/const OVERVIEW_POLL_INTERVAL_MS = ([\d_]+)/)?.[1].replace(/_/g, ""))
    expect(interval).toBeGreaterThanOrEqual(5_000)
  })
})

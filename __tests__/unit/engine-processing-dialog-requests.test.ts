import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const source = readFileSync(resolve(process.cwd(), "components/dashboard/engine-processing-log-dialog.tsx"), "utf8")

describe("Engine Processing dialog polling", () => {
  test("reads only the canonical stats endpoint it renders", () => {
    const fetchedUrls = [...source.matchAll(/fetch\(\s*[`'"]([^`'"]+)/g)].map((match) => match[1])
    expect(fetchedUrls).toEqual(["/api/connections/progression/${activeConnectionId}/stats"])
    // The keyspace-scanning monitor, the logs route and the verifier were
    // requested every tick and their responses were discarded.
    expect(source).not.toContain("/api/system/monitoring")
    expect(source).not.toContain("/api/engine/verify")
    expect(source).not.toContain("/logs`")
  })

  test("polls no faster than the other stats panels and pauses while the tab is hidden", () => {
    const interval = Number(source.match(/const STATS_POLL_INTERVAL_MS = ([\d_]+)/)?.[1].replace(/_/g, ""))
    expect(interval).toBeGreaterThanOrEqual(5_000)
    expect(source).toContain("gateInterval(() => void fetchStats(), STATS_POLL_INTERVAL_MS)")
    expect(source).not.toMatch(/setInterval\(fetchStats,\s*2000\)/)
  })
})

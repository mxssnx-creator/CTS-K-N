import fs from "node:fs"
import path from "node:path"

const read = (relativePath: string) => fs.readFileSync(path.join(process.cwd(), relativePath), "utf8")

describe("dashboard event stream refactor", () => {
  const dashboardFiles = [
    "components/dashboard/quickstart-section.tsx",
    "components/dashboard/active-connection-card.tsx",
    "components/dashboard/connection-card.tsx",
    "components/dashboard/statistics-overview-v2.tsx",
    "components/dashboard/system-overview.tsx",
  ]

  it("defines the canonical dashboard SSE event types", () => {
    const sseClient = read("lib/sse-client.ts")
    const broadcaster = read("lib/event-broadcaster.ts")
    for (const eventType of [
      "connection.updated",
      "settings.recoordinated",
      "engine.stage.changed",
      "progression.updated",
      "live.summary.updated",
      "logs.appended",
      "monitoring.updated",
    ]) {
      expect(sseClient).toContain(eventType)
      expect(broadcaster).toContain(eventType)
    }
  })

  it("removes steady-state interval polling for dashboard connection/progression/live-summary updates", () => {
    const forbidden = [
      /pollRef\b/,
      /configPollRef\b/,
      /livePollRef\b/,
      /setInterval\s*\(\s*\(\)\s*=>\s*fetchStats/,
      /setInterval\s*\(\s*fetchLiveStats/,
      /setInterval\s*\(\s*pollStatus/,
      /setInterval\s*\(\s*load\s*,\s*3000/,
      /setInterval\s*\(\s*\(\)\s*=>\s*\{\s*loadStats\(\)\s*;\s*loadPerConnectionInfo\(\)/,
    ]

    for (const file of dashboardFiles) {
      const source = read(file)
      for (const pattern of forbidden) {
        expect(source).not.toMatch(pattern)
      }
    }
  })
})

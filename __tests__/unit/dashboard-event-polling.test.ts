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

  it("bridges canonical recoordination/progress/live events into dashboard refresh handlers", () => {
    const source = read("lib/dashboard-events.ts")

    expect(source).toContain('client.subscribe("canonical-event"')
    expect(source).toContain('"connection.recoordinated"')
    expect(source).toContain('"settings.hotReloaded"')
    expect(source).toContain('"progression.epochStarted"')
    expect(source).toContain('"processing.progress"')
    expect(source).toContain('"live.stageChanged"')
    expect(source).toContain('const handler = handlers[eventType]')
    expect(source).toContain('invoked.has(handler)')
    expect(source).toContain('scheduleHandler(handler, payload, event.type)')
    expect(source).toContain('highFrequencyTypes.has(canonicalType)')
    expect(source).toContain('canonicalEvent: event')
  })

  it("rejects stale UI fetches and queues forced refreshes received during an in-flight read", () => {
    const exchangeContext = read("lib/exchange-context.tsx")
    const quickstartConnections = read("components/dashboard/quickstart-connection-controls.tsx")
    const settingsConnections = read("components/settings/exchange-connection-manager.tsx")
    const systemOverview = read("components/dashboard/system-overview.tsx")

    expect(exchangeContext).toContain("forceReloadQueuedRef.current = true")
    expect(exchangeContext).toContain("while (forceReloadQueuedRef.current)")
    expect(exchangeContext).toContain('useDashboardEvents("*", dashboardEventHandlers)')
    expect(quickstartConnections).toContain("connectionLoadSequenceRef.current")
    expect(settingsConnections).toContain("connectionLoadSequenceRef.current")
    expect(systemOverview).toContain("connectionFetchSequenceRef.current")
    expect(systemOverview).toContain("statsFetchSequenceRef.current")
  })

})

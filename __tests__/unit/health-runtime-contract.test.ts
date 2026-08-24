import { readFileSync } from "node:fs"
import path from "node:path"

describe("health runtime contract", () => {
  test("uses distributed heartbeat evidence and O(1) cardinality reads", () => {
    const source = readFileSync(path.resolve(process.cwd(), "app/api/health/route.ts"), "utf8")

    expect(source).toContain('import { resolveDistributedEngineRuntime } from "@/lib/distributed-engine-runtime"')
    expect(source).toContain("const runtime = resolveDistributedEngineRuntime({")
    expect(source).toContain("states: [runtimeState, settingsState, scopedRuntimeState, scopedSettingsState]")
    expect(source).toContain("buildProgressionScope(id, engineType)")
    expect(source).toContain("globalState")
    expect(source).toContain("client.scard(`trades:${id}`)")
    expect(source).toContain("client.scard(`positions:${id}`)")
    expect(source).not.toContain("client.smembers(`trades:${id}`)")
    expect(source).not.toContain("client.smembers(`positions:${id}`)")
    expect(source).toContain("runtimeDeficit")
  })

  test("reports real process pressure against the effective memory limit", () => {
    const source = readFileSync(path.resolve(process.cwd(), "lib/health-check.ts"), "utf8")
    const monitor = readFileSync(path.resolve(process.cwd(), "components/dashboard/system-monitoring-panel.tsx"), "utf8")

    expect(source).toContain("getSystemResourceMetrics")
    expect(source).toContain("memory.memoryPercent > 80")
    expect(source).not.toContain("memUsage.heapUsed / memUsage.heapTotal")
    expect(monitor).toContain("window.setInterval(() => void loadData(), 3_000)")
    expect(monitor).toContain('fetch("/api/system/monitoring", { cache: "no-store" })')
  })
})

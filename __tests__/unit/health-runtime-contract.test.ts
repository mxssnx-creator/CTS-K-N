import { readFileSync } from "node:fs"
import path from "node:path"

describe("health runtime contract", () => {
  test("uses distributed heartbeat evidence and O(1) cardinality reads", () => {
    const source = readFileSync(path.resolve(process.cwd(), "app/api/health/route.ts"), "utf8")

    expect(source).toContain('import { resolveDistributedEngineRuntime } from "@/lib/distributed-engine-runtime"')
    expect(source).toContain("const runtime = resolveDistributedEngineRuntime({")
    expect(source).toContain("states: [runtimeState, settingsState]")
    expect(source).toContain("globalState")
    expect(source).toContain("client.scard(`trades:${id}`)")
    expect(source).toContain("client.scard(`positions:${id}`)")
    expect(source).not.toContain("client.smembers(`trades:${id}`)")
    expect(source).not.toContain("client.smembers(`positions:${id}`)")
    expect(source).toContain("runtimeDeficit")
  })
})

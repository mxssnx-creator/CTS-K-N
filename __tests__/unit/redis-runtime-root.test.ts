import { resolveRedisRuntimeRoot } from "@/lib/redis-runtime-root"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

describe("Redis runtime root", () => {
  const originalJestWorkerId = process.env.JEST_WORKER_ID

  afterEach(() => {
    if (originalJestWorkerId === undefined) delete process.env.JEST_WORKER_ID
    else process.env.JEST_WORKER_ID = originalJestWorkerId
  })

  it("uses the Node process across development and production VM contexts", () => {
    delete process.env.JEST_WORKER_ID
    expect(resolveRedisRuntimeRoot()).toBe(process)
  })

  it("keeps Jest module isolation on globalThis", () => {
    process.env.JEST_WORKER_ID = "1"
    expect(resolveRedisRuntimeRoot()).toBe(globalThis)
  })

  it("owns both connection and trade-engine coordinators on the same runtime root", () => {
    const connectionCoordinator = readFileSync(resolve(process.cwd(), "lib/connection-coordinator.ts"), "utf8")
    const tradeEngine = readFileSync(resolve(process.cwd(), "lib/trade-engine.ts"), "utf8")
    expect(connectionCoordinator).toContain("resolveRedisRuntimeRoot() as ConnectionCoordinatorRuntimeRoot")
    expect(connectionCoordinator).toContain("runtimeRoot.__connectionCoordinator")
    expect(tradeEngine).toContain("const coordGlobal = resolveRedisRuntimeRoot()")
    expect(tradeEngine).toContain("const engineGlobalThis = resolveRedisRuntimeRoot()")
  })

  it("coalesces migrations and the symbol boot pin across route VM contexts", () => {
    const migrations = readFileSync(resolve(process.cwd(), "lib/redis-migrations.ts"), "utf8")
    expect(migrations).toContain("const globalMigrationGuard = resolveRedisRuntimeRoot()")
    expect(migrations).toContain("const _g = resolveRedisRuntimeRoot()")
    expect(migrations).toContain("if (_g.__v0_devBootGuardDone)")
  })
})

import fs from "fs"
import path from "path"

const repo = path.resolve(__dirname, "../..")
const read = (file: string) => fs.readFileSync(path.join(repo, file), "utf8")

describe("GlobalTradeEngineCoordinator.startEngine lock contention", () => {
  test("manager renews its distributed lease before the first startup await", () => {
    const source = read("lib/trade-engine/engine-manager.ts")
    const startOffset = source.indexOf("async start(config: EngineConfig")
    const startBlock = source.slice(startOffset, source.indexOf("private setupErrorRecovery", startOffset))
    const extenderOffset = source.indexOf("private startLockExtender(): void")
    const extenderBlock = source.slice(extenderOffset, source.indexOf("private async", extenderOffset))

    expect(startBlock.indexOf("this.startLockExtender()")).toBeGreaterThan(-1)
    expect(startBlock.indexOf("this.startLockExtender()")).toBeLessThan(startBlock.indexOf("await initRedis()"))
    expect((startBlock.match(/this\.startLockExtender\(\)/g) || [])).toHaveLength(1)
    expect(extenderBlock).toContain("!this.isRunning && !this.isStarting")
  })

  test("manager startup is generation-cancellable and pause stops starting managers", () => {
    const managerSource = read("lib/trade-engine/engine-manager.ts")
    const coordinatorSource = read("lib/trade-engine.ts")
    const startOffset = managerSource.indexOf("async start(config: EngineConfig")
    const startBlock = managerSource.slice(startOffset, managerSource.indexOf("private setupErrorRecovery", startOffset))
    const stopOffset = managerSource.indexOf("async stop(): Promise<void>")
    const stopBlock = managerSource.slice(stopOffset, managerSource.indexOf("private async", stopOffset))
    const pauseOffset = coordinatorSource.indexOf("async pause(): Promise<void>")
    const pauseBlock = coordinatorSource.slice(pauseOffset, coordinatorSource.indexOf("async resume(options:", pauseOffset))

    expect(managerSource).toContain("class EngineStartupCancelledError extends Error")
    expect(managerSource).toContain("private lifecycleGeneration = 0")
    expect(startBlock).toContain("const startupGeneration = ++this.lifecycleGeneration")
    expect(startBlock).toContain("const assertStartupCurrent = () =>")
    expect(startBlock).toContain("startupGeneration !== this.lifecycleGeneration")
    expect(startBlock).toContain("Startup cancelled cleanly")
    expect(stopBlock).toContain("this.lifecycleGeneration++")
    expect(stopBlock).toContain("this.isStarting = false")
    expect(pauseBlock).toContain("if (manager) {")
    expect(pauseBlock).not.toContain("if (manager?.isEngineRunning)")
  })

  test("fresh owner heartbeat leaves duplicate start untouched", () => {
    const source = read("lib/trade-engine.ts")
    const failedAcquireBranch = source.slice(
      source.indexOf("if (!acquired.acquired || !acquired.handle)"),
      source.indexOf("lockHandle = acquired.handle"),
    )
    const freshOwnerBranch = failedAcquireBranch.slice(
      failedAcquireBranch.indexOf("if (ownerHeartbeatFresh)"),
      failedAcquireBranch.indexOf("with a stale heartbeat"),
    )
    const staleOwnerBranch = failedAcquireBranch.slice(
      failedAcquireBranch.indexOf("with a stale heartbeat"),
    )

    expect(failedAcquireBranch).toContain("trade_engine_state:${connectionId}")
    // Fresh-owner detection must reconcile BOTH the raw and `settings:` engine-state
    // hashes via the shared helper — reading only the raw hash made a live engine look
    // stalled and triggered spurious restarts (multiple reinits / doubled progression).
    expect(failedAcquireBranch).toContain("isProcessorHeartbeatFresh")
    expect(failedAcquireBranch).toContain("isProcessorHeartbeatFresh(connectionId, ownerHeartbeatFreshnessMs)")
    expect(failedAcquireBranch).toContain("const ownerHeartbeatFreshnessMs = 90_000")

    expect(freshOwnerBranch).toContain("return true")
    expect(freshOwnerBranch).not.toContain("forceBreakProgressionLock")
    expect(freshOwnerBranch).not.toContain("stopEngine(connectionId)")
    expect(freshOwnerBranch).not.toContain("stop_requested")

    expect(staleOwnerBranch).toContain("client.hset(`trade_engine_state:${connectionId}`")
    expect(staleOwnerBranch).toContain("client.hset(`progression:${connectionId}`")
    expect(staleOwnerBranch).toContain("stop_requested")
    expect(staleOwnerBranch).toContain("await this.stopEngine(connectionId)")
    expect(staleOwnerBranch).toContain("await forceBreakProgressionLock(connectionId)")
  })

  test("every early return after claiming the local startup guard releases it", () => {
    const source = read("lib/trade-engine.ts")
    const startOffset = source.indexOf("async startEngine(connectionId: string")
    const endOffset = source.indexOf("async stopEngine(connectionId: string", startOffset)
    const startEngine = source.slice(startOffset, endOffset)
    const claimOffset = startEngine.indexOf("this.startingEngines.add(connectionId)")
    const freshRemoteOwnerOffset = startEngine.indexOf("is owned by another worker with a fresh heartbeat")
    const releaseOffset = startEngine.indexOf("this.startingEngines.delete(connectionId)")

    expect(claimOffset).toBeGreaterThan(-1)
    expect(freshRemoteOwnerOffset).toBeGreaterThan(claimOffset)
    expect(releaseOffset).toBeGreaterThan(freshRemoteOwnerOffset)
    expect((startEngine.match(/this\.startingEngines\.delete\(connectionId\)/g) || [])).toHaveLength(1)
    expect(startEngine.slice(claimOffset, releaseOffset)).toContain("try {")
    expect(startEngine.slice(releaseOffset - 180, releaseOffset)).toContain("finally")
  })
  test("runtime gate allows explicit foreground starts only when safe", () => {
    const source = read("lib/trade-engine.ts")
    const startEngine = source.slice(
      source.indexOf("async startEngine(connectionId: string"),
      source.indexOf("// Step 2: Check if already running", source.indexOf("async startEngine(connectionId: string")),
    )

    expect(startEngine).toContain("const forceLocalTakeover = options.forceLocalTakeover === true || config.allowInProcessStart === true")
    expect(startEngine).toContain('if (process.env.DISABLE_TRADE_ENGINE_IN_PROCESS === "1")')
    expect(startEngine).toContain('if (process.env.NEXT_RUNTIME === "edge")')
    expect(startEngine).toContain("the durable owner queue remains authoritative")
    expect(startEngine).toContain("const isServerlessWorker = isServerlessDeploymentRuntime()")
    expect(startEngine).toContain("serverless request workers are queued-only without explicit foreground worker flags")
    expect(startEngine).toContain("if (!forceLocalTakeover && !this.canOwnEngineRuntime())")
    expect(startEngine).toContain("queued-only in this production API worker")
  })

  test("stopped generations are detached before restart and during global pause", () => {
    const source = read("lib/trade-engine.ts")
    const startEngine = source.slice(
      source.indexOf("async startEngine(connectionId: string"),
      source.indexOf("// Step 2: Check if already running", source.indexOf("async startEngine(connectionId: string")),
    )
    const pauseBlock = source.slice(
      source.indexOf("async pause(): Promise<void>"),
      source.indexOf("async resume(options:", source.indexOf("async pause(): Promise<void>")),
    )

    expect(startEngine).toContain("const existingManager = this.engineManagers.get(connectionId)")
    expect(startEngine).toContain("if (existingManager?.isEngineRunning === true)")
    expect(startEngine).toContain("this.engineManagers.delete(connectionId)")
    expect(startEngine.indexOf("this.startingEngines.add(connectionId)")).toBeLessThan(
      startEngine.indexOf("this.engineManagers.delete(connectionId)"),
    )

    expect(pauseBlock).toContain("await manager.stop()")
    expect(pauseBlock).toContain("if (this.engineManagers.get(connectionId) === manager)")
    expect(pauseBlock).toContain("this.engineManagers.delete(connectionId)")
    expect(pauseBlock.indexOf("await manager.stop()")).toBeLessThan(
      pauseBlock.indexOf("this.engineManagers.delete(connectionId)"),
    )
  })

  test("global resume restores only engines present in the authoritative pause snapshot", () => {
    const source = read("lib/trade-engine.ts")
    const resumeBlock = source.slice(
      source.indexOf("async resume(options:"),
      source.indexOf("getEngineManager", source.indexOf("async resume(options:")),
    )

    expect(resumeBlock).toContain("let hasAuthoritativeStateSnapshot = false")
    expect(resumeBlock).toContain("hasAuthoritativeStateSnapshot = true")
    expect(resumeBlock).toContain("hasAuthoritativeStateSnapshot && wasRunningBeforePause !== true")
    expect(resumeBlock.indexOf("hasAuthoritativeStateSnapshot && wasRunningBeforePause !== true")).toBeLessThan(
      resumeBlock.indexOf("await this.startEngine(connectionId, config)"),
    )
  })

  test("dev and explicit long-lived node start paths are not blocked by the queued-only production gate", () => {
    const source = read("lib/trade-engine.ts")
    const canOwn = source.slice(
      source.indexOf("private canOwnEngineRuntime(): boolean"),
      source.indexOf("constructor()"),
    )
    const startEngine = source.slice(
      source.indexOf("async startEngine(connectionId: string"),
      source.indexOf("// Self-heal background timers"),
    )
    const runtime = read("lib/deployment-runtime.ts")

    expect(canOwn).toContain("isServerlessDeploymentRuntime()")
    expect(canOwn).toContain("hasExplicitServerlessForegroundOptIn()")
    expect(runtime).toContain('process.env.ALLOW_API_TRADE_ENGINE_FOREGROUND === "1"')
    expect(runtime).toContain('process.env.ENABLE_TRADE_ENGINE_IN_PROCESS === "1"')
    expect(startEngine).toContain("config.allowInProcessStart === true")
    expect(startEngine).toContain("options.forceLocalTakeover === true")
    expect(startEngine).toContain("!forceLocalTakeover && !this.canOwnEngineRuntime()")
  })

  test("QuickStart and start-all only report engine starts when startEngine returns true", () => {
    const quickStart = read("app/api/trade-engine/quick-start/route.ts")
    const startAll = read("app/api/trade-engine/start-all/route.ts")

    expect(quickStart).toContain("const startPromise = coordinator.startEngine")
    expect(quickStart).toContain("const engineStarted = process.env.NODE_ENV")
    expect(quickStart).toContain("if (!engineStarted)")
    expect(quickStart).toContain("engine_start_skipped")
    expect(quickStart.indexOf("if (!engineStarted)")).toBeLessThan(quickStart.indexOf("Main Engine started for"))
    expect((quickStart.match(/\.startEngine\(connectionId,/g) || [])).toHaveLength(1)
    expect(quickStart).not.toContain("refreshEngines().catch")

    expect(startAll).toContain("const engineStarted = await coordinator.startEngine")
    expect(startAll).toContain("success: engineStarted")
    expect(startAll).toContain('message: engineStarted ? "Engine started" : "Engine start skipped by coordinator"')
    expect(startAll).toContain("if (engineStarted)")
  })

})

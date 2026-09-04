import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const originalRuntimeDir = process.env.CTS_RUNTIME_DIR
const originalSoakConfirmation = process.env.BINGX_VST_SOAK_CONFIRM
const temporaryRoots: string[] = []

async function runtimeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cts-runtime-maintenance-"))
  temporaryRoots.push(root)
  return root
}

async function activateMaintenance(): Promise<string> {
  const root = await runtimeRoot()
  await writeFile(path.join(root, "maintenance-stop"), "")
  process.env.CTS_RUNTIME_DIR = root
  return root
}

describe("runtime maintenance stop", () => {
  beforeEach(() => {
    jest.resetModules()
    delete (globalThis as any).__cts_continuity_runner
    delete process.env.BINGX_VST_SOAK_CONFIRM
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    delete (globalThis as any).__cts_continuity_runner
    if (originalRuntimeDir === undefined) delete process.env.CTS_RUNTIME_DIR
    else process.env.CTS_RUNTIME_DIR = originalRuntimeDir
    if (originalSoakConfirmation === undefined) delete process.env.BINGX_VST_SOAK_CONFIRM
    else process.env.BINGX_VST_SOAK_CONFIRM = originalSoakConfirmation
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  test("uses the explicit runtime directory and treats marker presence as active", async () => {
    const root = await runtimeRoot()
    const { getRuntimeMaintenanceState } = await import("@/lib/runtime-maintenance")

    expect(getRuntimeMaintenanceState({ env: { CTS_RUNTIME_DIR: root }, cwd: "/ignored" })).toEqual({
      active: false,
      markerPath: path.join(root, "maintenance-stop"),
      reason: "marker_absent",
    })

    await writeFile(path.join(root, "maintenance-stop"), "")
    expect(getRuntimeMaintenanceState({ env: { CTS_RUNTIME_DIR: root }, cwd: "/ignored" })).toEqual({
      active: true,
      markerPath: path.join(root, "maintenance-stop"),
      reason: "marker_present",
    })
  })

  test("fails closed when the marker path cannot be checked", async () => {
    const root = await runtimeRoot()
    const invalidRuntimePath = path.join(root, "not-a-directory")
    await writeFile(invalidRuntimePath, "file")
    const { getRuntimeMaintenanceState } = await import("@/lib/runtime-maintenance")

    expect(getRuntimeMaintenanceState({ env: { CTS_RUNTIME_DIR: invalidRuntimePath } })).toEqual(
      expect.objectContaining({ active: true, reason: "marker_check_failed" }),
    )
  })

  test("healing skips before readiness, Redis, queues, or coordinator work", async () => {
    await activateMaintenance()
    const readiness = jest.fn()
    const redisLoader = {
      initRedis: jest.fn(),
      getRedisClient: jest.fn(),
      getAssignedAndEnabledConnections: jest.fn(),
      getConnection: jest.fn(),
    }
    jest.doMock("@/lib/production-readiness", () => ({ checkProductionReadiness: readiness }))
    jest.doMock("@/lib/redis-db", () => redisLoader)

    const { runTradeEngineHealingSweep, stopConnectionMonitoring } = await import("@/lib/trade-engine-auto-start")
    const result = await runTradeEngineHealingSweep({ isStartup: true, armTimer: true })
    stopConnectionMonitoring()

    expect(result).toMatchObject({
      startedCount: 0,
      eligibleCount: 0,
      skipped: "runtime_maintenance_stop",
    })
    expect(readiness).not.toHaveBeenCalled()
    expect(redisLoader.initRedis).not.toHaveBeenCalled()
  })

  test("continuity does not arm timers while maintenance is active", async () => {
    await activateMaintenance()
    const { isServerContinuityRunnerStarted, startServerContinuityRunner } = await import(
      "@/lib/server-continuity-runner"
    )

    startServerContinuityRunner()

    expect(isServerContinuityRunnerStarted()).toBe(false)
  })

  test("blocks new live exposure before validation while retaining reduce-only access", async () => {
    await activateMaintenance()
    const { placeLiveOrder } = await import("@/lib/live-order-service")
    const baseInput = {
      connectionId: "bingx-x02",
      symbol: "BTCUSDT",
      side: "long",
      quantity: 0,
    }

    await expect(placeLiveOrder(baseInput)).rejects.toMatchObject({
      statusCode: 503,
      mode: "runtime_maintenance_stop",
    })
    await expect(placeLiveOrder({ ...baseInput, reduceOnly: true })).rejects.not.toMatchObject({
      mode: "runtime_maintenance_stop",
    })
  })

  test("allows only the confirmed synthetic BingX VST soak namespace through the exposure gate", async () => {
    await activateMaintenance()
    process.env.BINGX_VST_SOAK_CONFIRM =
      "I understand Prod-VST places authenticated orders with virtual funds"
    const { placeLiveOrder } = await import("@/lib/live-order-service")

    await expect(placeLiveOrder({
      connectionId: "bingx-vst-soak-unit",
      symbol: "BTCUSDT",
      side: "long",
      quantity: 0,
      connector: {
        getEnvironmentInfo: () => ({
          environment: "prod-vst",
          baseUrl: "https://open-api-vst.bingx.com",
          isDemo: true,
          usesVirtualFunds: true,
        }),
      },
      connection: { exchange: "bingx", is_testnet: "1" },
      safetyPayload: { confirmLiveOrderPlacement: true },
    })).rejects.not.toMatchObject({ mode: "runtime_maintenance_stop" })

    await expect(placeLiveOrder({
      connectionId: "bingx-x02",
      symbol: "BTCUSDT",
      side: "long",
      quantity: 0,
      connector: {},
      connection: { exchange: "bingx", is_testnet: "1" },
      safetyPayload: { confirmLiveOrderPlacement: true },
    })).rejects.toMatchObject({ mode: "runtime_maintenance_stop" })

    await expect(placeLiveOrder({
      connectionId: "bingx-vst-soak-mainnet-impostor",
      symbol: "BTCUSDT",
      side: "long",
      quantity: 0,
      connector: {
        getEnvironmentInfo: () => ({
          environment: "production",
          baseUrl: "https://open-api.bingx.com",
          isDemo: false,
          usesVirtualFunds: false,
        }),
      },
      connection: { exchange: "bingx", is_testnet: "1" },
      safetyPayload: { confirmLiveOrderPlacement: true },
    })).rejects.toMatchObject({ mode: "runtime_maintenance_stop" })
  })

  test("wires the host marker through boot and every managed runtime", async () => {
    const [instrumentation, productionStart, scheduler, directSupervisor, installer, serviceControl, soak, operator, packageJson] = await Promise.all([
      readFile(path.join(process.cwd(), "instrumentation.ts"), "utf8"),
      readFile(path.join(process.cwd(), "scripts/start-production.mjs"), "utf8"),
      readFile(path.join(process.cwd(), "scripts/run-minute-scheduler.mjs"), "utf8"),
      readFile(path.join(process.cwd(), "scripts/direct-trade-supervisor.mjs"), "utf8"),
      readFile(path.join(process.cwd(), "scripts/install.sh"), "utf8"),
      readFile(path.join(process.cwd(), "scripts/service-control.sh"), "utf8"),
      readFile(path.join(process.cwd(), "scripts/run-bingx-vst-live-soak.ts"), "utf8"),
      readFile(path.join(process.cwd(), "scripts/reconcile-bingx-x02-protection-slot.ts"), "utf8"),
      readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ])

    expect(instrumentation).toContain("getRuntimeMaintenanceState")
    expect(instrumentation).toContain("trade-engine auto-start and in-process continuity remain disabled")
    expect(productionStart).toContain("CTS_RUNTIME_DIR: runtimeDir")
    expect(scheduler).toContain("runtime_maintenance_stop")
    expect(directSupervisor).toContain("suppressing all connection workers")
    expect(installer).toContain("CTS_RUNTIME_DIR=${RUNTIME_DIR@Q}")
    expect(installer).toContain('test_runtime_dir="$(mktemp -d "$RUNTIME_DIR/install-test-runtime.XXXXXX")"')
    expect(installer).toContain('env CTS_RUNTIME_DIR="$test_runtime_dir"')
    expect(installer).toMatch(
      /env CTS_RUNTIME_DIR="\$test_runtime_dir"[\s\\]+pnpm exec jest[\s\S]*?rm -rf -- "\$test_runtime_dir"/,
    )
    expect(installer).toContain('run_root chmod 750 "$RUNTIME_DIR"')
    expect(installer).toContain('run_as_service test -e "$RUNTIME_DIR/maintenance-stop"')
    expect(installer).toContain('"$STATE_DIR/data" "$STATE_DIR/logs" "$STATE_DIR/redis" "$STATE_DIR/reports"')
    expect(installer).toContain('run_root ln -s "$STATE_DIR/reports" "$PROJECT_ROOT/.agent-logs"')
    expect(installer).toContain('run_as_service test -w "$STATE_DIR/reports"')
    expect(serviceControl).toContain('run_root chgrp "$service_group" "$RUNTIME_DIR/maintenance-stop"')
    expect(serviceControl).toContain('run_root chmod 640 "$RUNTIME_DIR/maintenance-stop"')
    expect(soak).toContain("assertSoakHostGuard()")
    expect(soak).toContain("evaluateVstSoakOrderHeadroom")
    expect(soak).toContain('await assertSharedAccountOrderHeadroom(`cycle_${index + 1}_protection`)')
    expect(soak).toContain('String(process.env.BINGX_X02_API_KEY || "")')
    expect(soak).not.toContain("process.env.BINGX_X02_API_KEY || process.env.BINGX_API_KEY")
    expect(soak).toContain("setImmediate(() => process.exit(process.exitCode ?? 0))")
    expect(operator).toContain("setImmediate(() => process.exit(process.exitCode ?? 0))")
    expect(JSON.parse(packageJson).scripts["test:bingx:vst:soak"]).toContain(
      "--env-file-if-exists=.env.production.local",
    )
    expect(JSON.parse(packageJson).scripts["test:bingx:vst:preflight"]).toContain(
      "--env-file-if-exists=.env.production.local",
    )

    const entryGuard = soak.indexOf('await assertSharedAccountOrderHeadroom(`cycle_${index + 1}_entry`)')
    const entryOrder = soak.indexOf("cycle.entry = await placeManagedOrder", entryGuard)
    const accumulationGuard = soak.indexOf('await assertSharedAccountOrderHeadroom(`cycle_${index + 1}_accumulation`)')
    const accumulationOrder = soak.indexOf("cycle.accumulation = await placeManagedOrder", accumulationGuard)
    const protectionGuard = soak.indexOf('await assertSharedAccountOrderHeadroom(`cycle_${index + 1}_protection`)')
    const protectionPlacement = soak.indexOf("const stopLoss = await connector.placeStopOrder", protectionGuard)
    expect(entryGuard).toBeGreaterThan(-1)
    expect(entryOrder).toBeGreaterThan(entryGuard)
    expect(accumulationGuard).toBeGreaterThan(entryOrder)
    expect(accumulationOrder).toBeGreaterThan(accumulationGuard)
    expect(protectionGuard).toBeGreaterThan(accumulationOrder)
    expect(protectionPlacement).toBeGreaterThan(protectionGuard)
  })

  test("keeps the VST soak ownership-scoped on a shared account", async () => {
    const soak = await readFile(
      path.join(process.cwd(), "scripts/run-bingx-vst-live-soak.ts"),
      "utf8",
    )

    expect(soak).toContain("ownedExposureBySlot")
    expect(soak).toContain("allOwnedControlOrderIds")
    expect(soak).toContain("waitForExclusiveOwnedQuantity")
    expect(soak).toContain("waitForSymbolOrderQuiet(symbol, \"cycle entry\")")
    expect(soak).toContain("process.env.BINGX_VST_SOAK_EXCLUDE_SYMBOLS")
    expect(soak).toContain("!excludedSymbolSet.has(symbol)")
    expect(soak).toContain("allowedOwnedOrderIds: [retainedSecurityStopOrderId]")
    expect(soak).toContain("classifyVstSoakExternalProtectionOrder")
    expect(soak).toContain("externalProtectionSlot")
    expect(soak).toContain("getOpenOrders(symbol, { forceRefresh: true })")
    expect(soak).toContain("getOpenOrders(undefined, { forceRefresh: true })")
    expect(soak).toContain('acceptedClass: "stable_same-slot_reduce-only-conditional-protection"')
    expect(soak).toContain("externalOrdersCancelledByHarness: 0")
    expect(soak).toContain("allOwnedControlOrderIds.has(orderId)")
    expect(soak).toContain("security-stop-retained-through-close")
    expect(soak).toContain("securityRetainedThroughClose: true")
    expect(soak).toContain("refusing to cancel owned controls while owned exposure remains")
    expect(soak).toContain("venueQuantityBefore - quantity")
    expect(soak).toContain("refusing to close shared exposure")
    expect(soak).toContain("rowProtectionQuantityBacked")
    const cleanupStart = soak.indexOf("const cleanup = async () =>")
    const cleanupEnd = soak.indexOf("\n  try {", cleanupStart)
    const cleanup = soak.slice(cleanupStart, cleanupEnd)
    expect(cleanup.indexOf("for (const exposure of [...ownedExposureBySlot.values()])"))
      .toBeLessThan(cleanup.indexOf("cancelOwnedControlsForFlatSymbol(exposure.symbol)"))
    expect(cleanup).toContain("if (hasOwnedExposureForSymbol(symbol)) continue")
    const retainedSecurityGuard = soak.indexOf('await waitForSymbolOrderQuiet(symbol, "owned reduce-only close"')
    const ownedClose = soak.indexOf("cycle.close = await placeManagedOrder", retainedSecurityGuard)
    const flatPosition = soak.indexOf("cycle.positionQuantityAfterClose = await waitForExclusiveOwnedQuantity", ownedClose)
    const securityCancellation = soak.indexOf("cancelOwnedControlsForFlatSymbol(symbol)", flatPosition)
    expect(retainedSecurityGuard).toBeGreaterThan(-1)
    expect(ownedClose).toBeGreaterThan(retainedSecurityGuard)
    expect(flatPosition).toBeGreaterThan(ownedClose)
    expect(securityCancellation).toBeGreaterThan(flatPosition)
    expect(soak.slice(retainedSecurityGuard, ownedClose)).toContain("externalProtectionSlot")
    expect(soak.slice(retainedSecurityGuard, ownedClose)).toContain("ownedQuantity: cumulativeFill")
    expect(soak.slice(soak.indexOf("const stopLoss = await connector.placeStopOrder"), retainedSecurityGuard))
      .not.toContain("connector.cancelOrder(symbol, securityStopOrderId)")
    expect(soak).not.toContain("trackedExposureSymbols")
    expect(soak).not.toContain("trackedControlOrders.clear()")
    expect(soak).not.toContain("for (const [orderId, symbol] of [...trackedControlOrders.entries()])")
    expect(soak).not.toContain("Math.min(quantity, venueQuantityBefore)")
    expect(soak).not.toContain("quantityOf(authoritativePosition)")

    const exposureRegistration = soak.indexOf("// Record exchange exposure before replay assertions.")
    const replayAssertion = soak.indexOf("idempotent replay did not return the same venue order")
    expect(exposureRegistration).toBeGreaterThan(-1)
    expect(replayAssertion).toBeGreaterThan(exposureRegistration)
  })

  test("gates legacy enable surfaces before they can persist start intent", async () => {
    const paths = [
      "app/api/admin/enable-live-trading/route.ts",
      "app/api/system/demo-setup/route.ts",
      "app/api/system/inject-credentials/route.ts",
      "app/api/trade-engine/auto-setup/route.ts",
      "app/api/settings/risk-and-engines/route.ts",
      "app/api/settings/connections/[id]/settings/route.ts",
    ]
    const sources = await Promise.all(
      paths.map((file) => readFile(path.join(process.cwd(), file), "utf8")),
    )

    for (const source of sources) {
      expect(source).toContain("getRuntimeMaintenanceState")
      expect(source).toContain("runtimeMaintenanceJson")
      expect(source).toContain("status: 503")
    }

    expect(sources[5]).toContain("requestsRuntimeEnable")
    const coordinator = await readFile(path.join(process.cwd(), "lib/trade-engine.ts"), "utf8")
    expect(coordinator).toContain("stopping ${runningConnectionIds.length} local engine(s)")

    const recoordination = await readFile(
      path.join(process.cwd(), "lib/connection-recoordinator.ts"),
      "utf8",
    )
    expect(recoordination).toContain("Runtime recoordination suppressed")
    expect(recoordination.indexOf("const maintenance = getRuntimeMaintenanceState()"))
      .toBeLessThan(recoordination.indexOf("const wasRunningBeforeApply"))
  })

  test("test dialogs never present a maintenance rejection as a successful start", async () => {
    const [procedure, fullSystem] = await Promise.all([
      readFile(path.join(process.cwd(), "components/dashboard/quickstart-test-procedure-dialog.tsx"), "utf8"),
      readFile(path.join(process.cwd(), "components/dashboard/quickstart-full-system-test-dialog.tsx"), "utf8"),
    ])

    expect(procedure).toContain("res.ok && data.success !== false")
    expect(procedure).not.toContain("res.ok || data.success")
    expect(fullSystem).toContain("!quickstartResponse.ok || quickstartInit.success === false")
    expect(fullSystem).toContain("!engineStartResponse.ok || engineStart.success === false")
    expect(fullSystem).not.toContain("⚠️ Already running")
  })
})

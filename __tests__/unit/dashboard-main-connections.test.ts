import fs from "node:fs"
import path from "node:path"
import {
  boundedPassedCount,
  boundedPercentage,
  boundedRatioPercentage,
  finiteMetric,
  nonNegativeMetric,
} from "@/lib/dashboard-metrics"
import {
  invalidateTradeEngineStatusCache,
  readTradeEngineStatusCache,
  writeTradeEngineStatusCache,
} from "@/lib/trade-engine-status-cache"

const read = (relativePath: string) => fs.readFileSync(path.join(process.cwd(), relativePath), "utf8")

describe("Main Connections dashboard contracts", () => {
  test("normalizes distributed counters and ratios before rendering", () => {
    expect(finiteMetric("3.5")).toBe(3.5)
    expect(finiteMetric(Number.POSITIVE_INFINITY)).toBe(0)
    expect(nonNegativeMetric(-4)).toBe(0)
    expect(boundedPercentage(-1)).toBe(0)
    expect(boundedPercentage(140)).toBe(100)
    expect(boundedRatioPercentage(7, 4)).toBe(100)
    expect(boundedRatioPercentage(1, 3)).toBe(33.3)
    expect(boundedRatioPercentage(4, 0)).toBe(0)
    expect(boundedPassedCount(12, 8)).toBe(8)
  })

  test("guided QuickStart preserves saved Live Trade intent", () => {
    const source = read("components/dashboard/quick-start-button.tsx")
    const verificationStep = source.slice(
      source.indexOf("STEP 6: Verify Engine + Progression"),
      source.indexOf("toast.success", source.indexOf("STEP 6: Verify Engine + Progression")),
    )

    expect(source).toContain("buildQuickStartBodyFromSavedSettings")
    expect(verificationStep).toContain("/engine-states")
    expect(verificationStep).toContain('method: "GET"')
    expect(verificationStep).not.toContain("/live-trade")
    expect(verificationStep).not.toContain("is_live_trade: true")
  })

  test("quick settings accumulate adjacent fields and stay selection-scoped", () => {
    const source = read("components/dashboard/quickstart-options-bar.tsx")

    expect(source).toContain("function useDebouncedPatchSaver")
    expect(source).toContain("mergeConnectionSettings(pendingRef.current, patch)")
    expect(source).toContain("const debouncedSaveSettings = useDebouncedPatchSaver(patchSettings, 200)")
    expect(source).not.toContain("debouncedSaveCoord")
    expect(source).toContain("variants: { trailing: next }")
    expect(source).toContain("variants: { block: next }")
    expect(source).toContain("variants: { dca: next }")
    expect(source).toContain("hydratedConnectionId === cid")
    expect(source).toContain("controlOrdersRef.current = next")
    expect(source).not.toContain("setControlOrders((previous) =>")
    expect(source).toContain("connection-settings-recoordination-complete")
  })

  test("connection picker follows the same stable Main-panel assignment rule", () => {
    const source = read("components/dashboard/quickstart-connection-controls.tsx")
    const helper = source.slice(source.indexOf("function isInMainPanel"), source.indexOf("function exchangeColor"))

    expect(helper).toContain("is_active_inserted")
    expect(helper).toContain("is_dashboard_inserted")
    expect(helper).toContain("is_assigned")
    expect(helper).toContain("is_enabled_dashboard")
    expect(source).toContain("return !isInMainPanel(c)")
    expect(source).toContain("return isInMainPanel(c)")
  })

  test("paused, queued, realtime, and mainnet labels are not conflated with Live Orders", () => {
    const activeCard = read("components/dashboard/active-connection-card.tsx")
    const globalControls = read("components/dashboard/global-trade-engine-controls.tsx")

    expect(activeCard).toContain('live_trading: "Realtime Processing Active"')
    expect(activeCard).toContain('? { label: "Running"')
    expect(activeCard).toContain('? { label: "Queued"')
    expect(activeCard).toContain(">Mainnet</span>")
    expect(activeCard).toContain("globalEngineRunning && connection.isActive")
    expect(globalControls.indexOf("if (status.paused)")).toBeLessThan(globalControls.indexOf("if (!status.running)"))
    expect(globalControls).toContain("!status?.running && !status?.paused")
    expect(globalControls).toContain("{status?.paused && (")
    expect(globalControls).toContain("disabled={engineActionPending}")
    expect(globalControls).toContain('new CustomEvent("engine-state-changed"')
  })

  test("volume controls use the engine default and versioned hot-reload acknowledgements", () => {
    const activeCard = read("components/dashboard/active-connection-card.tsx")
    const volumeRoute = read("app/api/settings/connections/[id]/volume/route.ts")

    expect(activeCard).toContain("Number(details.live_volume_factor) || MIN_VOLUME_FACTOR")
    expect(activeCard).toContain("volumeSaveSequenceRef")
    expect(activeCard).toContain("setLiveVolumeFactor(previous)")
    expect(volumeRoute).toContain("const settingsVersion =")
    expect(volumeRoute).toContain("settingsVersion,")
    expect(volumeRoute).toContain("recoordinationId: settingsVersion")
    expect(volumeRoute).toContain("progressionEpoch: recoordination.completedAt")
  })

  test("operator mutations invalidate the process-local status snapshot", () => {
    invalidateTradeEngineStatusCache()
    expect(readTradeEngineStatusCache()).toBeUndefined()
    writeTradeEngineStatusCache({ status: "running" }, 5_000)
    expect(readTradeEngineStatusCache()).toEqual({ status: "running" })
    invalidateTradeEngineStatusCache()
    expect(readTradeEngineStatusCache()).toBeUndefined()

    for (const route of ["start", "pause", "resume", "stop"]) {
      expect(read(`app/api/trade-engine/${route}/route.ts`)).toContain("invalidateTradeEngineStatusCache()")
    }
  })

  test("critical Main Connection surfaces include responsive and dark-theme states", () => {
    const quickStart = read("components/dashboard/quick-start-button.tsx")
    const activeCard = read("components/dashboard/active-connection-card.tsx")
    const manager = read("components/dashboard/dashboard-active-connections-manager.tsx")

    expect(quickStart).toContain("dark:bg-blue-950/30")
    expect(quickStart).toContain("flex flex-wrap gap-2 pt-2")
    expect(quickStart).toContain("sm:flex-row")
    expect(activeCard).toContain("flex flex-wrap items-center gap-x-4 gap-y-2")
    expect(activeCard).toContain("sm:grid-cols-3")
    expect(manager).toContain("flex flex-wrap items-center justify-between gap-3")
  })

  test("Main Connection information dialog exposes detailed, refresh-safe top sections", () => {
    const source = read("components/settings/connection-info-dialog.tsx")

    for (const section of ["overview", "runtime", "indications", "strategies", "settings"]) {
      expect(source).toContain(`value="${section}"`)
    }
    expect(source).toContain('aria-label="Connection information sections"')
    expect(source).toContain("loadSequenceRef")
    expect(source).toContain("abortRef.current?.abort()")
    expect(source).toContain("Promise.allSettled")
    expect(source).toContain("indicationChannels")
    expect(source).toContain("channels.main")
    expect(source).toContain("/engine-states")
    expect(source).toContain("/stats")
    expect(source).toContain("Execution safety")
    expect(source).toContain("Settings version")
    expect(source).toContain("min-w-[650px]")
  })

  test("preset assignment reads and writes the canonical Redis connection", () => {
    const route = read("app/api/settings/connections/[id]/preset-type/route.ts")
    const recoordinator = read("lib/connection-recoordinator.ts")

    expect(route).not.toContain('from "@/lib/db"')
    expect(route).toContain("getConnection(id)")
    expect(route).toContain("preset_type:${presetTypeId}")
    expect(route).toContain("applyMainConnectionSettingsChange")
    expect(route).toContain('changedFieldsOverride: ["preset_type_id"]')
    expect(route).toContain("presetType: null, preset_type_id: null")
    expect(recoordinator).toContain('"preset_type_id",')
  })
})

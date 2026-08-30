import fs from "fs"
import path from "path"

const repo = path.resolve(__dirname, "../..")
const read = (file: string) => fs.readFileSync(path.join(repo, file), "utf8")

describe("requested regression guardrails", () => {
  test("shared page header cannot collapse and hide the mobile sidebar trigger", () => {
    const header = read("components/page-header.tsx")
    const css = read("app/globals.css")

    expect(header).toContain('page-header-shell isolate shrink-0')
    expect(header).toContain("<SidebarTrigger")
    expect(css).toMatch(/\.page-header-shell\s*\{[\s\S]*?flex:\s*0 0 auto;/)
    expect(css).toMatch(/\.page-header-shell\s*\{[\s\S]*?min-height:\s*4rem;/)
  })
  test("progression dump remains explicitly enabled and admin authenticated", () => {
    const source = read("app/api/debug/progression-dump/route.ts")
    expect(source).toContain('process.env.REDIS_DEBUG_ENABLED !== "1"')
    expect(source).toContain('authorizeAdminBearer(request.headers.get("authorization"))')
    expect(source.indexOf("authorizeAdminBearer")).toBeLessThan(source.indexOf("await initRedis()"))
  })

  test("startup and diagnostics never substitute unscoped market data", () => {
    const startup = read("lib/pre-startup.ts")
    const verification = read("app/api/debug/system-verification/route.ts")
    const dump = read("app/api/debug/progression-dump/route.ts")

    expect(startup).not.toContain("saveMarketData")
    expect(verification).toContain('marketDataKey("BTCUSDT", "", marketDataConnectionId)')
    expect(verification).not.toContain('hgetall("market_data:BTCUSDT")')
    expect(dump).toContain("client.keys(`market_data:${id}:*`)")
    expect(dump).not.toContain("client.keys(`market_data:*`)")
  })

  test("progression stats preserve canonical row fan-out without inflating logical stage counts", () => {
    const coordinator = read("lib/strategy-coordinator.ts")
    const statsRoute = read("app/api/connections/progression/[id]/stats/route.ts")

    expect(coordinator).toContain("let realStageRelatedCreated = 0")
    expect(coordinator).toContain("realStageRelatedCreated += activePositionBlockOverlays.length")
    expect(coordinator).toContain("const realRelatedCreated = realStageRelatedCreated")
    expect(coordinator).toContain("const realTotalEvaluated = mainPFEligible + realRelatedCreated")
    expect(coordinator).toContain('`${symbol}:real:input`')
    expect(coordinator).toContain('`${symbol}:real:relatedCreated`')
    expect(coordinator).toContain('`${symbol}:real:evaluated`]: String(realLogicalInput)')
    expect(coordinator).toContain('`${symbol}:real:rawEvaluated`]: String(realEvaluatedAfterFanOut)')
    expect(coordinator).toContain('`${symbol}:real:passed`]: String(realLogicalPassed)')

    expect(statsRoute).toContain("const strategyRows = {")
    expect(statsRoute).toContain("overallToValidRatio: ratio(mainRowOverall, mainRowValid, false)")
    expect(statsRoute).toContain('semantics: "latest-cycle-and-current-open-row-snapshot"')
    expect(statsRoute).not.toContain("stratCounts.real = stratCounts.main")
    expect(statsRoute).toContain("Do not clamp stage snapshots against each other")
    expect(statsRoute).not.toContain("stratCounts.live = stratCounts.real")
    expect(coordinator).not.toContain("dev fallback - injected synthetic qualifying set from MAIN")

    const snapshot = { main: 10, real: 12, live: 14 }
    const normalizedReal = snapshot.real
    const normalizedLive = Math.min(snapshot.live, normalizedReal)
    expect(normalizedReal).toBe(12)
    expect(normalizedLive).toBe(12)
  })


  test("dashboard settings recoordination is event-driven without delayed refresh polling", () => {
    const manager = read("components/dashboard/dashboard-active-connections-manager.tsx")
    const dialog = read("components/settings/connection-settings-dialog.tsx")
    const route = read("app/api/settings/connections/[id]/settings/route.ts")

    expect(manager).not.toContain("setTimeout(() => loadConnections")
    expect(manager).not.toContain("setTimeout(checkGlobalEngine")
    expect(manager).toContain("connection-settings-recoordination-complete")
    expect(manager).toContain("pendingSettingsVersionsRef")
    expect(manager).toContain("Settings recoordination did not confirm")

    expect(dialog).toContain("connection-settings-recoordination-complete")
    expect(dialog).toContain("settingsVersion")
    expect(route).toContain("settingsVersion")
    expect(route).toContain("recoordinationId")
    expect(route).toContain("progressionEpoch")
  })

  test("live order test endpoints require explicit server and request safety gates", () => {
    const safety = read("lib/live-order-safety.ts")
    const placeOrder = read("app/api/testing/place-order/route.ts")
    const liveOrderService = read("lib/live-order-service.ts")
    const liveOrdersTest = read("app/api/test/live-orders-test/route.ts")

    expect(safety).toContain('process.env.ALLOW_LIVE_ORDER_PLACEMENT === "1"')
    expect(safety).toContain('confirmLiveOrderPlacement === true')
    expect(safety).toContain('I understand this places real exchange orders')
    expect(placeOrder).toContain('placeLiveOrder')
    expect(liveOrderService).toContain('const willUseRealExchange = !forceSim && hasUsableLiveCredentials(connection)')
    expect(liveOrderService).toContain('getLiveOrderSafetyFailure(payload)')
    expect(liveOrderService).toContain('mode: "blocked_live_order_safety"')
    expect(liveOrderService).toContain('mode: "live"')
    expect(liveOrderService).toContain('"live_orders_simulated_count"')
    expect(liveOrderService).toContain('if (sideKey === "long" || sideKey === "buy") return "long"')
    expect(liveOrderService).toContain('if (sideKey === "short" || sideKey === "sell") return "short"')
    expect(liveOrderService).toContain("Order side must be long, short, buy, or sell")
    expect(liveOrderService).toContain('return direction === "long" ? "buy" : "sell"')
    expect(liveOrderService).toContain('`${symbolKey}:${directionKey}:${metric}`')
    expect(placeOrder).not.toContain('JSON.stringify(existing)')
    expect(placeOrder).not.toContain("symbol,\n          side,")
    expect(liveOrdersTest).toContain('getLiveOrderSafetyFailure(body)')
    expect(liveOrdersTest).toContain('mode: "blocked_live_order_safety"')
  })

  test("live-stage reconcile fill accounting is marker-guarded", () => {
    const source = read("lib/trade-engine/stages/live-stage.ts")

    expect(source).toContain("fillCounterRecordedAt?: number")
    expect(source).toContain("function hasFillCounterRecorded")
    expect(source).toContain("if (hasFillCounterRecorded(position)) return false")
    expect(source).toContain("position.fillCounterRecordedAt = Date.now()")

    const fallbackBlock = source.slice(
      source.indexOf("confirmed_position_fallback: reconcile saw exchange position"),
      source.indexOf("if (pos.orderId)", source.indexOf("confirmed_position_fallback: reconcile saw exchange position")),
    )
    expect(fallbackBlock).toContain("await recordFillCountersOnce(connectionId, pos")
    expect(fallbackBlock).not.toContain('incrementMetric(connectionId, "live_orders_filled_count")')
    expect(fallbackBlock).not.toContain('incrementOrdersBySymbol(connectionId, pos.symbol')

    const orderBlock = source.slice(
      source.indexOf('statusLower === "filled" || statusLower === "partially_filled"'),
      source.indexOf('} else if (statusLower === "cancelled"', source.indexOf('statusLower === "filled" || statusLower === "partially_filled"')),
    )
    expect(orderBlock).toContain("await recordFillCountersOnce(connectionId, pos")
    expect(orderBlock).not.toContain('incrementMetric(connectionId, "live_orders_filled_count")')
    expect(orderBlock).not.toContain('incrementOrdersBySymbol(connectionId, pos.symbol')
  })

  test("live order statistics keep long and short buckets independent", () => {
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")
    const statsRoute = read("app/api/connections/progression/[id]/stats/route.ts")

    expect(liveStage).toContain('const sideKey = String(side || "").trim().toLowerCase()')
    expect(liveStage).toContain('sideKey === "long" || sideKey === "buy"')
    expect(liveStage).toContain('sideKey === "short" || sideKey === "sell"')
    expect(liveStage).toContain('const symbolKey = String(symbol || "").trim().toUpperCase()')
    expect(liveStage).toContain("recordPerSymbolOrderCounter(connectionId, symbolKey, dir")

    expect(statsRoute).toContain("Legacy/testing route compatibility")
    expect(statsRoute).toContain('rawSide === "short" || rawSide === "sell"')
    expect(statsRoute).toContain("const legacyCount = n(parsed?.count ?? 0)")
    expect(statsRoute).toContain("parsed?.filled ?? parsed?.ordersFilled ?? legacyCount")
    expect(statsRoute).toContain("entry[direction][kind] += value")
    expect(statsRoute).not.toContain("entry[direction][kind] = value")
  })

  test("progression strategy totals are pipeline-aware and do not sum cascade stages", () => {
    const statsRoute = read("app/api/connections/progression/[id]/stats/route.ts")

    expect(statsRoute).toContain("Pipeline-aware total: Main includes related descendants of Base")
    expect(statsRoute).toContain("total: stratTotal")
    expect(statsRoute).not.toContain("total: (stratCounts.base || 0) + (stratCounts.main || 0) + (stratCounts.real || 0) + (stratCounts.live || 0)")
    expect(statsRoute).not.toContain("full pipeline throughput across all stages")
  })


  test("live-trade UI uses requested intent so sliders do not flip off while blocked", () => {
    const engineStates = read("app/api/connections/[id]/engine-states/route.ts")
    const activeCard = read("components/dashboard/active-connection-card.tsx")
    const optionsBar = read("components/dashboard/quickstart-options-bar.tsx")
    const quickstart = read("components/dashboard/quickstart-section.tsx")

    expect(engineStates).toContain("const liveRequested = liveReadiness.requested")
    expect(engineStates).toContain("const flagLive    = liveRequested || liveEffective")
    expect(engineStates).toContain("...buildModeState(flagLive, liveEffective)")
    expect(engineStates).toContain("executionMode: liveReadiness.executionMode")
    expect(engineStates).toContain("mainTrade: mainTradeState")
    expect(engineStates).toContain("presetTrade: presetTradeState")
    expect(engineStates).toContain("live: mainTradeState")
    expect(engineStates).toContain("preset: presetTradeState")
    expect(activeCard).toContain("const liveTradeUiFlag")
    expect(activeCard).toContain("toBoolean(details?.live_trade_requested) || toBoolean(details?.is_live_trade)")
    expect(activeCard).toContain("const requestedState = typeof data.live_trade_requested === \"boolean\" ? data.live_trade_requested : newState")
    expect(optionsBar).toContain("const liveRequested = toBooleanFlag(conn.live_trade_requested)")
    expect(optionsBar).toContain("controlOrdersRef.current = liveRequested || liveEffective")
    expect(optionsBar).toContain("setControlOrders(controlOrdersRef.current)")
    expect(quickstart).toContain("const liveTradeUiFlag = (conn: any): boolean")
    expect(quickstart).toContain("setLiveTradeActive(liveTradeUiFlag(conn))")
  })


  test("live-trade enable updates global operator intent to running", () => {
    const source = read("app/api/settings/connections/[id]/live-trade/route.ts")
    const intentBlock = source.slice(
      source.indexOf('await getRedisClient().hset("trade_engine:global"'),
      source.indexOf('}).catch((stateErr: unknown)', source.indexOf('await getRedisClient().hset("trade_engine:global"')),
    )

    expect(intentBlock).toContain('status: "running"')
    expect(intentBlock).toContain('desired_status: "running"')
    expect(intentBlock).toContain('operator_intent: "running"')
    expect(intentBlock).toContain('mode: liveTradeEffective ? "live" : "live_requested"')
  })

  test("live-trade queued starts use per-connection refresh requests consumed by coordinator", () => {
    const source = read("app/api/settings/connections/[id]/live-trade/route.ts")

    expect(source).toContain("queueEngineRefreshRequest({")
    expect(source).toContain("state_switch_version: stateSwitchVersion")
    expect(source).toContain('engine_type: "main"')
    expect(source).not.toContain('engine_type: "live"')
    expect(source).not.toContain('hset("engine_coordinator:refresh_requested"')
    expect(source).toContain('engineStatus = "queued"')
  })

  test("production healing sweep drains queued engine refresh requests through shared claim helper", () => {
    const autoStartSource = read("lib/trade-engine-auto-start.ts")
    const queueSource = read("lib/engine-refresh-queue.ts")

    expect(autoStartSource).toContain("processQueuedEngineRefreshRequests")
    expect(autoStartSource).toContain("processQueuedEngineRefreshRequests: consumeQueuedEngineRefreshRequests")
    expect(queueSource).toContain("getQueuedEngineRefreshRequests")
    expect(queueSource).toContain("currentVersion !== requestedVersion")
    expect(queueSource).toContain("ENGINE_REFRESH_CLAIM_PREFIX")
    expect(queueSource).toContain("NX: true, PX: ENGINE_REFRESH_CLAIM_TTL_MS")
    expect(autoStartSource).toContain("await coordinator.stopEngine(request.connectionId, { operatorRequested: true })")
    expect(autoStartSource).toContain("await coordinator.startMissingEngines([connection])")
    expect(autoStartSource).toContain("queuedRefreshProcessedCount")
  })

  test("live-trade enable preserves requested state when credentials are missing", () => {
    const source = read("app/api/settings/connections/[id]/live-trade/route.ts")

    expect(source).toContain("BASE_CONNECTION_CREDENTIALS[connectionId as keyof typeof BASE_CONNECTION_CREDENTIALS]?.apiKey")
    expect(source).toContain("liveTradeBlockedReason = prospectiveReadiness.blockReason")
    expect(source).toContain("is_live_trade: toRedisFlag(liveTradeEffective)")
    expect(source).toContain("evaluateRealTradeReadiness")
    expect(source).toContain('live_trade_requested: "1"')
    expect(source).not.toContain('error: "API credentials required for live trading"')
  })

  test("global start preserves operator live intent and credential-gates only requested live trading", () => {
    const source = read("app/api/trade-engine/start/route.ts")
    const coordinatorSource = read("lib/trade-engine.ts")

    expect(source).toContain("function isLiveTradeRequested")
    expect(source).toContain("validateLiveTradeRequirements")
    expect(source).not.toContain("connector.testConnection()")
    expect(source).toContain("const liveTradeUpdate = liveTradeRequested")
    expect(source).toContain("...liveTradeUpdate")
    expect(source).toContain('is_live_trade: credentialCheck.valid ? "1" : "0"')
    expect(source).toContain('live_trade_requested: "0"')
    expect(source).toContain('engine_type: "main"')
    expect(source).toContain("const startedLocally = coordinator.isEngineRunning(conn.id)")
    expect(source).toContain('reason: "global_start_external_owner"')
    expect(source).toContain('coordinator_status: queuedForOwner ? "queued_for_owner" : "running"')
    expect(source).toContain("isConnectionAssignedToMain(conn)")
    expect(source).toContain("isConnectionProcessingEnabled(conn)")
    expect(source).toContain("isTruthyFlag(conn.paused_by_global)")
    expect(source).toContain("isTruthyFlag(conn.paused_preset_by_global)")
    expect(source).toContain("const stateSwitchVersion = await allocateStateSwitchVersion(conn.id, conn)")
    expect(source).toContain('state_switch_action: "global_start"')
    expect(source).not.toContain('conn.is_assigned === "1" && conn.is_enabled_dashboard === "1"')
    expect(source).toContain("if (startedLocally) startedConnections.push(conn.id)")
    expect(source).not.toContain("            startedConnections.push(conn.id)")
    expect(source).not.toContain("Ensure live trade is enabled")
    expect(source).not.toContain("cleared stale block so exchange orders can proceed")
    expect(source).not.toMatch(/\.\.\.liveTradeUpdate,[\s\S]{0,160}is_live_trade:\s*"1"/)
    expect(source.indexOf("await updateConnectionState(conn.id, updatedConn")).toBeLessThan(
      source.lastIndexOf("await coordinator.startAll()"),
    )
    const startAll = coordinatorSource.slice(
      coordinatorSource.indexOf("async startAll(): Promise<void>"),
      coordinatorSource.indexOf("ensureBackgroundTimers(): void"),
    )
    expect(startAll).toContain("processing start must preserve both requested and effective state")
    expect(startAll).not.toContain("shouldAutoEnableLiveTrade")
    expect(startAll).not.toContain("auto_live_trade_enabled")
    expect(startAll).not.toContain('live_trade_requested: "1"')
  })

  test("stopEngine runtime cleanup preserves Main Connection assignment fields", () => {
    const source = read("lib/trade-engine.ts")
    const cleanupStart = source.indexOf("private async cleanupStoppedRuntimeState")
    expect(cleanupStart).toBeGreaterThan(0)
    const cleanup = source.slice(cleanupStart, source.indexOf("\n  /**", cleanupStart + 1))

    expect(cleanup).toContain("engine_is_running")
    expect(cleanup).toContain("status: \"stopped\"")
    expect(cleanup).not.toMatch(/is_active_inserted\s*:/)
    expect(cleanup).not.toMatch(/is_active\s*:/)
    expect(cleanup).not.toMatch(/is_assigned\s*:/)
    expect(cleanup).not.toMatch(/is_dashboard_inserted\s*:/)
  })

  test("QuickStart symbol totals are epoch-owned to reject stale workers after processing starts", () => {
    const quickStart = read("app/api/trade-engine/quick-start/route.ts")
    const processor = read("lib/trade-engine/config-set-processor.ts")
    const engineManager = read("lib/trade-engine/engine-manager.ts")

    expect(quickStart).toContain("symbol_selection_epoch")
    expect(quickStart).toContain("quickstart_symbol_count")
    expect(processor).toContain("stillOwnsCurrentSelection")
    expect(processor).toContain("ownsCanonicalSymbolSelectionEpoch")
    expect(engineManager).toContain("ownsCanonicalSymbolSelectionEpoch")
  })

  test("settings save marks dirty, invalidates strategy/coordination caches, and triggers immediate processing", () => {
    const coordinator = read("lib/settings-coordinator.ts")
    const recoordinator = read("lib/connection-recoordinator.ts")

    expect(coordinator).toContain("settings:dirty:${connectionId}")
    expect(recoordinator).toContain("invalidateStrategyAndCoordinationCaches")
    expect(recoordinator).toContain("applyPendingChangesNow")
    const settingsCoordinator = read("lib/settings-coordinator.ts")
    expect(settingsCoordinator).toContain("settings:settings_change:${connectionId}")
    expect(settingsCoordinator).not.toContain("setSettings(`settings_change:${connectionId}`, null)")
    expect(recoordinator).toContain("ProfitFactor")
    expect(recoordinator).toContain("Drawdown")
    expect(recoordinator).toContain("variant")
    expect(recoordinator).toContain("axis")
  })

  test("Preset Trade intent survives infrastructure blocks and auto-recovers after settings become valid", () => {
    const route = read("app/api/settings/connections/[id]/preset-toggle/route.ts")
    const recoordinator = read("lib/connection-recoordinator.ts")
    const engineStates = read("app/api/connections/[id]/engine-states/route.ts")
    const activeCard = read("components/dashboard/active-connection-card.tsx")

    expect(route).toContain('preset_trade_requested: toRedisFlag(presetTradeRequested)')
    expect(route).toContain('is_preset_trade: toRedisFlag(presetTradeEffective)')
    expect(route).toContain('evaluateRealTradeReadiness({')
    expect(route).toContain('}, "preset")')
    expect(route).not.toContain('error: "API credentials required for live trading"')
    expect(recoordinator).toContain("Preset Trade unblocked")
    expect(recoordinator).toContain('preset_trade_blocked_reason: ""')
    expect(recoordinator).toContain('"preset",')
    expect(engineStates).toContain("presetReadiness.requested")
    expect(activeCard).toContain("preset_trade_requested")
  })

  test("Preset UI exposes persisted historical diagrams, defaults, and the correct shared-engine assignments", () => {
    const page = read("app/presets/page.tsx")
    const optimizer = read("lib/preset-optimizer.ts")
    const presetToggle = read("app/api/settings/connections/[id]/preset-toggle/route.ts")
    const mainToggle = read("app/api/settings/connections/[id]/live-trade/route.ts")
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")

    expect(page).toContain("function PresetDailyDiagram")
    expect(page).toContain("Daily PositionCost coordinate")
    expect(page).toContain("Realised PF")
    expect(page).toContain("Position cost")
    expect(page).toContain("Win / Loss")
    expect(page).toContain("Drawdown time")
    expect(page).toContain("Auto-select best per symbol/type")
    expect(page).toContain("Block Strategy Type · Adjust")
    expect(page).toContain("general volume × ratio")
    expect(page).toContain("each exchange order sends only the still-missing delta")
    expect(page).toContain("function SliderField")
    expect(page).toContain('<SliderField label="ProfitFactor factor"')
    expect(page).toContain('min={0.2} max={5} step={0.1}')
    expect(page).toContain("Below threshold")
    expect(page).toContain("/api/preset-optimizer")
    expect(page).toContain("const controller = new AbortController()")
    expect(page).toContain("await loadOverview(true, controller.signal)")
    expect(optimizer).toContain("historyDays: 14")
    expect(optimizer).toContain("presetsPerSymbol: 4")
    expect(optimizer).toContain("minProfitFactor: REALIZED_PROFIT_FACTOR_MIN_DEFAULT")
    expect(optimizer).toContain("maxDrawdownHours: 5")
    expect(optimizer).toContain("blockMaxStack: 12")
    expect(optimizer).toContain("blockVolumeRatio: 1")
    expect(optimizer).toContain("blockProfitFactorRatio: 0.8")
    expect(optimizer).toContain("evenly-spaced quantiles")
    expect(optimizer).toContain("Release both larger reference arrays")
    expect(optimizer).toContain("one-active-position-per-symbol/direction constraint")
    const presetStore = read("lib/preset-store.ts")
    expect(presetStore).toContain("persistConnectionBlockSettings")
    expect(presetStore).toContain("variantBlockEnabled: String(settings.blockEnabled)")
    expect(presetStore).toContain("Preset is not eligible for live selection")
    expect(presetToggle).toContain('engine_type: "main"')
    expect(presetToggle).toContain("one shared Main progression")
    expect(mainToggle).toContain('engine_type: "main"')
    expect(liveStage).toContain('type LiveExecutionIntent = "main" | "preset" | "signal"')
    expect(liveStage).toContain("applySelectedPresetToRealPosition")
  })

  test("legacy Preset CRUD and test paths cannot reintroduce sampled indication or stage grids", () => {
    const defaults = read("lib/preset-crud-defaults.ts")
    const dialog = read("components/presets/preset-dialog.tsx")
    const generator = read("lib/preset-config-generator.ts")
    const tester = read("lib/preset-tester.ts")
    const testRoute = read("app/api/presets/[id]/test/route.ts")

    expect(defaults).toContain("...COMMON_INDICATOR_TYPES")
    expect(defaults).toContain('\"signal\"')
    expect(defaults).toContain('\"live\"')
    expect(defaults).toContain("Array.from({ length: 29 }")
    expect(dialog).toContain("PRESET_INDICATION_GROUPS")
    expect(dialog).toContain("PRESET_DEFAULT_INDICATION_RANGES")
    expect(generator).not.toContain("maxConfigs")
    expect(generator).not.toContain("configurations.slice")
    expect(testRoute).not.toContain("generateAllConfigurations(testSymbols, indicatorConfigs, 500)")
    expect(testRoute).not.toContain("validConfigs.slice(0, 100)")
    expect(testRoute).toContain("mapWithConcurrency(validConfigs, 8")
    expect(tester).toContain("mapWithConcurrency(configurations, 8")
  })

  test("every connection creation and legacy settings dialog persists the canonical four-stage ratio contract", () => {
    const createDialog = read("components/settings/exchange-connection-dialog.tsx")
    const legacySettingsDialog = read("components/settings/exchange-connection-settings-dialog.tsx")

    for (const source of [createDialog, legacySettingsDialog]) {
      expect(source).toContain("MAIN_TRADE_BASE_PF_RATIO_DEFAULT")
      expect(source).toContain("MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT")
      expect(source).toContain("liveTradeProfitFactorMinLive")
      expect(source).toContain("presetTradeProfitFactorMinLive")
      expect(source).toContain("min_profit_factor")
      expect(source).not.toContain("liveTradeProfitFactorMinBase: 0.6")
      expect(source).not.toContain("presetTradeProfitFactorMinBase: 0.6")
    }
    expect(createDialog).toContain("indicationTimeoutMs: 250")
    expect(createDialog).toContain("indicationSettings?.direction?.timeout ?? 0.25")
    expect(legacySettingsDialog).toContain('normalizeMainTradeStagePfRatio("live"')
    expect(legacySettingsDialog).toContain("MAIN_TRADE_PF_RATIO_STEP")
  })

  test("disabling one connection does not stop the global coordinator", () => {
    const source = read("app/api/settings/connections/[id]/toggle-dashboard/route.ts")
    const disableBranch = source.slice(
      source.indexOf('} else if (engineAction === "stop")'),
      source.indexOf("const wasChange", source.indexOf('} else if (engineAction === "stop")')),
    )

    expect(disableBranch).toContain("Only /api/trade-engine/stop owns global shutdown")
    expect(disableBranch).toContain('status: disableGlobalState?.status || "running"')
    expect(disableBranch).not.toContain('if (activeCount === 0) return "stopped"')
  })

  test("explicit dashboard enable queues then immediately reconciles production starts", () => {
    const source = read("app/api/settings/connections/[id]/toggle-dashboard/route.ts")
    const startBranch = source.slice(
      source.indexOf('if (engineAction === "start")'),
      source.indexOf('} else if (engineAction === "stop")'),
    )

    expect(startBranch).toContain('status: "running"')
    expect(startBranch).toContain('coordinator_ready: "true"')
    expect(startBranch).toContain("const engineStarted = await coordinator.startEngine")
    expect(startBranch).toContain('process.env.ALLOW_API_TRADE_ENGINE_FOREGROUND === "1"')
    expect(startBranch).toContain('process.env.ENABLE_TRADE_ENGINE_IN_PROCESS === "1"')
    expect(startBranch).toContain('engineStatus = "queued"')
    expect(startBranch).toContain('runTradeEngineHealingSweep({ isStartup: false })')
    expect(startBranch).toContain('engineStatus = "started"')
    expect(startBranch).toContain('allowInProcessStart: true')
    expect(startBranch).not.toContain("setImmediate")
  })

  test("indication windows use idempotent per-symbol fields", () => {
    const processor = read("lib/indication-sets-processor.ts")
    const cron = read("app/api/cron/generate-indications/route.ts")
    const tracking = read("lib/detailed-tracking.ts")

    expect(processor).toContain("[`${symbol}:move`]: String(moveQ)")
    expect(processor).not.toContain('pipe.hincrby(w5Key,  "move"')
    expect(cron).toContain("runIndStratCycle(connectionId, symbol, \"realtime\"")
    expect(cron).toContain("ensureCurrentMarketDataCandle(symbol, client, connectionId, connection)")
    expect(cron).toContain("marketDataKey(symbol, \"\", connectionId)")
    expect(cron).toContain("if (isForcedSimulation()) return marketType ===")
    expect(cron).toContain("if (isForcedSimulation()) return null")
    expect(tracking).toContain("aggregateWindowByType")
    expect(tracking).toContain("prefer the per-symbol snapshot")
    expect(tracking).toContain("if (idx <= 0 && hasSymbolField[type]) continue")
  })


  test("QuickStart resolves four-symbol volatility order without HTTP self-fetch", () => {
    const source = read("app/api/trade-engine/quick-start/route.ts")

    expect(source).toContain('import { fetchTopSymbols, normaliseSort } from "@/lib/top-symbols"')
    expect(source).toContain('normaliseSort(body.symbolOrder || body.symbol_order || "volatility_1h")')
    expect(source).toContain("fetchTopSymbols(exchangeName, requestedCount, requestedSymbolOrder)")
    expect(source).toContain("symbol_order: requestedSymbolOrder")
    expect(source).toContain("dev_symbol_count_override: String(symbols.length)")
    expect(source).not.toContain("/api/exchange/${exchangeName}/top-symbols?limit=${requestedCount}&sort=volatility")
  })

  test("live-trade enable queues then immediately reconciles production starts", () => {
    const source = read("app/api/settings/connections/[id]/live-trade/route.ts")

    expect(source).toContain('export const runtime = "nodejs"')
    expect(source).toContain("const engineStarted = await coordinator.startEngine")
    expect(source).toContain('process.env.ALLOW_API_TRADE_ENGINE_FOREGROUND === "1"')
    expect(source).toContain('process.env.ENABLE_TRADE_ENGINE_IN_PROCESS === "1"')
    expect(source).toContain('reason: "live_trade_enable"')
    expect(source).toContain('runTradeEngineHealingSweep({ isStartup: false })')
    expect(source).toContain('engineStatus = "running"')
    expect(source).toContain('allowInProcessStart: true')
    expect(source).toContain('live_trade_requested: "1"')
    expect(source).toContain('mode: liveTradeEffective ? "live" : "live_requested"')
    expect(source).not.toContain("setImmediate")
  })


  test("live requested mode never bypasses configured Main and Real evaluation gates", () => {
    const source = read("lib/strategy-coordinator.ts")

    expect(source).toContain("const mainMinPos = this._coordinationSettings.mainEvalPosCount")
    expect(source).toContain("const realMinPos = this._coordinationSettings.realEvalPosCount")
    expect(source).toContain("Live enablement never changes Strategy validation")
    expect(source).not.toContain("const mainMinPos = liveQuickstartOn")
    expect(source).not.toContain("const relaxed = Math.min(realMinPF")
  })



  test("live position APIs separate real exchange data from simulated history", () => {
    const liveRoute = read("app/api/trading/live-positions/route.ts")
    const exchangeRoute = read("app/api/exchange-positions/route.ts")
    const tradingStatsRoute = read("app/api/trading/stats/route.ts")
    const symbolStatsRoute = read("app/api/exchange-positions/symbols-stats/route.ts")

    expect(liveRoute).toContain('searchParams.get("connection_id") || searchParams.get("connectionId")')
    expect(liveRoute).toContain("realPositions")
    expect(liveRoute).toContain("simulatedPositions")
    expect(liveRoute).toContain("dataIntegrity")
    expect(liveRoute).toContain("effectivePnL")
    expect(exchangeRoute).toContain('searchParams.get("connection_id") || searchParams.get("connectionId")')
    expect(exchangeRoute).toContain('source: "exchange_position_manager"')
    expect(tradingStatsRoute).toContain('source: "executed_exchange_positions_and_live_exchange_snapshot"')
    expect(tradingStatsRoute).toContain("simulatedExcluded: true")
    expect(tradingStatsRoute).not.toContain("FROM pseudo_positions")
    expect(symbolStatsRoute).toContain('source: "exchange_live_positions"')
    expect(symbolStatsRoute).not.toContain("For now, return mock symbols")
  })

  test("statistics page renders real open and closed exchange data without demo fallbacks", () => {
    const source = read("app/statistics/page.tsx")
    const history = read("lib/trade-history.ts")

    expect(source).toContain("/api/data/positions?connectionId=")
    expect(source).toContain("/api/trading/trade-history?connection_id=")
    expect(source).toContain("statisticsHistoryTupleToTradingPosition")
    expect(history).toContain("realized_pnl: realizedPnl")
    expect(history).toContain("fees_paid: Math.abs(fees)")
    expect(source).toContain("No exchange data yet")
    expect(source).not.toContain("generateMockPositions")
    expect(source).not.toContain("Using Mock Data")
    expect(source).not.toContain("if (hasRealConnections) {")
  })

  test("init-status reports exact key cardinality without allocating a full key inventory", () => {
    const source = read("app/api/system/init-status/route.ts")

    expect(source).toContain("await client.dbSize()")
    expect(source).not.toContain('client.keys("*")')
  })

  test("pseudo position close PnL and PF inputs use the stored one-time position cost", () => {
    const helper = read("lib/pseudo-position-costs.ts")
    const pseudoManager = read("lib/trade-engine/pseudo-position-manager.ts")
    const posHistory = read("lib/pos-history.ts")
    const configProcessor = read("lib/trade-engine/config-set-processor.ts")
    const strategyConfig = read("lib/strategy-config-manager.ts")

    expect(helper).toContain("PSEUDO_POSITION_CLOSE_COST_RATIO = 0.001")
    expect(helper).toContain("normalizePositionCostPercent")
    expect(helper).toContain("const netPnl = grossPnl - positionCost")
    expect(helper).toContain("netPnlPct")
    expect(pseudoManager).toContain("positionCostPct: configuredPositionCostPct")
    expect(pseudoManager).toContain("realized_pnl: String(pnl)")
    expect(pseudoManager).toContain("gross_realized_pnl: String(grossPnl)")
    expect(pseudoManager).toContain("position_cost_ratio: String(positionCostPct / 100)")
    expect(posHistory).toContain("PnL is already cost-adjusted")
    expect(configProcessor).toContain("netPnlPct")
    expect(strategyConfig).toContain("calculatePseudoClosePnl")
  })

  test("simulated live stage reuses ordinary slots and accumulates Special without per-cycle log churn", () => {
    const source = read("lib/trade-engine/stages/live-stage.ts")

    expect(source).toContain("existingSimulatedSlot")
    expect(source).toContain("if (existingSimulatedSlot) {")
    expect(source).toContain("if (isSpecialPosition) {")
    expect(source).toContain("return accumulateIntoSimulatedPosition(")
    expect(source).toContain("return existingSimulatedSlot")
    expect(source).not.toContain("simulated slot already open")
  })

  test("runtime never truncates the operator-selected symbol basket", () => {
    const source = read("lib/trade-engine/engine-manager.ts")
    const defaults = read("lib/symbol-selection-defaults.ts")

    expect(source).not.toContain("getExplicitLocalSymbolCap")
    expect(defaults).toContain("DEFAULT_SYMBOL_COUNT = CANONICAL_FORCED_SYMBOLS.length")
    expect(source).toContain("Explicit operator symbols are authoritative in every runtime")
    expect(source).not.toContain("dev-symbol-cap")
  })

  test("progression trade counters clamp impossible success rates after resets", () => {
    const source = read("lib/progression-state-manager.ts")

    expect(source).toContain("boundedSuccessfulTrades")
    expect(source).toContain("maxPossibleSuccessfulTrades")
    expect(source).toContain("Math.max(0, newTotalTrades - 1)")
    expect(source).toContain("tradeUpdate.successful_trades = String(boundedSuccessfulTrades)")
    expect(source).toContain("Success Rate: ${tradeSuccessRate.toFixed(1)}%")
  })

  test("startEngine leaves healthy cross-worker startup locks untouched", () => {
    const source = read("lib/trade-engine.ts")
    const lockBranch = source.slice(
      source.indexOf("Cannot start engine ${connectionId}"),
      source.indexOf("lockHandle = acquired.handle"),
    )

    expect(lockBranch).toContain("Leaving existing owner untouched")
    expect(lockBranch).toContain("return false")
    expect(lockBranch).not.toContain("forceBreakProgressionLock")
    expect(lockBranch).not.toContain("stopEngine(connectionId)")
  })

  test("startMissingEngines keeps the Main pipeline running without credentials", () => {
    const source = read("lib/trade-engine.ts")

    expect(source).toContain("engine_starting_without_credentials")
    expect(source).toContain("exchange order placement remains credential-gated")
    expect(source).not.toContain("Engine start skipped - missing credentials")
  })

  test("base pseudo-position steps keep the 2-step floor and default to 5", () => {
    const manager = read("lib/indication-config-manager.ts")
    const constants = read("lib/constants.ts")
    const settingsTab = read("components/settings/tabs/strategy-tab.tsx")
    const coordinationSection = read("components/settings/strategy-coordination-section.tsx")

    expect(constants).toContain("export const MIN_BASE_STEP = 2")
    expect(constants).toContain("export const DEFAULT_BASE_MIN_STEP = 5")
    expect(manager).toContain("MAX_BASE_STEP - minStep + 1")
    expect(manager).toContain("(_, index) => index + minStep")
    expect(settingsTab).toContain("Steps generated: 2, 3, 4, …, 29, 30")
    expect(coordinationSection).toContain("min={MIN_BASE_STEP}")
    expect(coordinationSection).toContain("max={MAX_BASE_STEP}")
    expect(coordinationSection).toContain("all {MAX_BASE_STEP - value.minStep + 1} windows")
  })

  test("Direct-Trade capacity and bounded PositionCost TP-grid defaults stay aligned", () => {
    const limits = read("lib/direct-trade-limits.ts")
    const route = read("app/api/trade-engine/direct-trade/route.ts")
    const dashboard = read("components/dashboard/direct-trade-section.tsx")
    const settings = read("components/settings/direct-trade-settings.tsx")
    const processor = read("scripts/direct-trade-processor.mjs")
    const matrix = read("scripts/test-direct-trade-matrix.cjs")

    expect(limits).toContain("DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_SYMBOL = 12")
    expect(limits).toContain("DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_DIRECTION = 6")
    expect(route).toContain("maxPositionsPerSymbol: DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_SYMBOL")
    expect(route).toContain("maxPositionsPerDirection: DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_DIRECTION")
    expect(dashboard).toContain("max={300}")
    expect(dashboard).toContain("pendingConfigKeysRef")
    expect(dashboard).toContain("new Map<string")
    expect(dashboard).toContain("pendingConfigRef.current.set(scopeKey")
    expect(dashboard).toContain("updateScopeConnectionId")
    expect(dashboard).toContain("{ connectionId: updateScopeConnectionId }")
    expect(dashboard).toContain("mergePendingDirectTradeConfig")
    expect(dashboard).toContain("setCalculationProgress(data.calculationProgress")
    expect(settings).toContain("maxPositionsPerSymbol: DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_SYMBOL")
    expect(settings).toContain("maxPositionsPerDirection: DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_DIRECTION")
    expect(processor).toContain("maxPositionsPerSymbol: 12")
    expect(processor).toContain("maxPositionsPerDirection: 6")
    expect(matrix).toContain("DIRECT_TRADE_MATRIX_MAX_PER_SYMBOL) || 12")
    expect(matrix).toContain("DIRECT_TRADE_MATRIX_MAX_PER_DIRECTION) || 6")
    expect(matrix).toContain("buildDirectTradeTakeProfitPositionCostRatios([5, 10], 5)")
    expect(route).toContain("takeProfitRatioRange: DIRECT_TRADE_TAKE_PROFIT_RATIO_DEFAULT_RANGE")
    expect(route).toContain("takeProfitRatioStep: DIRECT_TRADE_TAKE_PROFIT_RATIO_STEP_DEFAULT")
    expect(dashboard).toContain('aria-label="Direct-Trade take-profit PositionCost range"')
    expect(dashboard).toContain("minStepsBetweenThumbs={0}")
    expect(dashboard).toContain('aria-label="Direct-Trade take-profit Set-creation step"')
    expect(settings).toContain("TP Set-creation step · × PositionCost")
    expect(settings).toContain('min={DIRECT_TRADE_VOLUME_FACTOR_MIN}')
    expect(settings).toContain('max={DIRECT_TRADE_VOLUME_FACTOR_MAX}')
    expect(settings).toContain('step={0.1}')
    expect(settings).toContain('aria-label="Direct-Trade trailing minimum take-profit PositionCost ratio"')
    expect(settings).toContain('aria-label="Direct-Trade take-profit PositionCost range"')
    expect(settings).toContain("minStepsBetweenThumbs={0}")
    expect(processor).toContain("takeProfitRatioStep: state.takeProfitRatioStep")
    expect(processor).toContain("DIRECT_TRADE_EFFECTIVE_VOLUME_RATIO = 0.2")
    expect(processor).toContain("DIRECT_TRADE_BASE_NOTIONAL_PER_FACTOR_USDT = 5")
    expect(processor).toContain("normalizeDirectTradeVolumeFactor(state.minVolFactor)")
    expect(processor).toContain("takeProfitPositionCostRatio < normalizeDirectTradeTrailingMinTakeProfitRatio")
    expect(route).toContain("DIRECT_TRADE_PROCESSING_INTERVAL_DEFAULT_MS = 280")
    expect(route).toContain("clampDirectTradeVolumeFactor")
    expect(route).toContain("requestedDirectTradeVolumeFactor")
    expect(route).toContain("normaliseDirectTradeTrailingMinTakeProfitRatio")
    expect(dashboard).toContain('min={DIRECT_TRADE_VOLUME_FACTOR_MIN}')
    expect(dashboard).toContain('max={DIRECT_TRADE_VOLUME_FACTOR_MAX}')
    expect(dashboard).toContain('aria-label="Direct-Trade trailing minimum take-profit PositionCost ratio"')
    expect(processor).toContain('DIRECT_TRADE_SYNTHETIC_MARKET_DATA === "1"')
    expect(processor).toContain("Refusing unverified BingX public host")
    expect(processor).toContain('"open-api.bingx.com"')
    expect(processor).not.toContain("open-api.bingx.pro/openApi/swap/v2/quote/ticker")
  })

  test("Direct-Trade live control orders persist and reconcile one stable economic intent", () => {
    const processor = read("scripts/direct-trade-processor.mjs")
    const service = read("lib/live-order-service.ts")
    const gateway = read("app/api/trade-engine/direct-trade/order/route.ts")
    const recoverySoak = read("scripts/run-direct-trade-recovery-soak.mjs")
    const livePreflight = read("scripts/test-direct-trade-live-preflight.mjs")

    expect(service).toContain("live:direct_order_control:")
    expect(service).toContain("{ NX: true, EX: DIRECT_ORDER_CONTROL_TTL_SECONDS }")
    expect(service).toContain("reconcileDirectOrderControl")
    expect(service).toContain("getOrderDetails(record.symbol, record.orderId || undefined, exchangeClientOrderId)")
    expect(service).toContain("idempotentReplay: true")
    expect(processor).toContain('status: state.liveMode ? "opening" : "open"')
    expect(processor).toContain("if (!(await persistState())) return position")
    expect(processor).toContain("position.openControlId")
    expect(processor).toContain("pos.closeControlId")
    expect(processor).toContain("processPendingAccumulationOrders")
    expect(processor).toContain("reconcileOneIncompleteLiveAccounting")
    expect(processor).toContain("reconcileOneIncompleteLiveCloseAccounting")
    expect(processor).toContain("backfillLegacyDirectTradeLegControlIds")
    expect(processor).toContain('action: "processor-heartbeat"')
    expect(processor).toContain("DIRECT_TRADE_PROCESSOR_HEARTBEAT_INTERVAL_MS = 1_500")
    expect(processor).toContain('position.pnlAccountingComplete === true')
    expect(processor).toContain("recordAccountedConfigOutcome")
    expect(processor).not.toContain("Date.now() - waitStartedAt < 15_000")
    expect(processor).toContain("if (pos.blockPendingControlId || pos.dcaPendingControlId) continue")
    expect(processor).toContain('if (pos.mode === "live")')
    expect(processor).not.toContain('if (pos.mode === "live" && pos.orderId)')
    expect(processor).toContain("position.dcaLastFailureAt = Date.now()")
    expect(processor).toContain("pos.closeRetryAfter = Date.now() + 1_000")
    expect(processor).toContain('p.status === "open_failed"')
    expect(processor).not.toContain("pos.closeAttempt =")
    expect(gateway).toContain("durableControlExists")
    expect(gateway).toContain("settlement: result.settlement")
    expect(gateway).toContain("countAccumulated: kind === \"open\" && stage === \"accumulation\"")
    expect(recoverySoak).toContain('const recoveryDistDir = `.next-recovery-${process.pid}`')
    expect(recoverySoak).toContain("NEXT_DIST_DIR: recoveryDistDir")
    expect(recoverySoak).toContain("rmSync(recoveryDistDir, { recursive: true, force: true })")
    expect(recoverySoak).toContain("sourceMetadataSnapshots")
    expect(recoverySoak).toContain("writeFileSync(file, contents)")
    expect(livePreflight).toContain('const preflightDistDir = `.next-live-preflight-${process.pid}`')
    expect(livePreflight).toContain("NEXT_DIST_DIR: preflightDistDir")
    expect(livePreflight).toContain("rmSync(preflightDistDir, { recursive: true, force: true })")
    expect(livePreflight).toContain("sourceMetadataSnapshots")
    expect(livePreflight).toContain('const testConnectionId = "bingx-x02"')
    expect(livePreflight).toContain('"--connection-id"')
    expect(livePreflight).toContain("testConnectionId,")
    expect(livePreflight).toContain("status?connectionId=${encodeURIComponent(testConnectionId)}")
    expect(livePreflight).toContain("process.kill(-child.pid, 0)")
    expect(livePreflight.match(/rmSync\(preflightDistDir/g)?.length).toBeGreaterThanOrEqual(3)
    expect(livePreflight).toContain("Signal only that exact group")
    expect(livePreflight).not.toContain("function listeningProcessIds")
    expect(livePreflight).not.toContain("function nextServerProcessIds")
    expect(livePreflight).not.toContain("function preflightProcessIds")
    expect(livePreflight).toContain("NEXT_DIST_DIR: preflightDistDir")
  })

  test("standard, axis and trailing sets are ordered before adjust variants", () => {
    const source = read("lib/strategy-coordinator.ts")

    expect(source).toContain("Operator rule: process the Standard strategy outputs first")
    expect(source).toContain("const mainSetOrder = (set: StrategySet): number")
    expect(source).toContain('if (set.variant === "trailing") return 2')
    expect(source).toContain('if (set.variant === "block") return 3')
    expect(source).toContain('if (set.variant === "dca") return 4')
    expect(source).toContain("mainSets.sort((a, b) => mainSetOrder(a) - mainSetOrder(b))")
  })

  test("strategy flow batch keeps engine control routes responsive under 8-symbol BingX load", () => {
    const source = read("lib/strategy-coordinator.ts")
    const engineManager = read("lib/trade-engine/engine-manager.ts")
    const migrations = read("lib/redis-migrations.ts")

    expect(source).toContain("STRATEGY_FLOW_SYMBOL_CONCURRENCY")
    expect(source).toContain("getStrategyFlowSymbolConcurrency")
    expect(source).toContain("strategy_flow_symbol_concurrency_${mode}")
    expect(source).toContain("const symbolConcurrency = Math.max(")
    expect(source).toContain("Math.min(")
    expect(source).toContain("6,")
    expect(source).toContain("getRuntimeCapabilityConcurrency")
    expect(source).toContain("getConcurrency: () => Math.min(")
    expect(source).toContain("const evaluated = await mapWithConcurrency(")
    expect(source).toMatch(/stage: "base"[\s\S]{0,240}setImmediate/)
    expect(source).toMatch(/stage: "main"[\s\S]{0,240}setImmediate/)
    expect(source).toMatch(/stage: "real"[\s\S]{0,240}setImmediate/)
    expect(source).not.toContain("const SYMBOL_CONCURRENCY = 6")
    expect(engineManager).toContain("function getStrategySymbolConcurrency")
    expect(engineManager).toContain('["STRATEGY_FLOW_SYMBOL_CONCURRENCY"]')
    expect(engineManager).toContain("getStrategySymbolConcurrency(symbols.length)")
    expect(migrations).toContain("067-strategy-flow-concurrency-performance-defaults")
    expect(migrations).toContain("system:database:coordination:performance")
    expect(migrations).toContain('strategy_flow_stage_yield_enabled: existing.strategy_flow_stage_yield_enabled || "1"')
  })

  test("trailing is coordinated at Base and is not emitted as a Main adjust variant", () => {
    const source = read("lib/strategy-coordinator.ts")

    expect(source).toContain("trailing is NOT a")
    expect(source).toContain("Main-stage Adjust strategy")
    expect(source).toContain("Trailing is coordinated at BASE")
    expect(source).toContain('if (p.name === "trailing") return false')
    expect(source).toContain('const variantsForThisBase = activeVariants.filter((p) => p.name !== "block")')
    expect(source).toContain("do not special-case trailingProfile here")
    expect(source).toContain("legacy placeholder only; real trailing Sets are created at BASE")
  })

  test("block overlays completed-position counts and active-position exposure at Real stage", () => {
    const source = read("lib/strategy-coordinator.ts")
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")
    const statsRoute = read("app/api/connections/progression/[id]/stats/route.ts")

    expect(source).toContain("Build and validate the complete count ladder before Live selection")
    expect(source).toContain('activeVariants.filter((p) => p.name !== "block")')
    expect(source).toContain("buildIndependentBlockCountOverlaysForReal")
    expect(source).toContain("blockMaxStack:    12")
    expect(source).toContain("Math.max(1, Math.min(BLOCK_COUNT_MAX, this._coordinationSettings.blockMaxStack | 0))")
    expect(source).toContain("for (let blockCount = 1; blockCount <= maxStack; blockCount++)")
    expect(source).toContain("const setKey = `${source.setKey}#block:${blockCount}`")
    expect(source).toContain("!isPositionCountStrategySet(set)")
    expect(source).toContain("collectActivePositionCountsBySymbol")
    expect(source).toContain("including individual/combined Pos-Count rows")
    expect(source).toContain("...(coordIndex ? [...coordIndex.base.byKey.values()] : [])")
    expect(source).toContain("const exactWindows = await this.getStrategySetWindowBatch(")
    expect(source).toContain("getStrategySetClosedResultKeys")
    expect(source).toContain("exhaustive behavior rather than changing PF/DDT calculations")
    expect(source).toContain("sourceOffset += sourceBatchSize")
    expect(source).toContain("logical_emitted")
    expect(source).toContain("materialization_next_cursor")
    expect(source).toContain("calculateBlockMinimumProfitFactor(")
    expect(source).toContain("blockProfitFactorRatio: profitFactorRatio")
    expect(source).toContain("const dispatchCandidates = qualifying")
    expect(source).toContain("Active Real/Live-position Block handling belongs to REAL")
    expect(source).toContain("buildActiveRealBlockOverlaysForReal")
    expect(source).toContain("blockActiveRealEnabled && !this._coordinationSettings.blockActiveLiveEnabled")
    expect(source).toContain('scope === "global"')
    expect(source).toContain("`${source.setKey}#block:active:${boundedCount}`")
    expect(source).toContain("`${source.setKey}#block:set:${boundedCount}`")
    expect(source).toContain("getStrategySetLedgerBatch(")
    expect(statsRoute).toContain("const realValidatedActivePositions = realOpen || realDetailRunning || 0")
    expect(source).toContain("calculateBlockVolumeMultiplier(")
    expect(source).toContain("variantSizeMultiplier: blockCalculatedVolumeMultiplier")
    expect(source).toContain("blockBaseVolumeMultiplier")
    expect(source).toContain("blockVolumeRatio: ratio")
    expect(source).toContain("variant: \"block\"")
    expect(source).toContain("resolveMirroredActiveBlockCount({")
    expect(source).toContain("const activeCount = activeCombinedByDir[dir]")
    expect(source).toContain("perSymbolLiveOpenByDir")
    expect(source).toContain("getUnavailableBlockKeys(symbol)")
    expect(source).toContain("limitLiveDispatchCandidatesFairly(")
    expect(source).toContain("dispatchSets.sort((a, b) => dispatchOrder(a) - dispatchOrder(b))")
    expect(liveStage).toContain("Block Set ${realPosition.setKey || \"unknown\"} waits for authoritative parent fill")
    expect(liveStage).toContain("real?.sizeMultiplier ?? existing.sizeMultiplier")
    expect(liveStage).toContain("calculateBlockRemainingAddQuantity(")
    expect(liveStage).toContain("calculateConfirmedBlockAddQuantity(existing.blockLegs)")
    expect(liveStage).toContain("immutable general/Base quantity")
    expect(liveStage).toContain("Only confirmed Block legs consume that")
    expect(liveStage).toContain("targetSatisfied: blockTargetSatisfied")
    expect(liveStage).toContain("appliedFilledQuantity")
    expect(liveStage).toContain("exact fill deferred to reconciliation")
    expect(liveStage).toContain('p.status === "simulated"')
    expect(liveStage).toContain("accumulateIntoSimulatedPosition")
    expect(liveStage).toContain("Block and DCA are adjustment-only variants")
    expect(liveStage).toContain('mutatePositionWithVersionCheck(existing, ["simulated"]')
  })

  test("block pause count ratio is persisted and clamped for strategy settings", () => {
    const section = read("components/settings/strategy-coordination-section.tsx")
    const route = read("app/api/settings/connections/[id]/settings/route.ts")
    const coordinator = read("lib/strategy-coordinator.ts")

    expect(section).toContain("blockPauseCountRatio: number")
    expect(section).toContain("blockActiveRealEnabled: boolean")
    expect(section).toContain("blockMaxStack:    12")
    expect(section).toContain("max={12}")
    expect(section).toContain("min={1}")
    expect(section).toContain("Pause Count Ratio")
    expect(section).toContain("Active Real Position Block")
    expect(route).toContain("flatKnobs.blockPauseCountRatio")
    expect(route).toContain("flatKnobs.blockActiveRealEnabled")
    expect(route).toContain("Math.min(BLOCK_COUNT_MAX, Math.max(1, Math.floor(bms)))")
    expect(coordinator).toContain("this._coordinationSettings.blockPauseCountRatio")
    expect(coordinator).toContain("this._coordinationSettings.blockActiveRealEnabled")
    expect(coordinator).toContain("Math.max(1, Math.min(4, Math.round(bpcr * 2) / 2))")
    expect(section).toContain("blockActiveLiveEnabled: boolean")
    expect(section).toContain("Pause Count Ratio")
    expect(section).toContain("Active Live Position Block")
    expect(route).toContain("flatKnobs.blockPauseCountRatio")
    expect(route).toContain("flatKnobs.blockActiveLiveEnabled")
    expect(coordinator).toContain("this._coordinationSettings.blockPauseCountRatio")
    expect(coordinator).toContain("this._coordinationSettings.blockActiveLiveEnabled")
    expect(coordinator).toContain("Math.max(1, Math.min(4, Math.round(bpcr * 2) / 2))")
  })

  test("production strategy fan-out is exhaustive while rotating work and caches remain bounded", () => {
    const source = read("lib/strategy-coordinator.ts")

    expect(source).not.toContain("STRATEGY_MAIN_AXIS_SETS_CEILING")
    expect(source).not.toContain("_boundedDynCeiling")
    expect(source).toContain("strategyBlockMaterializationBatchSize")
    expect(source).toContain("_independentBlockMaterializationCursorBySymbol")
    expect(source).toContain("Every unique qualifying row is evaluated at Real")
    expect(source).toContain("limitRealRowsForMaterialization(")
    expect(source).toContain('process.env.STRATEGY_REAL_SETS_CEILING || "0"')
    expect(source).toContain("private static readonly _AXIS_LRU_MAX = (() =>")
    expect(source).toContain("STRATEGY_VARIANT_BUILD_CONCURRENCY")
    expect(source).toContain("const buildTasks: Array<() => Promise<VariantBuildResult>>")
    expect(source).toContain("mapWithConcurrency(")
    expect(source).toContain("(task) => task()")
    expect(source).toContain("yieldEvery: STRATEGY_COOPERATIVE_YIELD_INTERVAL")
    expect(source).toContain("onProgress: () => assertStrategyGenerationCurrent(shouldContinue)")
    expect(source).toContain("await yieldStrategyScheduler(false, shouldContinue)")
    expect(source).not.toContain("const results = await Promise.all(buildTasks)")
    expect(source).toContain("liveSets.length <= fastPathLimit")
    expect(source).toContain("._lastRealSets[symbol] = liveSets")
    expect(source).toContain("._lastRealSetCounts[symbol] = realSets.length")
    expect(source).toContain("snapshotCoordIndexForLive(coordIndex, liveSets)")
    expect(source).not.toContain("._lastRealSets[symbol] = realSets")
    expect(source).not.toContain("snapshotCoordIndexForLive(coordIndex, realSets)")
  })

  test("historic and indication CPU loops use responsive default scheduling quanta", () => {
    const historic = read("lib/trade-engine/config-set-processor.ts")
    const indications = read("lib/indication-sets-processor.ts")
    const strategy = read("lib/strategy-coordinator.ts")
    const envExample = read(".env.example")

    expect(historic).toContain('process.env.PREHISTORIC_CALC_YIELD_EVERY || "256"')
    expect(indications).toContain('process.env.INDICATION_CANDIDATE_YIELD_EVERY || "4"')
    expect(indications).toContain('process.env.COMMON_INDICATION_CALC_BATCH_SIZE || "4"')
    expect(envExample).toContain("PREHISTORIC_CALC_YIELD_EVERY=256")
    expect(envExample).toContain("INDICATION_CANDIDATE_YIELD_EVERY=4")
    expect(envExample).toContain("COMMON_INDICATION_CALC_BATCH_SIZE=4")
    expect(envExample).toContain("STRATEGY_COOPERATIVE_YIELD_EVERY=64")
    expect(envExample).toContain("STRATEGY_AXIS_BASE_BATCH_SIZE=32")
    expect(envExample).toContain("STRATEGY_REDIS_HASH_WRITE_BATCH_SIZE=256")
    expect(envExample).toContain("STRATEGY_COOPERATIVE_TIME_SLICE_MS=8")
    expect(envExample).toContain("INDICATION_COOPERATIVE_TIME_SLICE_MS=8")
    expect(envExample).not.toContain("LIVE_DISPATCH_PER_CYCLE")
    expect(strategy).not.toContain("process.env.LIVE_DISPATCH_PER_CYCLE")
    expect(strategy).toContain("planLiveDispatchCandidatesFairly(")
    expect(strategy).toContain("no hidden per-symbol budget may defer otherwise eligible Sets")
    expect(strategy).not.toContain("LIVE_DISPATCH_HARD_MAX_PER_SYMBOL")
    expect(strategy).toContain("dispatch_deferred_count: String(dispatchPlan.deferred.length)")
    expect(strategy).toContain("dispatch_failed_to_open_count")
    expect(strategy).toContain("dispatch_duration_ms")
    expect(strategy).toContain('summarizeLiveDispatchRows(dispatchSets, "qualified_policy_enabled")')
    expect(strategy).toContain('persistUnavailableDispatch("connector_unavailable")')
    expect(strategy).toContain("fpCacheKey,\n            nextFpCache,\n            shouldContinue,")
    expect(strategy).toContain("targetKey,\n            netTargetWrites,\n            shouldContinue,")
  })

  test("routine engine memory collection cannot stop the UI event loop", () => {
    const engineManager = read("lib/trade-engine/engine-manager.ts")

    expect(engineManager).toContain('execution: "async"')
    expect(engineManager).toContain("monitor.gcInFlight = true")
    expect(engineManager).toContain("getStrategyMemoryCoordinationSnapshot().activeFlows > 0")
    expect(read("scripts/run-dev-preview-check.mjs")).toContain("CTS_NODE_HEAP_MB: String(devNodeHeapMb)")
    expect(read("scripts/run-dev-preview-check.mjs")).toContain("DEV_NODE_SEMI_SPACE_MB || 128")
    expect(read("scripts/run-dev-preview-check.mjs")).toContain("--max-semi-space-size=${devNodeSemiSpaceMb}")
    expect(read("scripts/run-dev-preview-check.mjs")).toContain("DEV_MAINTENANCE_GC_INTERVAL_MS")
    expect(read("lib/runtime-telemetry.ts")).toContain("memoryCollection")
    expect(read("lib/runtime-telemetry.ts")).toContain("strategyMemory")
    expect(read("scripts/verify-prod-soak.mjs")).toContain("memoryCollection: stats.runtime.memoryCollection")
    expect(read("scripts/verify-prod-soak.mjs")).toContain("strategyMemory: stats.runtime.strategyMemory")
    expect(engineManager).toContain('monitor.lastGCMode = "maintenance-async"')
    expect(engineManager).toContain('monitor.lastGCMode = "urgent-sync"')
    expect(engineManager).toContain("CTS_MAINTENANCE_GC_INTERVAL_MS")
    expect(engineManager).toContain(": 120_000")
    expect(read(".env.example")).toContain("CTS_MAINTENANCE_GC_INTERVAL_MS=120000")
    expect(engineManager).toContain("Never fall back to a surprise")
    const memoryGuard = read("lib/strategy-memory-guard.ts")
    expect(memoryGuard).toContain("resolveStrategyGcCooldownMs")
    expect(memoryGuard).toContain("CTS_STRATEGY_GC_ELEVATED_INTERVAL_MS")
    expect(memoryGuard).toContain('gc({ type: "major", execution: "async" })')
    expect(memoryGuard).toContain('level === "critical"')
  })

  test("coordinator startEngine allows explicit local takeover while passive production starts stay queued", () => {
    const source = read("lib/trade-engine.ts")

    expect(source).toContain("private canOwnEngineRuntime()")
    expect(source).toContain("hasExplicitServerlessForegroundOptIn")
    expect(source).toContain("isServerlessDeploymentRuntime")
    expect(source).toContain("isServerlessWorker && !explicitForegroundAllowed")
    expect(source).toContain("queued-only in this production API worker")
    expect(source).toContain("Leaving start request queued")
    expect(source).not.toContain("runningUnderProdStart")
  })

  test("self-hosted production progression remains enabled by default while Vercel stays opt-in", () => {
    const engineManager = read("lib/trade-engine/engine-manager.ts")
    const sharedPipeline = read("lib/trade-engine/shared-ind-strat-pipeline.ts")
    const indicationSets = read("lib/indication-sets-processor.ts")

    expect(engineManager).toContain('!isServerlessDeploymentRuntime() ||')
    expect(engineManager).toContain('process.env.ENABLE_API_REALTIME_PROGRESSION === "1"')
    expect(engineManager).toContain('process.env.ENABLE_API_LIVE_POSITIONS_SYNC === "1"')
    expect(engineManager).toContain('return process.env.NODE_ENV === "production" ? 90_000 : 180_000')
    expect(sharedPipeline).toContain('!isServerlessDeploymentRuntime() ||')
    expect(sharedPipeline).toContain('process.env.DISABLE_API_STRATEGY_FLOW !== "1"')
    expect(indicationSets).toContain('!isServerlessDeploymentRuntime() ||')
  })

  test("event-driven health monitoring keeps a periodic missed-heartbeat safety sweep", () => {
    const source = read("lib/trade-engine.ts")

    expect(source).toContain("private healthMonitoringSubscriptionsStarted = false")
    expect(source).toContain("if (this.healthMonitoringSubscriptionsStarted && this.healthCheckTimer) return")
    expect(source).toContain("const pendingHealthCheckScopes = new Set<string>()")
    expect(source).toContain("let healthCheckRunning = false")
    expect(source).toContain('const scopesToRun = scopes.includes("*") ? [undefined] : scopes')
    expect(source).toContain("this.healthCheckTimer = setInterval(() => {")
    expect(source).toContain("void runEventHealthCheck()")
    expect(source).toContain("}, 10_000)")
    expect(source).toContain("this.healthCheckTimer.unref?.()")
    expect(source).toContain("this.healthMonitoringSubscriptionsStarted = false")
    expect(source).toContain("onEngineEvent(\"engine.refresh.requested\"")
    expect(source).toContain("onEngineEvent(\"engine.heartbeat.updated\"")
  })

  test("base connection migrations preserve existing live-trade operator state", () => {
    const source = read("lib/redis-migrations.ts")
    const existingBlock = source.slice(
      source.indexOf("Existing connection: repair missing selection defaults only."),
      source.indexOf("// Existing connection: PRESERVE every operator-controlled field."),
    )

    expect(existingBlock).toContain("Never re-enable `is_live_trade` here")
    expect(existingBlock).toContain('existing row with')
    expect(existingBlock).toContain("const needsSelectionRepair =")
    expect(existingBlock).toContain("!hasOrder || !existing")
    expect(existingBlock).toContain('if (cfg.autoActive && cfg.exchange === "bingx" && needsSelectionRepair)')
    expect(existingBlock).toContain('patchData["symbol_order"] = "volatility_1h"')
    expect(existingBlock).not.toContain('patchData["is_live_trade"] = "1"')
    expect(existingBlock).not.toContain("!hasLiveTrade")
  })

  test("production web boot enables in-process starts and continuity by default", () => {
    const instrumentation = read("instrumentation.ts")
    const continuityRunner = read("lib/server-continuity-runner.ts")

    expect(instrumentation).toContain('process.env.NEXT_RUNTIME === "edge"')
    expect(instrumentation).not.toContain('process.env.NEXT_RUNTIME !== "nodejs"')
    expect(instrumentation).toContain('DISABLE_TRADE_ENGINE_AUTOSTART !== "1"')
    expect(instrumentation).toContain('DISABLE_IN_PROCESS_CONTINUITY !== "1"')
    expect(continuityRunner).toContain('DISABLE_IN_PROCESS_CONTINUITY === "1"')
    expect(continuityRunner).toContain("Long-lived Node production/dev processes should keep continuity alive")
  })

  test("indication snapshots do not double-count legacy production fields", () => {
    const detailedTracking = read("lib/detailed-tracking.ts")
    const statsRoute = read("app/api/connections/progression/[id]/stats/route.ts")
    const migrations = read("lib/redis-migrations.ts")

    expect(detailedTracking).toContain("const byType = aggregateWindowByType(active)")
    expect(detailedTracking).toContain("indication_sets_active")
    expect(detailedTracking).toContain("indication_sets_window")
    expect(detailedTracking).toContain("Do not read the raw indications_active")
    expect(detailedTracking).toContain("last5ByType[t] = v5")
    expect(detailedTracking).toContain("const totalIndicationSets = totalActive || last5Total || 0")
    expect(detailedTracking).not.toContain("const aggregateWindowByType = (hash: Record<string, string>): Record<string, number> =>")
    expect(statsRoute).toContain("function aggregateIndicationSnapshot")
    expect(statsRoute).toContain("ignore the plain field so mixed deploys do not double")
    expect(migrations).toContain('name: "063-reset-legacy-indication-snapshots"')
    expect(migrations).toContain('name: "064-split-raw-and-set-indication-snapshots"')
    expect(migrations).toContain('"indications_active:*"')
    expect(migrations).toContain('"indications_window:*:last5"')
    expect(migrations).toContain("do NOT touch cumulative progression counters")
  })

  test("indication processing keeps every type independent and windowed", () => {
    const setProcessor = read("lib/indication-sets-processor.ts")
    const rawProcessor = read("lib/trade-engine/indication-processor-fixed.ts")

    expect(setProcessor).toContain('type: "active_advanced", enabled: this.activeAdvancedEnabled')
    expect(setProcessor).toContain('run: () => this.processActiveAdvancedSet(symbol, marketData)')
    expect(setProcessor).toContain('INDICATION_SET_TYPE_CONCURRENCY')
    expect(setProcessor).toContain("private async processActiveAdvancedSet")
    expect(setProcessor).toContain('await this.batchSaveIndications(pendingWrites, "active_advanced")')
    expect(setProcessor).toContain('active_advanced: activeAdvancedResults')
    expect(setProcessor).toContain('`${symbol}:active_advanced`]: String(advQ)')
    expect(setProcessor).toContain('const activeKey = `indication_sets_active:${this.connectionId}`')
    expect(setProcessor).toContain('const w5Key      = `indication_sets_window:${this.connectionId}:last5`')
    expect(rawProcessor).toContain("active_advanced: 0")
    expect(rawProcessor).toContain('const w5Key = `indications_window:${this.connectionId}:last5`')
    expect(rawProcessor).toContain("pipe.hset(w5Key, fields)")
    expect(rawProcessor).toContain("pipe.hset(w60Key, fields)")
  })
  test("closing pending realtime outcomes preserves LIST-backed indication sets", () => {
    const setProcessor = read("lib/indication-sets-processor.ts")
    const closeStart = setProcessor.indexOf("private async closePendingRealtimeOutcomes")
    const closeEnd = setProcessor.indexOf("private evaluateForwardOutcome", closeStart)
    const closeBlock = setProcessor.slice(closeStart, closeEnd)

    expect(setProcessor).toContain("DRAIN_PENDING_OUTCOMES_SCRIPT")
    expect(setProcessor).toContain("CLOSE_PENDING_OUTCOME_GROUP_SCRIPT")
    expect(setProcessor).toContain('redis.call("LSET", setKey')
    expect(closeBlock).toContain("await this.readIndicationSetEntries(client, setKey)")
    expect(closeBlock).toContain("entries[index]?.metadata?.outcomePending")
    expect(closeBlock).not.toContain("entries[index]?.profitFactor === 0")
    expect(closeBlock).toContain("await client.del(setKey)")
    expect(closeBlock).toContain("await client.rpush(setKey, ...serializedEntries)")
    expect(closeBlock).toContain("compactionCeiling(cfg)")
    expect(closeBlock).toContain("await client.ltrim(setKey, -cfg.floor, -1)")
    expect(closeBlock).toContain("await this.indexSetKey(client, setKey")
    expect(closeBlock).not.toContain("await client.set(setKey, JSON.stringify(entries))")
    expect(closeBlock).not.toContain("const existing = await client.get(setKey)")
  })


  test("server continuity cron awaits direct healing sweep instead of relying on auto-start timers", () => {
    const cronRoute = read("app/api/cron/server-continuity/route.ts")
    const autoStart = read("lib/trade-engine-auto-start.ts")

    expect(autoStart).toContain("export async function runTradeEngineHealingSweep")
    expect(autoStart).toContain("armTimer = false")
    expect(autoStart).toContain("await runTradeEngineHealingSweep({ isStartup: true, armTimer: true })")
    expect(cronRoute).toContain("runTradeEngineHealingSweep")
    expect(cronRoute).toContain('"auto-start-healing-sweep",')
    expect(cronRoute).toContain("() => runTradeEngineHealingSweep({ isStartup: true })")
    expect(cronRoute).toContain("request.signal")
    expect(cronRoute).not.toContain("initializeTradeEngineAutoStart")
  })

  test("Cloudflare deployment has scheduled continuity worker config", () => {
    const wrangler = read("wrangler.jsonc")
    const customWorker = read("custom-worker.ts")

    expect(wrangler).toContain('"main": "./custom-worker.ts"')
    expect(wrangler).toContain('"compatibility_flags": ["nodejs_compat"]')
    expect(wrangler).toContain('"crons": ["* * * * *"]')
    expect(customWorker).toContain("env ?? {}")
    expect(customWorker).toContain("ctx ?? {}")
    expect(customWorker).toContain("ensureKiloPaperFallback")
    expect(customWorker).toContain("__cts_kilo_paper_fallback_active")
    expect(customWorker).toContain("getOpenNextHandler")
    expect(customWorker).toContain('import("./.open-next/worker.js")')
    expect(customWorker).not.toContain('import { default as handler } from "./.open-next/worker.js"')
    expect(customWorker).toContain("const inlineRedisLiveTrading = process.env.ALLOW_INLINE_REDIS_LIVE_TRADING === \"1\"")
    expect(read("lib/redis-db.ts")).toContain("__cts_kilo_paper_fallback_active")
    expect(customWorker).toContain("async scheduled")
    expect(customWorker).toContain("/api/cron/server-continuity")
    expect(customWorker).toContain("/api/cron/sync-live-positions")
  })

  test("production continuity cron awaits a real auto-start sweep before returning", () => {
    const cron = read("app/api/cron/server-continuity/route.ts")
    const autoStart = read("lib/trade-engine-auto-start.ts")

    expect(autoStart).toContain("export async function runTradeEngineHealingSweep")
    expect(autoStart).toContain("Cron/serverless routes must call this directly and await it")
    expect(cron).toContain('"auto-start-healing-sweep",')
    expect(cron).toContain("() => runTradeEngineHealingSweep({ isStartup: true })")
    expect(cron).toContain("runCooperativeTaskWithTimeout")
    expect(cron).not.toContain("initializeTradeEngineAutoStart")
  })

  test("status route does not report stale Redis running intent as local engine progress", () => {
    const source = read("app/api/trade-engine/status/route.ts")

    expect(source).toContain("const coordinatorEngineCount = coordinator?.getActiveEngineCount() || 0")
    expect(source).toContain("const hasLocalEngineRuntime = effectiveCoordinatorEngineCount > 0")
    expect(source).toContain("const hasFreshDistributedHeartbeat")
    expect(source).toContain("hasLocalConnectionRuntime || hasFreshDistributedHeartbeat")
    expect(source).toContain("const hasLocalConnectionRuntime = Boolean(localManager?.isEngineRunning)")
    expect(source).toContain("workerAttached: hasLocalEngineRuntime")
    expect(source).toContain("distributedHeartbeatFresh: hasFreshDistributedHeartbeat")
    expect(source).toContain("distributedEngineCount")
    expect(source).toContain("No local engine runtime is attached yet; explicit UI actions and continuity sweeps will attach engine work in this process.")
    expect(source).toContain("Optional for dedicated-worker deployments")
    expect(source).toContain("operatorStatus: operatorIntent")
    expect(source).not.toContain("Math.max(coordinatorEngineCount, summary.running)")
  })


  test("production status routes merge raw and settings-prefixed engine heartbeat state", () => {
    const systemStatus = read("app/api/system/status/route.ts")
    const tradeStatus = read("app/api/trade-engine/status/route.ts")
    const engineSystemStatus = read("app/api/engine/system-status/route.ts")

    for (const source of [systemStatus, tradeStatus, engineSystemStatus]) {
      expect(source).toContain("settings:trade_engine_state")
    }
    expect(systemStatus).toContain("rawState")
    expect(systemStatus).toContain("settingsState")
    expect(systemStatus).toContain("scopedRawState")
    expect(systemStatus).toContain("scopedSettingsState")
    expect(systemStatus).toContain("buildProgressionScope(conn.id, engineType)")
    expect(tradeStatus).toContain("rawEngineState")
    expect(tradeStatus).toContain("settingsEngineState")
    expect(tradeStatus).toContain("scopedRawEngineState")
    expect(tradeStatus).toContain("scopedSettingsEngineState")
    expect(tradeStatus).toContain("progressionReadKeys(scope)")
    expect(engineSystemStatus).toContain("rawEngineState")
    expect(engineSystemStatus).toContain("settingsEngineState")
    expect(engineSystemStatus).toContain("production status pages do not report false")
  })

  test("QuickStart prehistoric preload cannot duplicate the in-process engine", () => {
    const source = read("app/api/trade-engine/quick-start/route.ts")

    expect(source).toContain("const quickstartPreloadAllowed =")
    expect(source).toContain('process.env.NODE_ENV === "development"')
    expect(source).toContain('process.env.DISABLE_TRADE_ENGINE_IN_PROCESS === "1"')
    expect(source).toContain('process.env.ENABLE_QUICKSTART_PREHISTORIC_PRELOAD === "1"')
    expect(source).toContain("const quickstartPreload = (async () =>")
    expect(source).toContain('if (process.env.NODE_ENV === "test")')
  })




  test("symbol cache compares the complete force-symbol basket", () => {
    const source = read("lib/trade-engine/engine-manager.ts")
    const defaults = read("lib/symbol-selection-defaults.ts")

    expect(source).toContain("const effectiveForceSymbols = withCanonicalForcedSymbols(forceSymbols)")
    expect(source).not.toContain("localSymbolCapActive")
    expect(source).not.toContain("getExplicitLocalSymbolCap")
    expect(defaults).toContain("env.V0_DEV_SYMBOL_COUNT")
    expect(source).toContain("complete canonical operator basket")
  })

  test("explicit symbol selection uses bounded concurrency instead of truncation", () => {
    const source = read("lib/trade-engine/engine-manager.ts")

    expect(source).toContain("bounded concurrency/yields")
    expect(source).toContain("const resolved = withCanonicalForcedSymbols(await resolve())")
    expect(source).toContain("Explicit operator symbols are authoritative in every runtime")
    expect(source).not.toContain('if (devCap === 1) return ["BTCUSDT"]')
  })

  test("engine manager heap telemetry avoids Node v8 import warnings in Next dev", () => {
    const source = read("lib/trade-engine/engine-manager.ts")

    expect(source).toContain("process.memoryUsage().heapTotal")
    expect(source).not.toContain('require("v8")')
    expect(source).not.toContain('from "v8"')
    expect(source).not.toContain("from 'v8'")
  })

  test("passive connection health monitoring does not keep a stopped worker resident", () => {
    const source = read("lib/connection-coordinator.ts")

    expect(source).toContain("this.healthCheckInterval.unref?.()")
  })

  test("production build cleanup respects NEXT_DIST_DIR for parallel dev/prod verification", () => {
    const pkg = JSON.parse(read("package.json"))
    const nextConfig = read("next.config.mjs")

    expect(pkg.scripts.prebuild).toContain("node scripts/clean-next-dist.mjs")
    expect(pkg.scripts["prevercel-build"]).toContain("node scripts/clean-next-dist.mjs")
    expect(pkg.scripts.prebuild).not.toContain("rm -rf .next")
    expect(pkg.scripts["prevercel-build"]).not.toContain("rm -rf .next")
    expect(read("eslint.config.mjs")).toContain('".next-*/**"')
    expect(pkg.scripts.postbuild).toContain("node scripts/normalize-next-env.mjs")
    expect(pkg.scripts.postbuild).toContain("node scripts/prepare-standalone-assets.mjs")
    expect(pkg.scripts["postvercel-build"]).toBe("node scripts/normalize-next-env.mjs")
    expect(read("scripts/normalize-next-env.mjs")).toContain('./.next/types/routes.d.ts')
    expect(read("scripts/normalize-next-env.mjs")).toContain(
      'next/navigation-types/compat/navigation',
    )
    const previewRunner = read("scripts/run-prod-preview-check.mjs")
    expect(previewRunner).toContain('process.env.NEXT_DIST_DIR || ".next-prod"')
    expect(previewRunner).toContain("NEXT_DIST_DIR: distDir")
    expect(read("scripts/start-production.mjs")).toContain("NEXT_DIST_DIR: configuredDistDir")
    expect(previewRunner).toContain('existsSync(`${distDir}/BUILD_ID`)')
    expect(previewRunner).toContain('ALLOW_PROD_SIMULATED: "1"')
    expect(previewRunner).toContain("verifyOpenPositionCrashRecovery")
    expect(previewRunner).toContain("signalServerProcessGroup")
    expect(previewRunner).toContain('process.kill(-child.pid, signal)')
    expect(previewRunner).toContain('detached: process.platform !== "win32"')
    expect(previewRunner).toContain('import net from "node:net"')
    expect(previewRunner).toContain("async function waitForLoopbackPortRelease")
    expect(previewRunner).toContain('error?.code === "EADDRINUSE"')
    expect(previewRunner.match(/await waitForLoopbackPortRelease\(\)/g)).toHaveLength(2)
    expect(previewRunner.indexOf("await waitForLoopbackPortRelease()", previewRunner.indexOf("async function stopServer")))
      .toBeGreaterThan(previewRunner.indexOf('signalServerProcessGroup(child, "SIGKILL")', previewRunner.indexOf("async function stopServer")))
    expect(previewRunner.indexOf("await waitForLoopbackPortRelease()", previewRunner.indexOf("async function crashServer")))
      .toBeGreaterThan(previewRunner.indexOf('signalServerProcessGroup(child, "SIGKILL")', previewRunner.indexOf("async function crashServer")))
    expect(previewRunner).toContain("child.signalCode")
    expect(previewRunner).toContain("Position ${id} disappeared after crash instead of being reconciled")
    expect(previewRunner).toContain("recoveryTick?.ok !== true")
    expect(nextConfig).toContain("zero-byte")
    expect(nextConfig).toContain("cpus: 1")
    expect(nextConfig).toContain("staticGenerationMaxConcurrency: 1")
    expect(nextConfig).toContain("staticGenerationMinPagesPerWorker: 1")
  })

  test("12-symbol dev/prod soaks prove paper execution without live exchange requests", () => {
    const pkg = JSON.parse(read("package.json"))
    const soak = read("scripts/verify-prod-soak.mjs")
    const devRunner = read("scripts/run-dev-preview-check.mjs")
    const routeSmoke = read("scripts/smoke-routes-test.mjs")
    const devArtifactLock = read("scripts/dev-artifact-lock.mjs")
    const liveQuickstart = read("scripts/test-quickstart-3symbols.js")

    expect(pkg.scripts["test:quickstart-12"]).toBe("node scripts/run-dev-preview-check.mjs")
    expect(devRunner).toContain('RUNTIME_MODE: "development"')
    expect(devRunner).toContain('process.env.DEV_NODE_HEAP_MB || 12288')
    expect(devRunner).toContain('CTS_NODE_HEAP_MB: String(devNodeHeapMb)')
    expect(devRunner).toContain('process.env.DEV_RSS_SOFT_LIMIT_MB || "6400"')
    expect(devRunner).toContain('process.env.DEV_RSS_HARD_LIMIT_MB || "8192"')
    expect(devRunner).toContain('acquireDevArtifactLock({ artifactName: "next-dev" })')
    expect(routeSmoke).toContain("acquireDevArtifactLock({ artifactName: 'next-dev' })")
    expect(devArtifactLock).toContain('openSync(path, "wx", 0o600)')
    expect(devArtifactLock).toContain("Wait for it to finish instead of running concurrent .next writers.")
    expect(devRunner).toContain("60_000 + devSoakSymbolCount * 10_000")
    expect(devRunner).toContain("fullSoakRequested && maxSymbolsRequested")
    expect(devRunner).toContain("20 * 60_000")
    expect(devRunner).toContain('WATCHPACK_POLLING: process.env.WATCHPACK_POLLING || "true"')
    expect(devRunner).toContain("toggleWarmup.status === 429")
    expect(devRunner).toContain("do not retry and consume more quota")
    expect(devRunner).toContain('process.env.DEV_STRATEGY_REAL_SETS_CEILING || "600"')
    expect(devRunner).toContain('process.env.DEV_STRATEGY_VARIANT_BUILD_CONCURRENCY || "1"')
    expect(devRunner).toContain('BINGX_API_KEY: ""')
    expect(soak).toContain("liveTrade: false")
    expect(soak).toContain("is_live_trade: false")
    expect(soak).toContain("realEvalPosCount: 1")
    expect(soak).toContain("Paper position lifecycle was not exercised")
    expect(soak).toContain("completedAt - started, completedAt")
    expect(soak).toContain("lastEndpointObservationAt.set(path, responses[index].completedAt)")
    expect(soak).toContain("Engine did not publish the exact")
    expect(soak).toContain("paths.map((path) => requestWithRetry(path))")
    expect(soak).toContain("retrying without resetting soak state")
    expect(soak).toContain("requestLifecycleToggle")
    expect(soak).toContain("prod-soak:toggle-retry")
    expect(soak).toContain("const endpointSchedules = [")
    expect(soak).toContain("SIGNAL_POSITION_STORAGE_KEYS_PER_ROW = 6")
    expect(soak).toContain("SIGNAL_MAX_POSITIONS_TOTAL * SIGNAL_POSITION_STORAGE_KEYS_PER_ROW")
    expect(soak).toContain("signalPositionTopologyKeyBudget: SIGNAL_POSITION_TOPOLOGY_KEY_BUDGET")
    const prodUi = read("scripts/verify-prod-ui-max.mjs")
    expect(prodUi).toContain('["boot_", "prod_", "dev_", "dev-preview_"]')
    expect(prodUi).toContain("!validServiceBootId(systemStatus?.startup?.boot_id)")
    expect(soak).toContain("intervalMs: 60_000")
    expect(soak).toContain("intervalMs: 30_000")
    expect(soak).toContain("const byPath = new Map(lastByPath)")
    expect(soak).toContain('"BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT"')
    expect(soak).toContain('directExecutionEnabled: true')
    expect(soak).toContain("finalSignal.sourcePerformanceLookback !== 12")
    expect(soak).toContain("finalSignal.lanePerformanceLookback !== 10")
    expect(soak).toContain('lastByPath.get("/api/indications/config-counts")')
    expect(soak).toContain("totalPossibleSets * SYMBOLS.length * inventoryConnectionScopes")
    expect(soak).toContain("indicationOutcomeAuxiliaryCapacity = indicationSetInventoryCapacity * 3")
    expect(soak).toContain("databaseNonInventoryKeysEnd > databaseNonInventoryAllowedEnd")
    expect(soak).toContain("databaseNonInventoryBaseline")
    expect(soak).toContain("NON_INVENTORY_KEYS_PER_SYMBOL_BUDGET = 1_000")
    expect(soak).not.toContain("!SIGNAL_FOCUSED_SOAK && !databasePlateauWithinBudget")
    expect(soak).not.toContain("!SIGNAL_FOCUSED_SOAK && !heapWithinBudget")
    expect(soak).not.toContain("!SIGNAL_FOCUSED_SOAK && !rssWithinAbsoluteBudget")
    expect(read("lib/trade-engine/stages/live-stage.ts")).toContain(
      'else if (originalStatus !== "simulated")',
    )
    expect(soak).toContain("openPositions?.pseudo?.runningSets")
    expect(soak).toContain("strategyDetail?.real?.positionStats")
    expect(soak).toContain('RUNTIME_MODE === "production" && process.env.ALLOW_PROD_INLINE_REDIS === "1"')
    expect(soak).toContain('? 1024 * 1024')
    expect(soak).toContain(': 512 * 1024')
    expect(soak).toContain('memory.findIndex((sample) => sample.engineCycles > 0)')
    expect(soak).toContain("A real exchange position appeared during safe paper soak")
    expect(soak).toContain("Live mirrored row exceeds its Real-row input")
    expect(soak).not.toContain("Live output exceeds Real output")
    expect(liveQuickstart).toContain('process.env.ALLOW_REAL_ORDER_TEST !== "1"')
  })

  test("engine history readiness is checked per configured symbol", () => {
    const engine = read("lib/trade-engine/engine-manager.ts")
    const indication = read("lib/trade-engine/indication-processor-fixed.ts")

    expect(engine.match(/loadMarketDataForEngine\(symbols, \{[\s\S]*?minimumHistoryCandles: ENGINE_STAGE_HISTORY_CANDLES[\s\S]*?connectionId: this\.connectionId[\s\S]*?\}\)/g)?.length).toBeGreaterThanOrEqual(3)
    expect(indication).toContain("minimumHistoryCandles: MINIMUM_STAGE_HISTORY_CANDLES")
    expect(engine).not.toContain('client.get("market_data:BTCUSDT:1s")')
  })

  test("production pseudo-position updates use the active scoped progression epoch", () => {
    const realtime = read("lib/trade-engine/realtime-processor.ts")

    expect(realtime).toContain("const currentEpoch = await getCurrentEpoch(this.connectionId)")
    expect(realtime).toContain("hincrbyProgressionBatch(this.connectionId")
    expect(realtime).toContain("pseudo_positions_update_cycles: 1")
    expect(realtime).toContain("Standalone/tests without a progression owner")
  })

  test("dense Real-stage Block work yields between exhaustive source batches", () => {
    const strategy = read("lib/strategy-coordinator.ts")

    expect(strategy).toContain("sourceOffset += sourceBatchSize")
    expect(strategy).toContain("sourceOffset + sourceBatchSize < sources.length")
    expect(strategy).toContain("await new Promise<void>((resolve) => setImmediate(resolve))")
    expect(strategy).toContain("materialization_batch_size")
  })

  test("position-count Real rows and Live targets preserve Long and Short independently", () => {
    const strategy = read("lib/strategy-coordinator.ts")

    expect(strategy).toContain("axisPassthrough.push(s)")
    expect(strategy).toContain("never subject to")
    expect(strategy).toContain("opposite-direction netting")
    expect(strategy).toContain("`${parentSetKey}#poscounts:combined:${direction}`")
    expect(strategy).not.toContain("hedgeStrategyVolumeParts(axisSets.map")
  })

  test("legacy Base, Preset, and Live paths do not impose configuration ceilings", () => {
    const baseStage = read("lib/trade-engine/stages/base-stage.ts")
    const presetPseudo = read("lib/preset-pseudo-position-manager.ts")
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")

    expect(baseStage).toContain("baseIndicationConfigurationIdentity")
    expect(baseStage).toContain("base:positions:lane:")
    expect(baseStage).toContain("positionsPerExactLane = 1")
    expect(baseStage).not.toContain("STAGE_1_MAX_LONG_POSITIONS")
    expect(baseStage).not.toContain("STAGE_1_MAX_SHORT_POSITIONS")
    expect(presetPseudo).not.toContain("MAX_POSITIONS_PER_CONFIG")
    expect(presetPseudo).toContain("mapWithConcurrency")
    expect(liveStage).not.toContain("MAX_ACCUMULATIONS_PER_POSITION")
    expect(liveStage).not.toContain("accumulation_cap_after_recovery")
  })

  test("production status routes merge raw and settings-prefixed engine heartbeat state", () => {
    const systemStatus = read("app/api/system/status/route.ts")
    const tradeStatus = read("app/api/trade-engine/status/route.ts")
    const engineSystemStatus = read("app/api/engine/system-status/route.ts")

    for (const source of [systemStatus, tradeStatus, engineSystemStatus]) {
      expect(source).toContain("settings:trade_engine_state")
    }
    expect(systemStatus).toContain("rawState")
    expect(systemStatus).toContain("settingsState")
    expect(systemStatus).toContain("scopedRawState")
    expect(systemStatus).toContain("scopedSettingsState")
    expect(systemStatus).toContain("buildProgressionScope(conn.id, engineType)")
    expect(tradeStatus).toContain("rawEngineState")
    expect(tradeStatus).toContain("settingsEngineState")
    expect(tradeStatus).toContain("scopedRawEngineState")
    expect(tradeStatus).toContain("scopedSettingsEngineState")
    expect(tradeStatus).toContain("progressionReadKeys(scope)")
    expect(engineSystemStatus).toContain("rawEngineState")
    expect(engineSystemStatus).toContain("settingsEngineState")
    expect(engineSystemStatus).toContain("production status pages do not report false")
  })

  test("QuickStart prehistoric preload cannot duplicate the in-process engine", () => {
    const source = read("app/api/trade-engine/quick-start/route.ts")

    expect(source).toContain("const quickstartPreloadAllowed =")
    expect(source).toContain('process.env.NODE_ENV === "development"')
    expect(source).toContain('process.env.DISABLE_TRADE_ENGINE_IN_PROCESS === "1"')
    expect(source).toContain('process.env.ENABLE_QUICKSTART_PREHISTORIC_PRELOAD === "1"')
    expect(source).toContain("const quickstartPreload = (async () =>")
    expect(source).toContain('if (process.env.NODE_ENV === "test")')
  })

  test("Logistics snapshots remain bounded under exhaustive Redis load", () => {
    const source = read("lib/dashboard-workflow.ts")

    expect(source).toContain("const prehistoricDataSize = prehistoricSymbols")
    expect(source).toContain("getProgressionLogs(connId, { flush: false })")
    expect(source).toContain('getProgressionLogs("global", { flush: false })')
    expect(source).not.toContain("async function scanKeys")
    expect(source).not.toContain("client.scan(")
  })

  test("paper positions remain open and their index membership is atomic", () => {
    const status = read("lib/live-position-status.ts")
    const redis = read("lib/redis-db.ts")
    const live = read("lib/trade-engine/stages/live-stage.ts")

    expect(status).toContain('"simulated"')
    expect(redis).toContain("export async function upsertRedisListHead")
    expect(redis).toContain('redis.call("LREM", KEYS[1], 0, ARGV[1])')
    expect(redis).toContain('redis.call("LPUSH", KEYS[1], ARGV[1])')
    expect(live).toContain("await upsertRedisListHead(client, openIndexKey, position.id)")
    expect(live).not.toContain("await client.lrem(openIndexKey, 0, position.id).catch(() => 0)\n      await client.lpush(openIndexKey, position.id)")
  })

  test("volatile startup cleanup is claimed once across route module runtimes", () => {
    const source = read("lib/redis-db.ts")

    expect(source).toContain('"runtime:volatile_cleanup:startup_claim"')
    expect(source).toContain('reason === "initRedis" || reason === "completeStartup"')
    expect(source).toContain("{ NX: true, EX: 30 * 60 }")
  })


  test("settings recoordinator uses operator intent and unblocks live trade after credentials save", () => {
    const source = read("lib/connection-recoordinator.ts")

    expect(source).toContain("Live Trade unblocked")
    expect(source).toContain("operator_intent || (globalState as any)?.desired_status")
    expect(source).not.toContain("web worker has no local engine runtime/opt-in")
    expect(source).not.toContain('process.env.ENABLE_TRADE_ENGINE_AUTOSTART === "1" || coordinator.isRunning()')
  })

  test("live-trade foreground start failures do not mark the global coordinator error", () => {
    const source = read("app/api/settings/connections/[id]/live-trade/route.ts")

    expect(source).toContain("live_trade_enable_foreground_start_failed")
    expect(source).toContain('status: "running"')
    expect(source).toContain('operator_intent: "running"')
    expect(source).toContain('engineStatus = "queued"')
    expect(source).not.toContain('status: "error"')
    expect(source).not.toContain('engine_is_running:${connectionId}`')
  })

  test("startup cleanup preserves fresh distributed engine owners", () => {
    const source = read("lib/startup-coordinator.ts")
    const cleanupBlock = source.slice(
      source.indexOf("export async function cleanupOrphanedProgress"),
      source.indexOf("export async function completeStartup"),
    )

    // Fresh-owner detection must reconcile BOTH the raw and `settings:` engine-state
    // hashes via the shared helper, not read the raw hash alone.
    expect(cleanupBlock).toContain("fresh distributed heartbeat present")
    expect(cleanupBlock).toContain("isProcessorHeartbeatFresh(conn.id)")
    expect(cleanupBlock.indexOf("remoteHeartbeatFresh")).toBeLessThan(cleanupBlock.indexOf("Cleaning orphaned running flag"))
  })

  test("startup lock preserves a fresh remote engine owner instead of clearing its Redis flag", () => {
    const source = read("lib/trade-engine.ts")

    // Fresh-owner detection now reconciles RAW + `settings:` hashes via the helper.
    expect(source).toContain("isProcessorHeartbeatFresh(connectionId)")
    expect(source).toContain("is owned by another worker with a fresh heartbeat")
    expect(source).toContain("not clearing distributed running flag")
  })


  test("restart from non-owner preserves fresh remote progression lock", () => {
    const source = read("lib/trade-engine.ts")
    const restartBlock = source.slice(
      source.indexOf("async restartEngine(connectionId: string): Promise<void>"),
      source.indexOf("private async markRemoteRestartRequestIfFresh"),
    )

    expect(restartBlock).toContain("hasLocalRunningManager")
    expect(restartBlock).toContain("stop normally so the manager releases its own")
    expect(restartBlock).toContain("markRemoteRestartRequestIfFresh(connectionId)")
    expect(restartBlock).toContain("remote owner has fresh heartbeat")
    expect(restartBlock).toContain("treat the distributed")
    expect(restartBlock).toContain("forceBreakProgressionLock(connectionId)")
    expect(restartBlock.indexOf("markRemoteRestartRequestIfFresh(connectionId)")).toBeLessThan(
      restartBlock.indexOf("forceBreakProgressionLock(connectionId)"),
    )
  })

  test("fresh remote restart marker path does not force-break progression lock", () => {
    const source = read("lib/trade-engine.ts")
    const markerBlock = source.slice(
      source.indexOf("private async markRemoteRestartRequestIfFresh"),
      source.indexOf("async applyPendingChangesNow"),
    )

    // Fresh-owner detection must reconcile BOTH the raw and `settings:` engine-state
    // hashes via the shared helper, not read the raw hash alone.
    expect(markerBlock).toContain("isProcessorHeartbeatFresh(connectionId)")
    expect(markerBlock).toContain("restart_request")
    expect(markerBlock).toContain("settings_change_marker")
    expect(markerBlock).not.toContain("forceBreakProgressionLock")
  })

  test("settings save start reconciliation follows global operator intent", () => {
    const source = read("lib/connection-recoordinator.ts")

    expect(source).toContain("operator_intent || (globalState as any)?.desired_status")
    expect(source).toContain("global intent=running")
    expect(source).toContain("operator stop honored")
    expect(source).not.toContain('process.env.ENABLE_TRADE_ENGINE_AUTOSTART === "1" || coordinator.isRunning()')
    expect(source).not.toContain("web worker has no local engine runtime/opt-in")
  })

  test("dashboard enable keeps API worker responsive unless foreground runtime is explicitly allowed", () => {
    const source = read("app/api/settings/connections/[id]/toggle-dashboard/route.ts")

    expect(source).toContain('process.env.ALLOW_API_TRADE_ENGINE_FOREGROUND === "1"')
    expect(source).toContain('process.env.ENABLE_TRADE_ENGINE_IN_PROCESS === "1"')
    expect(source).toContain('allowInProcessStart: true')
    expect(source).toContain('const engineStarted = await coordinator.startEngine')
    expect(source).toContain('engineStatus = "queued"')
    expect(source).toContain('runTradeEngineHealingSweep({ isStartup: false })')
    expect(source).toContain('engineStatus = "started"')
  })


  test("serverless forceLocalTakeover cannot bypass explicit foreground worker opt-in", () => {
    const source = read("lib/trade-engine.ts")

    expect(source).toContain("const isServerlessWorker = isServerlessDeploymentRuntime()")
    expect(source).toContain("if (isServerlessWorker && !explicitForegroundAllowed)")
    expect(source).toContain("const forceLocalTakeover = options.forceLocalTakeover === true || config.allowInProcessStart === true")
    expect(source).not.toContain("isServerlessWorker && !explicitForegroundAllowed && !forceLocalTakeover")
  })

  test("production status poll queues healing without blocking the read path", () => {
    const source = read("app/api/trade-engine/status/route.ts")

    expect(source).toContain("runTradeEngineHealingSweep({ isStartup: false })")
    expect(source).toContain("function scheduleProductionHealingSweep(): void")
    expect(source).toContain("statusHealingSweepInFlight")
    expect(source).toContain("status polling must never race an explicit Start")
    expect(source).toContain("STATUS_HEALING_START_GRACE_MS")
    expect(source).toContain("startupRecoveryGraceExpired")
    expect(source).toContain("const coordinatorEngineCount = coordinator?.getActiveEngineCount() || 0")
    expect(source).toContain("let effectiveCoordinatorEngineCount = coordinatorEngineCount")
    expect(source).toContain("scheduleProductionHealingSweep()")
    expect(source).not.toContain("await runTradeEngineHealingSweep({ isStartup: false })")
  })

  test("status-all derives running state from process-independent Redis runtime evidence", () => {
    const source = read("app/api/trade-engine/status-all/route.ts")

    expect(source).toContain('import { resolveDistributedEngineRuntime } from "@/lib/distributed-engine-runtime"')
    expect(source).toContain('client.get(`engine_is_running:${conn.id}`)')
    expect(source).toContain('const runtime = resolveDistributedEngineRuntime({')
    expect(source).toContain('states: [runtimeState, settingsState, scopedRuntimeState, scopedSettingsState]')
    expect(source).toContain('const isRunning = runtime.running')
    expect(source).toContain('const canonicalStatus = isRunning')
    expect(source).toContain('status: canonicalStatus')
    expect(source).toContain('actual_status: canonicalStatus')
    expect(source).toContain('engine_running: isRunning ? "1" : "0"')
    expect(source).toContain('is_live_trade: canonicalLiveTrade ? "1" : "0"')
    expect(source).toContain("progressionReadKeys(scope)")
    expect(source).toContain("scopedRuntimeState")
    expect(source).toContain("scopedSettingsState")
    expect(source).toContain("...settingsState")
    expect(source).toContain("...runtimeState")
    expect(source).toContain("runtimeState.force_symbols || runtimeState.active_symbols || runtimeState.symbols")
    expect(source).toContain("__status_all_connections_snapshot")
    expect(source).toContain("__status_all_connections_inflight")
    expect(source).toContain("Active connection read timed out; serving the last complete status snapshot")
    expect(source).toContain("__status_all_engine_symbols")
    expect(source).toContain("rememberCompleteEngineSymbols(conn.id, resolvedSymbols)")
    expect(source).toContain("recoverCompleteEngineSymbols(conn.id)")
    expect(source).toContain("Engine symbol read timed out")
    expect(source).not.toContain("withTimeout(getActiveConnectionsForEngine(), 2000, [])")
    expect(source).not.toContain('from "@/lib/trade-engine"')
  })

  test("progression status requires per-connection runtime proof", () => {
    const source = read("app/api/trade-engine/progression/route.ts")

    expect(source).toContain("const localManagerRunning = coordinator.isEngineRunning(conn.id)")
    expect(source).toContain("resolveDistributedEngineRuntime({")
    expect(source).toContain("scopedRuntimeState")
    expect(source).toContain("scopedSettingsRuntimeState")
    expect(source).toContain("localManagerRunning || distributedRuntime.running")
    expect(source).not.toContain("engineStatus !== null")
  })

  test("high-frequency read-only routes do not instantiate the complete trade-engine graph", () => {
    for (const path of [
      "app/api/trade-engine/status-all/route.ts",
      "app/api/connections/[id]/engine-states/route.ts",
      "app/api/connections/progression/[id]/route.ts",
      "app/api/connections/progression/[id]/stats/route.ts",
      "app/api/system/monitoring/route.ts",
    ]) {
      const source = read(path)
      expect(source).toContain("resolveDistributedEngineRuntime")
      expect(source).not.toContain('from "@/lib/trade-engine"')
      expect(source).not.toContain('import("@/lib/trade-engine")')
    }
  })

  test("high-frequency dashboard reads parallelize independent Redis snapshots", () => {
    const engineStates = read("app/api/connections/[id]/engine-states/route.ts")
    const tradeHistory = read("app/api/trading/trade-history/route.ts")
    const configCounts = read("app/api/indications/config-counts/route.ts")

    expect(engineStates).toContain("const [connection, runningHintRaw, runtimeState, settingsState, globalState] = await Promise.all")
    expect(tradeHistory).toContain("const [connection, localPage, analyticsSnapshots, rawCached, forceArchive] = await Promise.all")
    expect(tradeHistory).toContain("const cached = compatibleExchangeHistory(rawCached, connection as Record<string, any>)")
    expect(configCounts).toContain("getAppSettings(),")
    expect(configCounts).not.toContain("bypassCache: true")
    expect(configCounts).toContain('namespace: "indication-config-counts"')
    expect(configCounts).toContain("serveExpiredImmediately: true")
  })

  test("detailed lifecycle monitoring separates delayed historic work from a lost bootstrap worker", () => {
    const source = read("app/api/trade-engine/detailed-logs/route.ts")
    const engine = read("lib/trade-engine/engine-manager.ts")

    expect(source).toContain("const historicProgressAt = Math.max(")
    expect(source).toContain("const runtimeActivityAt = Math.max(")
    expect(source).toContain("toEpochMs(progHash.last_strategy_tick_at)")
    expect(source).toContain("toEpochMs(prehistoricHash.config_work_last_activity_at)")
    expect(source).toContain("const bootstrapHeartbeatAt = Math.max(")
    expect(source).toContain("const historicProgressDelayed =")
    expect(source).toContain("const bootstrapLivenessAt = Math.max(bootstrapHeartbeatAt, heartbeatAt)")
    expect(source).toContain("heartbeatAgeMs > HEARTBEAT_STALE_MS) &&")
    expect(source).toContain("runtimeActivityAgeMs > PROCESSING_STALE_MS")
    expect(source).toContain("historicProgressAgeMs > PROCESSING_STALE_MS")
    expect(source).toContain("bootstrapLivenessAgeMs > HEARTBEAT_STALE_MS")
    expect(engine).toContain("private async refreshPrehistoricBootstrapHeartbeat(): Promise<void>")
    expect(engine).toContain("prehistoric_bootstrap_heartbeat_at")
    expect(engine).toContain("await this.refreshPrehistoricBootstrapHeartbeat().catch(() => undefined)")
  })

  test("connection enable paths keep global coordinator intent stable when engines can run", () => {
    const enableRoute = read("app/api/settings/connections/[id]/enable/route.ts")
    const dashboardRoute = read("app/api/settings/connections/[id]/toggle-dashboard/route.ts")

    expect(enableRoute).toContain('hgetall("trade_engine:global")')
    expect(enableRoute).toContain('status: "running"')
    expect(enableRoute).toContain('desired_status: "running"')
    expect(enableRoute).toContain('operator_intent: "running"')
    expect(enableRoute).toContain('coordinator_ready: "true"')
    expect(enableRoute).toContain('operator_stopped: "0"')
    expect(enableRoute).toContain('const localStartAllowed =')
    expect(enableRoute).toContain('process.env.VERCEL !== "1"')
    expect(enableRoute).toContain('process.env.ALLOW_API_TRADE_ENGINE_FOREGROUND === "1"')
    expect(enableRoute.indexOf('operator_intent: "running"')).toBeLessThan(enableRoute.indexOf("await coordinator.startMissingEngines"))

    expect(dashboardRoute).toContain("const preservedCoordinatorIntent")
    expect(dashboardRoute).toContain("desired_status: disableGlobalState?.desired_status || preservedCoordinatorIntent")
    expect(dashboardRoute).toContain("operator_intent: disableGlobalState?.operator_intent || preservedCoordinatorIntent")
    expect(dashboardRoute).toContain('operator_stopped: "0"')
    expect(dashboardRoute).toContain("Only /api/trade-engine/stop owns global shutdown")
  })

  test("live-trade enable clears stale global operator stop latch", () => {
    const source = read("app/api/settings/connections/[id]/live-trade/route.ts")
    const enableBlock = source.slice(
      source.indexOf("if (isLiveTrade)"),
      source.indexOf("await persistNow()", source.indexOf("if (isLiveTrade)")),
    )

    expect(enableBlock).toContain('operator_intent: "running"')
    expect(enableBlock).toContain('operator_stopped: "0"')
    expect(enableBlock).toContain('operator_stopped_at: ""')
    expect(enableBlock).toContain('stopped_at: ""')
  })


  test("global resume restores Redis intent before startEngine and supports fresh-process paused state", () => {
    const resumeRoute = read("app/api/trade-engine/resume/route.ts")
    const coordinator = read("lib/trade-engine.ts")

    const routeRestoreIndex = resumeRoute.indexOf('await client.hset("trade_engine:global", {')
    const routeResumeIndex = resumeRoute.indexOf("await coordinator.resume({ force: true })")
    expect(routeRestoreIndex).toBeGreaterThanOrEqual(0)
    expect(routeRestoreIndex).toBeLessThan(routeResumeIndex)
    expect(resumeRoute).toContain('status: previousStatus')
    expect(resumeRoute).toContain('desired_status: previousStatus')
    expect(resumeRoute).toContain('operator_intent: previousStatus')

    const resumeBlock = coordinator.slice(
      coordinator.indexOf("async resume(options: { force?: boolean } = {})"),
      coordinator.indexOf("getEngineManager", coordinator.indexOf("async resume(options: { force?: boolean } = {})")),
    )
    expect(resumeBlock).toContain('const redisPaused = globalState?.status === "paused" || globalState?.operator_intent === "paused"')
    expect(resumeBlock).toContain("if (!options.force && !this.isPaused && !redisPaused)")
    expect(resumeBlock.indexOf('await client.hset("trade_engine:global", {')).toBeLessThan(resumeBlock.indexOf("await this.startEngine(connectionId, config)"))
    expect(resumeBlock).toContain('status: restoredStatus')
    expect(resumeBlock).toContain('desired_status: restoredStatus')
    expect(resumeBlock).toContain('operator_intent: restoredStatus')
    expect(resumeBlock.indexOf('await client.hdel("trade_engine:global", "paused_at", "paused_by", "previous_status")')).toBeGreaterThan(resumeBlock.indexOf('await client.hset("trade_engine:global", {'))
    expect(resumeBlock).toContain("let hasAuthoritativeStateSnapshot = false")
    expect(resumeBlock).toContain("hasAuthoritativeStateSnapshot = true")
    expect(resumeBlock).toContain("hasAuthoritativeStateSnapshot && wasRunningBeforePause !== true")
    expect(resumeBlock).toContain("legacy pause without state snapshot, defaulting to resume")
  })

  test("dashboard detailed logs header action scrolls within the log dialog", () => {
    const button = read("components/dashboard/detailed-logs-button.tsx")
    const scrollArea = read("components/ui/scroll-area.tsx")
    const dashboard = read("components/dashboard/dashboard.tsx")

    expect(dashboard).toContain("<DetailedLogsButton />")
    expect(button).toContain("scrollContainerRef.current?.scrollTo({ top: 0, behavior: \"smooth\" })")
    expect(button).toContain("viewportRef={scrollContainerRef}")
    expect(scrollArea).toContain("viewportRef?: React.Ref<HTMLDivElement>")
    expect(scrollArea).toContain("ref={viewportRef}")
  })
  test("startup intent without worker heartbeat reports degraded/not running", () => {
    const startup = read("lib/startup-coordinator.ts")
    const statusRoute = read("app/api/trade-engine/status/route.ts")

    const bootBlock = startup.slice(
      startup.indexOf("Initializing global trade engine boot metadata"),
      startup.indexOf("Step 7/8", startup.indexOf("Initializing global trade engine boot metadata")),
    )

    expect(bootBlock).toContain("const existingGlobalState = (await client.hgetall")
    expect(bootBlock).toContain('desired_status: preservedIntent')
    expect(bootBlock).toContain('operator_intent: preservedIntent')
    expect(bootBlock).toContain('actual_status: "stopped"')
    expect(bootBlock).not.toMatch(/^\s*status: "running"/m)

    expect(statusRoute).toContain("const hasRuntimeProof = (coordinator?.getActiveEngineCount() || 0) > 0")
    expect(statusRoute).toContain("const effectivelyRunning = isGloballyRunning && !isGloballyPaused &&")
    expect(statusRoute).toContain("hasLocalEngineRuntime || hasRuntimeProof || distributedEngineCount > 0 || scheduledEngineCount > 0")
    expect(statusRoute).toContain('actualStatus: effectivelyRunning ? "running" : (isGloballyPaused ? "paused" : "degraded")')
    expect(statusRoute).toContain("last_heartbeat_at")
  })

  test("startup boot metadata preserves existing fresh runtime heartbeat ownership", () => {
    const startup = read("lib/startup-coordinator.ts")
    const bootBlock = startup.slice(
      startup.indexOf("Initializing global trade engine boot metadata"),
      startup.indexOf("Step 7/8", startup.indexOf("Initializing global trade engine boot metadata")),
    )

    expect(bootBlock).toContain("const existingGlobalState = (await client.hgetall")
    expect(startup).toContain("readTradeEngineWorkerHeartbeat(existingGlobalState)")
    expect(startup).toContain("isProcessorHeartbeatFresh")
    expect(startup).toContain("const preserveRuntimeLiveness =")
    expect(startup).toContain("!thisProcessOwnsGlobalHeartbeat && (globalWorkerHeartbeat.fresh || hasFreshProcessorHeartbeat)")
    expect(startup).toContain("actual_status: existingGlobalState?.actual_status || \"running\"")
    expect(startup).toContain("active_worker_id: existingGlobalState?.active_worker_id || \"\"")
    expect(startup).toContain("last_heartbeat_at: existingGlobalState?.last_heartbeat_at || \"\"")
    expect(bootBlock.indexOf("const existingGlobalState = (await client.hgetall")).toBeLessThan(
      bootBlock.indexOf('await client.hset("trade_engine:global"'),
    )
  })

  test.each([
    ["0", false],
    ["1", true],
  ])("testing place-order forwards Redis is_testnet %s as connector isTestnet=%s", async (isTestnetFlag, expectedIsTestnet) => {
    jest.resetModules()
    const previousAdminSecret = process.env.ADMIN_SECRET
    const previousForceSimulated = process.env.FORCE_SIMULATED
    const testAdminSecret = "test-admin-secret-32-characters"
    process.env.ADMIN_SECRET = testAdminSecret
    // This test exercises a fully mocked connector path. Keep it independent
    // from a process-level paper-mode override used by outer CI/soak runners.
    delete process.env.FORCE_SIMULATED

    try {
      const hgetall = jest.fn().mockResolvedValue({
        name: "Test Connection",
        exchange: "bingx",
        api_key: "valid-api-key-12345",
        api_secret: "valid-api-secret-12345",
        api_passphrase: "test-passphrase",
        api_type: "swap",
        contract_type: "perpetual",
        is_testnet: isTestnetFlag,
        margin_type: "cross",
        position_mode: "one_way",
        connection_method: "api",
        connection_library: "ccxt",
      })
      const hget = jest.fn().mockResolvedValue(null)
      const hincrby = jest.fn().mockResolvedValue(1)
      const hincrbyfloat = jest.fn().mockResolvedValue(1)
      const createExchangeConnector = jest.fn().mockResolvedValue({
        placeOrder: jest.fn().mockResolvedValue({
          success: true,
          orderId: "order-1",
          status: "filled",
          filledQty: 0.001,
          filledPrice: 100,
        }),
        placeStopOrder: jest.fn()
          .mockResolvedValueOnce({ success: true, orderId: "stop-1" })
          .mockResolvedValueOnce({ success: true, orderId: "take-1" }),
      })

      jest.doMock("@/lib/redis-db", () => ({
        initRedis: jest.fn().mockResolvedValue(undefined),
        getRedisClient: jest.fn(() => ({ hgetall, hget, hincrby, hincrbyfloat })),
        savePosition: jest.fn().mockResolvedValue(undefined),
        getMarketData: jest.fn().mockResolvedValue(null),
      }))
      jest.doMock("@/lib/exchange-connectors/factory", () => ({
        createExchangeConnector,
      }))
      jest.doMock("@/lib/live-order-safety", () => ({
        getLiveOrderSafetyFailure: jest.fn(() => null),
      }))

      const { POST } = await import("../../app/api/testing/place-order/route")

      const response = await POST({
        headers: new Headers({ authorization: `Bearer ${testAdminSecret}` }),
        json: async () => ({
          connectionId: "conn-1",
          symbol: "BTCUSDT",
          side: "buy",
          quantity: 0.001,
          leverage: 1,
          price: 100,
          stopLossPrice: 95,
          takeProfitPrice: 105,
        }),
      } as any)
      const payload = await response.json()

      expect(payload.success).toBe(true)
      expect(createExchangeConnector).toHaveBeenCalledWith(
        "bingx",
        expect.objectContaining({
          isTestnet: expectedIsTestnet,
          apiType: "swap",
          contractType: "perpetual",
        }),
      )
    } finally {
      if (previousAdminSecret === undefined) delete process.env.ADMIN_SECRET
      else process.env.ADMIN_SECRET = previousAdminSecret
      if (previousForceSimulated === undefined) delete process.env.FORCE_SIMULATED
      else process.env.FORCE_SIMULATED = previousForceSimulated
    }
  })

  test("queued settings refreshes hot-apply one connection and do not reinitialize all engines", () => {
    const coordinator = read("lib/trade-engine.ts")
    const autoStart = read("lib/trade-engine-auto-start.ts")
    const settingsCoordinator = read("lib/settings-coordinator.ts")

    const healthBlock = coordinator.slice(
      coordinator.indexOf('if (request.action === "stop")'),
      coordinator.indexOf("// -- 2. Per-engine stall watchdog", coordinator.indexOf('if (request.action === "stop")')),
    )
    expect(healthBlock).toContain("await this.applyPendingChangesNow(request.connectionId)")
    expect(healthBlock).not.toContain("await this.refreshEngines()")

    const autoBlock = autoStart.slice(
      autoStart.indexOf('if (request.action === "stop")'),
      autoStart.indexOf("return processed", autoStart.indexOf('if (request.action === "stop")')),
    )
    expect(autoBlock).toContain("await coordinator.applyPendingChangesNow?.(request.connectionId)")
    expect(autoBlock).not.toContain("await coordinator.refreshEngines()")

    const restartFields = settingsCoordinator.slice(
      settingsCoordinator.indexOf("const RESTART_REQUIRED_FIELDS"),
      settingsCoordinator.indexOf("const HOT_RELOAD_FIELDS"),
    )
    expect(restartFields).not.toContain('"is_enabled"')
    expect(settingsCoordinator).toContain('"is_enabled", "is_enabled_dashboard", "is_live_trade"')
  })

  test("QuickStart live controls send the checked state directly and revert to previous on failure", () => {
    const optionsBar = read("components/dashboard/quickstart-options-bar.tsx")
    const quickstartSection = read("components/dashboard/quickstart-section.tsx")
    const activeCard = read("components/dashboard/active-connection-card.tsx")
    const activeManager = read("components/dashboard/dashboard-active-connections-manager.tsx")

    expect(optionsBar).toContain("void debouncedSaveLive(next, previous)")
    expect(optionsBar).toContain("setControlOrders(previous)")
    expect(optionsBar).toContain("onClick={(event) => event.stopPropagation()}")
    expect(optionsBar).not.toContain("const debouncedSaveLive   = useDebouncedSaver(saveLiveTrade")

    expect(quickstartSection).toContain("const previousState = liveTradeActive")
    expect(quickstartSection).toContain("setLiveTradeActive(previousState)")
    expect(quickstartSection).toContain("live-trade-toggled")

    expect(activeCard).toContain("const previousState = liveTrade")
    expect(activeCard).toContain("setLiveTrade(previousState)")
    expect(activeCard).toContain("onCheckedChange={(checked) => {\n                    onToggle(connection.connectionId, checked)")
    expect(activeManager).toContain("const newState = desiredState")
    expect(activeManager).not.toContain("const newState = !currentState")
  })

  test("strategy set processing evaluates every current indication without top-k sampling", () => {
    const source = read("lib/strategy-sets-processor.ts")
    expect(source).toContain("let selectedTotal = 0")
    expect(source).toContain("let rejectedDirectionTotal = 0")
    expect(source).toContain("selectedTotal++")
    expect(source).toContain("for (const indication of indications)")
    expect(source).toContain("STRATEGY_SET_TYPES.flatMap")
    expect(source).toContain("STRATEGY_DIRECTIONS.map")
    expect(source).toContain("Classify the complete indication inventory in one CPU pass")
    expect(source).not.toContain("selectTopIndications")
    expect(source).not.toContain("MAX_INPUT_MULTIPLIER")
    expect(source).not.toContain("indications.slice(")
  })


  test("production system monitoring returns process resource metrics even when Redis is unavailable", () => {
    const route = read("app/api/system/monitoring/route.ts")
    const comprehensiveRoute = read("app/api/monitoring/comprehensive/route.ts")
    const helper = read("lib/system-resource-metrics.ts")

    expect(route).toContain('const resourceMetrics = getSystemResourceMetrics()')
    expect(route.indexOf('const resourceMetrics = getSystemResourceMetrics()')).toBeLessThan(route.indexOf('await initRedis()'))
    expect(route).toContain('Redis unavailable while collecting system metrics')
    expect(route).toContain('cpu: resourceMetrics.cpuPercent')
    expect(route).toContain('memory: resourceMetrics.memoryPercent')
    expect(route).toContain('const MONITORING_KEY_SAMPLE_LIMIT = 20_000')
    expect(route).toContain('const MONITORING_KEY_SAMPLE_TTL_MS = 5_000')
    expect(route).toContain('sampleKeys(MONITORING_KEY_SAMPLE_LIMIT)')
    expect(route).toContain('collectConnectionIds(client, allKeys)')
    expect(route).toContain('maxField(progressionHashes, "realtime_cycle_count")')
    expect(route).toContain('maxField(progressionHashes, "live_positions_cycle_count")')
    expect(route).toContain('progression:${connectionId}:${type}')
    expect(route).toContain('client.hgetall(`realtime:${connectionId}`)')
    expect(route).toContain('const connectionMatch = /^(?:settings:)?connection:([^:]+)$/')
    expect(route).toContain('client.smembers(key)')
    expect(route).toContain('runtimeIndexed.length > 0 ? runtimeIndexed : allConnections')
    expect(route).not.toContain('cpu: 0,')
    expect(route).not.toContain('memory: 0,')

    expect(helper).toContain('process.cpuUsage(previous.cpuUsage)')
    expect(helper).toContain('/sys/fs/cgroup/memory.max')
    expect(helper).toContain('/sys/fs/cgroup/cpu.max')
    expect(helper).toContain('Math.max(0.1')
    expect(helper).toContain('memory.rss')
    expect(comprehensiveRoute).toContain("getObservedRedisRequestsPerSecond")
    expect(comprehensiveRoute).toContain("requestsPerSecond")
  })


  test("progression stats endpoint is read-only for poll-derived real active averages", () => {
    const route = read("app/api/connections/progression/[id]/stats/route.ts")
    const snapshotBlock = route.slice(
      route.indexOf("Active validated Real positions snapshot"),
      route.indexOf("Live-stage OPEN positions", route.indexOf("Active validated Real positions snapshot")),
    )

    expect(snapshotBlock).toContain("/stats is a GET/read endpoint and must not mutate Redis")
    expect(snapshotBlock).toContain("const existingRealActiveAvg = n(progHash.real_active_pos_avg)")
    expect(snapshotBlock).not.toContain("hincrby")
    expect(snapshotBlock).not.toContain("hset")
  })

  test("dashboard stats polling ignores stale overlapping responses", () => {
    const quickstart = read("components/dashboard/quickstart-section.tsx")
    const overview = read("components/dashboard/statistics-overview-v2.tsx")
    const activeCard = read("components/dashboard/active-connection-card.tsx")

    expect(quickstart).toContain("const statsFetchSeqRef = useRef(0)")
    expect(quickstart).toContain("const requestSeq = ++statsFetchSeqRef.current")
    expect(quickstart).toContain("requestSeq !== statsFetchSeqRef.current")

    expect(overview).toContain("const statsFetchSeqRef = useRef(0)")
    expect(overview).toContain("const requestSeq = ++statsFetchSeqRef.current")
    expect(overview).toContain("requestSeq !== statsFetchSeqRef.current")

    expect(activeCard).toContain("const progressionFetchSeqRef = useRef(0)")
    expect(activeCard).toContain("const liveStatsFetchSeqRef = useRef(0)")
    expect(activeCard).toContain("const requestSeq = ++progressionFetchSeqRef.current")
    expect(activeCard).toContain("const requestSeq = ++liveStatsFetchSeqRef.current")
    expect(activeCard).toContain("requestSeq !== progressionFetchSeqRef.current")
    expect(activeCard).toContain("requestSeq !== liveStatsFetchSeqRef.current")
  })


  test("QuickStart live button uses effective live state and live-trade enable makes engine eligible", () => {
    const quickstart = read("components/dashboard/quickstart-section.tsx")
    const liveRoute = read("app/api/settings/connections/[id]/live-trade/route.ts")
    const helper = read("lib/system-resource-metrics.ts")

    const quickstartHelper = quickstart.slice(
      quickstart.indexOf("QuickStart's Live button controls effective exchange order placement"),
      quickstart.indexOf("// ─── types", quickstart.indexOf("QuickStart's Live button controls effective exchange order placement")),
    )
    expect(quickstartHelper).toContain("toBooleanFlag(conn?.live_trade_requested)")
    expect(quickstartHelper).toContain("toBooleanFlag(conn?.is_live_trade)")
    expect(quickstartHelper).toContain("toBooleanFlag(conn?.live_trade_enabled)")
    expect(quickstart).toContain("setLiveTradeActive(effectiveState)")

    const liveEnableBlock = liveRoute.slice(
      liveRoute.indexOf("If Live is turned on while the main engine is not already running"),
      liveRoute.indexOf('live_trade_requested: "1"', liveRoute.indexOf("If Live is turned on while the main engine is not already running")) + 40,
    )
    expect(liveEnableBlock).toContain('is_assigned: "1"')
    expect(liveEnableBlock).toContain('is_enabled_dashboard: "1"')
    expect(liveEnableBlock).toContain('is_active: "1"')
    expect(helper).toContain('os.totalmem')
    expect(helper).toContain('memory.rss')
  })


  test("migration status repairs and reports database health metadata", () => {
    const migrations = read("lib/redis-migrations.ts")
    const route = read("app/api/install/database/migrations-info/route.ts")
    const verifyScript = read("scripts/verify-migration-status.mjs")

    expect(migrations).toContain("interface MigrationRunResult")
    expect(migrations).toContain("getMigrationBundleHealth")
    expect(migrations).toContain("ensureDatabaseHealthMetadata")
    expect(migrations).toContain("ensureMigrationHealthMetadata")
    expect(migrations).toContain('client.hgetall("system:database:health")')
    expect(migrations).toContain("healthUpToDate")
    expect(migrations).toContain("currentVersion === latestVersion && !healthUpToDate")
    expect(migrations).toContain("isMigrated: currentVersion === latestVersion && healthUpToDate")
    expect(migrations).toContain("Schema latest but database health metadata needs repair")
    expect(migrations).toContain('return { success: true, message: "Already run in this process", version: finalVer, databaseHealth }')
    expect(migrations).toContain("return { success: true, message: `Already at latest version ${finalVersion}`, version: finalVersion, databaseHealth }")

    expect(route).toContain("database_health: status.databaseHealth ?? {}")
    expect(route).toContain("health_up_to_date: status.healthUpToDate === true")
    expect(route).toContain("migrations_sequential: status.migrationsSequential === true")
    expect(verifyScript).toContain("health_up_to_date=true")
    expect(verifyScript).toContain("STALE/MISSING")
    expect(verifyScript).toContain("migrations and database health metadata UP TO DATE")
  })

  test("Redis migrations remain sequential for production schema upgrades", () => {
    const source = read("lib/redis-migrations.ts")
    const versions = Array.from(source.matchAll(/version:\s*(\d+)/g), (match) => Number(match[1]))
    const gaps: Array<[number, number]> = []
    for (let i = 1; i < versions.length; i++) {
      if (versions[i] !== versions[i - 1] + 1) gaps.push([versions[i - 1], versions[i]])
    }

    expect(gaps).toEqual([])
    expect(source).toContain('name: "043-reserved-schema-continuity"')
    expect(source).toContain('name: "044-reserved-schema-continuity"')
    expect(source).toContain('name: "065-dev-prod-database-health-metadata"')
    expect(source).toContain("export function getLatestMigrationVersion")
    expect(source).toContain('"system:database:health"')
    expect(source).toContain('migrations_bundle_version: String(latestVersion)')
  })

  test("Redis init rechecks stale global readiness before skipping migrations", () => {
    const source = read("lib/redis-db.ts")
    const bootstrap = read("lib/redis-runtime-bootstrap.ts")
    const blockStart = source.indexOf("if (globalForRedis.__redis_fully_connected || isConnected)")
    const globalReadyBlock = source.slice(
      blockStart,
      source.indexOf("if (globalForRedis.__redis_init_promise)", blockStart),
    )

    expect(globalReadyBlock).toContain('hasSharedRuntimeMarker(redisInstance!, "ready")')
    expect(globalReadyBlock).toContain("globalForRedis.__redis_fully_connected = false")
    expect(globalReadyBlock).toContain("migrationsRan = false")
    expect(source).toContain('hasSharedRuntimeMarker(getRedisClient(), "base")')
    expect(source).toContain('import("@/lib/redis-migrations")')
    expect(bootstrap).toContain("LATEST_REDIS_SCHEMA_VERSION = 105")
    expect(source).toContain('client.get("_schema_version").catch(() => null)')
  })

  test("QuickStart re-entry preserves running progressions instead of forced restarts", () => {
    const quickStart = read("app/api/trade-engine/quick-start/route.ts")
    const coordinator = read("lib/trade-engine.ts")

    expect(quickStart).toContain("quickstartEngineAlreadyRunning")
    expect(quickStart).toContain("quickstart_engine_reused")
    expect(quickStart).toContain("Running engine reused; QuickStart symbols/settings applied without stop/restart")
    expect(quickStart).toContain("const quickstartNeedsFreshProcessing =")
    expect(quickStart).toContain("quickstartRecoordination.progressionChanged === true")
    expect(quickStart).toContain("canRetainQuickStartPrehistoricCoverage")
    expect(quickStart).toContain("const quickstartRetainsPrehistoricCoverage =")
    expect(quickStart).toContain("recoordinatedEngineState")
    expect(quickStart).toContain("recoordinatedPrehistoricState")
    expect(quickStart).toContain("Verified process-restart Historic cache retained")
    expect(quickStart).toContain("completion gates were self-healed")
    expect(quickStart).toContain('engine_started: "false"')
    expect(quickStart).toContain("prehistoric_cycles_completed: String(symbols.length)")
    expect(quickStart).toContain('client.hdel(quickstartScope.progressionKey, "ended_at")')
    expect(quickStart).toContain("cumulative progression was made reusable")
    expect(quickStart).toContain("retainedDoneGateKeys.scoped")
    expect(quickStart).toContain("quickstartScope.prehistoricLoadedKey")
    expect(quickStart).toContain("stoppedProgressionMatchesCurrentState")
    expect(quickStart).toContain("expectedSymbolsHash")
    expect(quickStart).toContain("quickstartTouchedFields.length === 0 && !quickstartNeedsFreshProcessing")
    expect(quickStart).toContain("config_set_symbols_processed: quickstartRetainsPrehistoricCoverage ? symbols.length : 0")
    expect(quickStart).toContain("if (!quickstartRetainsPrehistoricCoverage)")
    expect(quickStart).toContain("coordinator.invalidateSymbolsCacheForConnection(connectionId)")
    expect(quickStart).not.toContain("quickstart_engine_restart")

    const changeDetection = read("lib/quickstart-change-detection.ts")
    expect(changeDetection).toContain("resolveQuickStartPreviousSymbolBasket")
    expect(changeDetection).toContain("symbolAliasUnchanged")

    expect(coordinator).toContain("FULL_RESTART_ESCALATION_ENABLED = false")
    expect(coordinator).toContain("restart escalation disabled")
  })

  test("QuickStart and guarded settings commits keep every symbol alias coherent", () => {
    const quickStart = read("app/api/trade-engine/quick-start/route.ts")
    const recoordinator = read("lib/connection-recoordinator.ts")
    const progression = read("lib/progression-state-manager.ts")

    expect(quickStart.match(/selected_symbols: JSON\.stringify\(symbols\)/g)?.length).toBeGreaterThanOrEqual(2)
    expect(recoordinator).toContain("const settingsPatch = normalizeSymbolAliasesInPatch(")
    expect(recoordinator).toContain("const normalizedAdditionalPatch = normalizeSymbolAliasesInPatch(")
    expect(progression.indexOf("connectionSettings.force_symbols"))
      .toBeLessThan(progression.indexOf("connectionSettings.selected_symbols"))
    expect(read("lib/trade-engine/engine-manager.ts"))
      .toContain("getCanonicalConnectionSettingsOverlay(this.connectionId)")
    expect(read("lib/trade-engine/symbol-selection-ownership.ts"))
      .toContain("The unscoped settings state is also a runtime heartbeat target")
  })

  test("Common indication calculation yields without fragmenting Redis persistence", () => {
    const source = read("lib/indication-sets-processor.ts")
    const commonStart = source.indexOf("private async processCommonSet")
    const commonEnd = source.indexOf("private async processTrendSet", commonStart)
    const commonBlock = source.slice(commonStart, commonEnd)

    expect(source).toContain('process.env.COMMON_INDICATION_CALC_BATCH_SIZE || "4"')
    expect(commonBlock).toContain("COMMON_INDICATION_CALC_BATCH_SIZE")
    expect(commonBlock.match(/await flushCandidates\(\)/g)?.length).toBe(2)
    expect(commonBlock).toContain("flushing only full")
  })

  test("QuickStart commits running Redis intent before dispatching engine starts", () => {
    const quickStart = read("app/api/trade-engine/quick-start/route.ts")
    const step4 = quickStart.slice(
      quickStart.indexOf("// Step 4: Start engine"),
      quickStart.indexOf("// Store in global quickstart state"),
    )
    const intentWriteIndex = step4.indexOf('await client.hset("trade_engine:global", {')
    const targetedDispatchIndex = step4.indexOf("const startPromise = coordinator.startEngine(connectionId, {")
    const targetedStartIndex = step4.indexOf("const engineStarted = process.env.NODE_ENV")

    expect(intentWriteIndex).toBeGreaterThanOrEqual(0)
    expect(targetedDispatchIndex).toBeGreaterThanOrEqual(0)
    expect(intentWriteIndex).toBeLessThan(targetedDispatchIndex)
    expect(intentWriteIndex).toBeLessThan(targetedStartIndex)
    // QuickStart must not launch a detached global sweep: that old route
    // could restart a just-stopped connection after the Stop request won.
    expect(step4).not.toMatch(/\bcoordinator\.startAll\(\)/)
    expect((step4.match(/\.startEngine\(connectionId,/g) || [])).toHaveLength(1)
    expect(step4).not.toContain("refreshEngines().catch")
    expect(step4).toContain("quickstartEngineRunningAtDispatch")
    expect(step4).toContain('operator_stopped: "0"')
    expect(step4).toContain("updated_at: quickstartGlobalStartedAt")
    expect(step4).toContain("const quickstartGlobalStartedAt = new Date().toISOString()")

    const intentBlock = step4.slice(intentWriteIndex, step4.indexOf("})", intentWriteIndex))
    expect(intentBlock).toContain('status: "running"')
    expect(intentBlock).toContain('desired_status: "running"')
    expect(intentBlock).toContain('operator_intent: "running"')

    const targetedStartBlock = step4.slice(targetedStartIndex)
    expect(targetedStartBlock).toContain("if (!engineStarted)")
    expect(targetedStartBlock).toContain('"engine_start_skipped"')
    expect(targetedStartBlock).toContain('phase: "queued"')
    expect(targetedStartBlock).toContain('status: "skipped_queued"')
  })

  test("Real-stage logical funnel excludes related fan-out and never reports negative failures", () => {
    const source = read("lib/strategy-coordinator.ts")

    expect(source).toContain("const realRelatedCreated = realStageRelatedCreated")
    expect(source).toContain("const realTotalEvaluated = mainPFEligible + realRelatedCreated + continuousRealEvaluated")
    // Raw/related fan-out can exceed its input, so it belongs in separate
    // capacity counters; the public funnel stays in logical lineage space.
    expect(source).toContain("const realLogicalInput = realInputAccounting.logicalEvaluated")
    expect(source).toContain("const realLogicalPassed = accountRealStageInputs(realQualifying).logicalEvaluated")
    expect(source).toContain("evaluated:          String(realLogicalInput)")
    expect(source).toContain("[`s:${symbol}:evaluated`]:  String(realLogicalInput)")
    expect(source).toContain('client.set(`strategies:${this.connectionId}:real:evaluated`, String(realLogicalInput))')
    expect(source).toContain('"strategies_real_raw_evaluated", realTotalEvaluated')
    expect(source).toContain("totalCreated: realTotalEvaluated")
    expect(source).toContain("failedEvaluation: Math.max(0, realLogicalInput - realLogicalPassed)")
    expect(source).not.toContain("failedEvaluation: mainPFEligible - realSets.length")

    const logicalInput = 3
    const logicalPassed = 2
    const rawPhysicalWork = 5

    expect(Math.max(0, logicalInput - logicalPassed)).toBe(1)
    expect(rawPhysicalWork).toBeGreaterThan(logicalInput)
  })




  test("connection status and progression routes use production heartbeat/global intent fallbacks", () => {
    const progressionRoute = read("app/api/connections/progression/[id]/route.ts")
    const statusRoute = read("app/api/connections/status/route.ts")

    expect(progressionRoute).toContain('import { resolveDistributedEngineRuntime } from "@/lib/distributed-engine-runtime"')
    expect(progressionRoute).toContain('const [scopedEngineState, scopedRawEngineState, legacySettingsEngineState, legacyRawEngineState, runningFlag] = await Promise.all')
    expect(progressionRoute).toContain('const activeProgressionSymbolCount = toNumber(progHash.symbol_count) || toNumber(progHash.quickstart_symbol_count)')
    expect(progressionRoute).toContain('const finalHistoricProgress = calculateHistoricProgress(')
    expect(progressionRoute).not.toContain('prehistoricProgress.percentComplete = 100')
    expect(progressionRoute).toContain('const engineRuntime = resolveDistributedEngineRuntime({')
    expect(progressionRoute).toContain('const processorHeartbeat = engineRuntime.heartbeatAt')
    expect(progressionRoute).not.toContain('from "@/lib/trade-engine"')

    expect(statusRoute).toContain('import { getFreshestProcessorHeartbeat } from "@/lib/engine-heartbeat"')
    expect(statusRoute).toContain('import { buildProgressionScope } from "@/lib/progression-scope"')
    expect(statusRoute).toContain('const globalIntent = globalState.operator_intent || globalState.desired_status || globalState.status || ""')
    expect(statusRoute).toContain('const runtimeActive = !!engineStatus || heartbeatFresh || (globalRunning && assigned && processingEnabled)')
    expect(statusRoute).toContain('getSettings(scope.engineProgressionKey)')
    expect(statusRoute).toContain('const globalIntent = globalState.operator_intent || globalState.desired_status || globalState.status || ""')
    expect(statusRoute).toContain('const runtimeActive = !!engineStatus || heartbeatFresh || (globalRunning && assigned && processingEnabled)')
    expect(statusRoute).toContain('lastProcessorHeartbeat: processorHeartbeat || null')

    expect((statusRoute.match(/import \{ getAllConnections, getRedisClient, getSettings, initRedis \} from "@\/lib\/redis-db"/g) || []).length).toBe(1)
    expect((statusRoute.match(/import \{ SystemLogger \} from "@\/lib\/system-logger"/g) || []).length).toBe(1)
    expect((statusRoute.match(/import \{ getTradeEngineStatus \} from "@\/lib\/trade-engine"/g) || []).length).toBe(1)
    expect((statusRoute.match(/import \{ getFreshestProcessorHeartbeat \} from "@\/lib\/engine-heartbeat"/g) || []).length).toBe(1)
    expect((statusRoute.match(/const progression =/g) || []).length).toBe(1)
    expect((progressionRoute.match(/configuredSymbolCount = getConfiguredSymbolCount/g) || []).length).toBe(1)
  })

  test("production auto-start empty global intent can start processors instead of staying queued", () => {
    const coordinator = read("lib/trade-engine.ts")
    const autoStart = read("lib/trade-engine-auto-start.ts")

    expect(autoStart).toContain('const shouldRun = operatorIntent !== "stopped"')
    expect(autoStart).toContain('if (shouldRun && !operatorIntent)')
    expect(autoStart).toContain('auto_started_from_empty_intent: "1"')
    expect(autoStart).toContain('operator_intent: "running"')
    expect(coordinator).toContain('const rawIntent = globalState?.operator_intent || globalState?.desired_status || globalState?.status || ""')
    expect(coordinator).toContain('const enabled = intent === "running" || (!operatorStopped && rawIntent === "")')
    expect(coordinator).toContain('uninitialized global hash means "run eligible enabled connections"')
    expect(coordinator).not.toContain('const enabled = intent === "running"\n      this.isPaused = intent === "paused"')
  })

  test("unique progression attach requires runtime heartbeat proof so dead progress cannot stay stuck", () => {
    const source = read("lib/progression-state-manager.ts")

    expect(source).toContain('import { getFreshestProcessorHeartbeat } from "@/lib/engine-heartbeat"')
    expect(source).toContain("const PROCESSOR_HEARTBEAT_STALE_MS = 90_000")
    expect(source).toContain("const hasFreshProcessorHeartbeat")
    expect(source).toContain("const lacksRuntimeProof = activeAge > PROCESSOR_HEARTBEAT_STALE_MS && !hasFreshProcessorHeartbeat")
    expect(source).toContain("dashboard/\n          // auto-start attaches can keep a dead progression looking fresh forever")
    expect(source).toContain("...(hasFreshProcessorHeartbeat ? { last_update: nowIso } : {})")
  })

  test("production prehistoric bootstrap retries real work and never fabricates live readiness", () => {
    const source = read("lib/trade-engine/engine-manager.ts")

    expect(source).toContain("PREHISTORIC_BOOTSTRAP_DEADLINE_MS")
    expect(source).toContain("Engine ${this.connectionId} prehistoric bootstrap")
    expect(source).toContain('prehistoric_bootstrap_status: "retry_wait"')
    expect(source).toContain("entry_processors_gated: true")
    expect(source).toContain("The full successful bootstrap is the sole completion owner")
    expect(source.indexOf('prehistoric_data_source: "verified-cache"')).toBeGreaterThan(
      source.indexOf("const dataLooksComplete"),
    )
    expect(source).not.toContain("first-pass fallback opened live gates")
    expect(source).not.toContain('writePrehistoricGate(client, connId, this.currentEngineType, "done")')
    expect(source).toContain("schedulePrehistoricProgressionAfterRealtimeWarmup")
    expect(source).toContain('this.canonicalPipelineAdmission.tryAcquire("bootstrap")')
    expect(source).toContain('this.canonicalPipelineAdmission.release("bootstrap")')
    expect(source).toContain("prehistoric_bootstrap_admission_wait_ms")
    expect(source).toContain("this.globalHistoricBootstrapAdmission.tryAcquire(this.connectionId)")
    expect(source).toContain("Historic bootstrap queued")
    expect(source).toContain("prehistoric_bootstrap_global_admission_wait_ms")
  })

  test("continuous historic replay reports slow cycles without detaching live workers", () => {
    const source = read("lib/trade-engine/engine-manager.ts")
    const start = source.indexOf("Determine the slow-cycle diagnostic threshold")
    const end = source.indexOf("cycleCount++", start)
    const block = source.slice(start, end)

    expect(block).toContain("slowReplayDiagnostic")
    expect(block).toContain("await mapWithConcurrency(scheduledSymbols, replayConcurrency, replayOneSymbol, { yieldEvery: 1 })")
    expect(block).toContain("clearTimeout(slowReplayDiagnostic)")
    expect(block).not.toContain("withCycleDeadline(")
  })

  test("verified Historic bootstrap bridges in-process lag but preserves opt-in exact replay", () => {
    const source = read("lib/trade-engine/engine-manager.ts")
    const checkpoint = source.indexOf('const replayCheckpointTs = replayMode === "exact" ? prehistoricEnd.getTime() : Date.now()')
    const completion = source.indexOf('is_complete: "1"', checkpoint)
    const gates = source.indexOf("writePrehistoricGate(redisClient", checkpoint)

    expect(source).toContain("resolvePrehistoricRangeHours(")
    expect(source).toContain("const rangeHours = resolvePrehistoricRangeHours(appSettings as Record<string, unknown>)")
    expect(source).toContain("`prehistoric:checkpoint:${this.connectionId}:${symbol}`")
    expect(source).toContain("historicReplayNeedsRealtimeWarmup")
    expect(source).toContain("prehistoric_replay_coalesced_windows_total")
    expect(source).toContain('pendingOrder: replayMode === "exact" ? "earliest" : "latest"')
    expect(checkpoint).toBeGreaterThan(0)
    expect(completion).toBeGreaterThan(checkpoint)
    expect(gates).toBeGreaterThan(completion)
  })

  test("all process memory monitors use the launched heap contract", () => {
    const startup = read("lib/startup-coordinator.ts")
    const manager = read("lib/memory-manager.ts")
    const devRunner = read("scripts/run-dev-preview-check.mjs")

    expect(startup).toContain("const configuredHeapMB = Number(process.env.CTS_NODE_HEAP_MB)")
    expect(manager).toContain("__cts_memory_manager__")
    expect(manager).toContain("clearInterval(this.gcInterval as any)")
    expect(devRunner).toContain("CTS_NODE_HEAP_MB: String(devNodeHeapMb)")
  })

  test("production cron route uses canonical ind-strat pipeline for all configured symbols", () => {
    const cron = read("app/api/cron/generate-indications/route.ts")
    const pipeline = read("lib/trade-engine/shared-ind-strat-pipeline.ts")
    const strategy = read("lib/trade-engine/strategy-processor.ts")

    expect(cron).toContain('runIndStratCycle(connectionId, symbol, "realtime"')
    expect(cron).toContain("new IndicationProcessor(connection.id)")
    expect(cron).toContain("new RealtimeProcessor(connection.id)")
    expect(cron).toContain("new StrategyProcessor(connection.id)")
    expect(cron).toContain("new IndicationSetsProcessor(connection.id)")
    expect(cron).toContain("ensureCurrentMarketDataCandle(symbol, client, connection.id, connection)")
    expect(cron).toContain("marketDataKey(sym, \"\", connection.id)")
    expect(cron).toContain("const symbolConcurrency = parsePositiveInteger(process.env.CRON_SYMBOL_CONCURRENCY, 4)")
    expect(cron).toContain("const symbolsToProcess = allSymbols")
    expect(cron).not.toContain("allSymbols.slice(0, symbolLimit)")
    expect(cron).toContain("const legacyHistoricBatchHint = parsePositiveInteger(")
    expect(cron).toContain("symbolsToProcess,")
    expect(cron).not.toContain("executeStrategyFlowBatch(strategyItems.slice(0, 2)")
    expect(cron).not.toContain("strategyItems.slice(0, 2)")
    expect(cron).toContain("skipLiveDispatch: process.env.CRON_LIVE_DISPATCH")
    expect(cron).toContain("enableStrategyFlow: process.env.DISABLE_API_STRATEGY_FLOW === \"1\" ? false : true")

    const pseudoIdx = pipeline.indexOf("updateOpenPseudoPositionsForSymbol(symbol)")
    const strategyIdx = pipeline.lastIndexOf(".processStrategy(")
    expect(pseudoIdx).toBeGreaterThan(0)
    expect(strategyIdx).toBeGreaterThan(pseudoIdx)
    expect(pipeline).toContain("deps.enableStrategyFlow !== false")
    expect(pipeline).not.toContain("executeReadyStrategiesAsLiveOrders")
    expect(pipeline).not.toContain("__liveExecExports")
    expect(pipeline).not.toContain("Math.max(0.1, bestEntry.sizeMultiplier")
    expect(pipeline).toContain("Live exchange dispatch is intentionally owned by")
    expect(pipeline).toContain("StrategyCoordinator.createLiveSets()")
    expect(strategy).toContain("skipLiveDispatch: boolean = false")
    expect(strategy).toContain("skipLiveDispatch || isPrehistoric")
    expect(strategy).toContain("isCurrent,")
    expect(pipeline).toContain("shouldContinue?: () => boolean")
    expect(cron).toContain("isExpectedHistoricHandoff")
    expect(cron).toContain('"historic_generation_superseded"')
    expect(cron).toContain('"cron_work_budget_yield"')
    expect(cron).not.toContain("[v0] [CronIndications] Error: Error [PrehistoricProcessingCancelledError]")
  })

  test("current statistics and indication entrypoints never substitute samples or random values", () => {
    const progression = read("app/api/connections/progression/[id]/stats/route.ts")
    const strategyRow = read("components/strategies/strategy-row-compact.tsx")
    const presetStats = read("components/statistics/preset-trade-stats.tsx")
    const legacyEntrypoint = read("app/api/trade-engine/generate-indications/route.ts")
    const indicationData = read("app/api/data/indications/route.ts")

    expect(progression).toContain("mapInBatches")
    expect(progression).not.toContain("pseudoRaw.slice(0, 500)")
    expect(progression).not.toMatch(/lrange\([^)]*,\s*0,\s*499\)/)
    expect(strategyRow).not.toContain("Math.random")
    expect(presetStats).not.toContain("Math.random")
    expect(presetStats).toContain('String(position.preset_id || "") === String(preset.id)')
    expect(legacyEntrypoint).toContain('from "@/app/api/cron/generate-indications/route"')
    expect(legacyEntrypoint).not.toContain("generateDirectionIndication")
    expect(indicationData).toContain("mapWithConcurrency(configKeys, 32")
    expect(indicationData).not.toContain(".slice(0, 500)")
  })

  test("Signal's 120-position lease rebuilds from the complete mixed book then uses durable O(1) capacity indexes", () => {
    const signal = read("lib/signal-indication.ts")
    const policy = read("lib/signal-position-policy.ts")
    const settings = read("components/settings/signal-indication-settings.tsx")
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")
    const admissionStart = liveStage.indexOf("async function readPositionsForSignalAdmission")
    const admissionEnd = liveStage.indexOf("async function persistSignalCapacitySnapshot", admissionStart)
    const admission = liveStage.slice(admissionStart, admissionEnd)

    expect(signal).toContain("SIGNAL_PERFORMANCE_LOOKBACK = 12")
    expect(signal).toContain("PREVIOUS_POSITION_MIN_PF_RATIO")
    expect(signal).toContain("directExecutionEnabled: true")
    expect(signal).toContain("maxSourcesPerCycle: SIGNAL_SOURCE_DEFINITIONS.length")
    expect(signal).toContain("return { allowed: true, sourceAllowed: true, laneAllowed: true }")
    expect(policy).toContain("SIGNAL_MAX_POSITIONS_DEFAULT = 350")
    expect(settings).toContain("Signal Sources base positions limit (overall)")
    expect(settings).toContain("Automatic Previous-position bootstrap")
    expect(admission).toContain('lrange(`live:positions:${connectionId}`, 0, -1)')
    expect(admission).toContain("const READ_BATCH_SIZE = 250")
    expect(admission).not.toContain("lrange(`live:positions:${connectionId}`, 0, 500)")
    expect(admission).not.toContain("for (const id of ids) {\n      pipeline")
    expect(liveStage).toContain("SIGNAL_POSITION_ADMISSION_INDEX_VERSION")
    expect(liveStage).toContain("readSignalAdmissionCapacity")
    expect(liveStage).toContain("signal:positions:${connectionId}")
    expect(liveStage).toContain("findOpenLivePositionByDir(")
  })

  test("active strategy and position views use complete canonical ledgers without implicit demo state", () => {
    const strategyPage = read("app/strategies/page.tsx")
    const strategyApi = read("app/api/data/strategies/route.ts")
    const strategyRow = read("components/strategies/strategy-row-compact.tsx")
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")
    const positionsApi = read("app/api/positions/route.ts")
    const connectionStats = read("app/api/settings/connections/[id]/statistics/route.ts")
    const legacyStrategies = read("lib/strategies.ts")
    const legacyIndications = read("lib/indications.ts")

    expect(strategyPage).not.toContain('selectedConnectionId || "demo-mode"')
    expect(strategyPage).toContain("Strategy rows are loaded only from the selected connection")
    expect(strategyPage).toContain('}, 3_000)')
    expect(strategyApi).toContain('strategy_detail:${connectionId}:live')
    expect(strategyApi).toContain("getCanonicalConnectionSettingsOverlay(connectionId)")
    expect(strategyApi).toContain('normalizeMainTradeStagePfRatio("live"')
    expect(strategyApi).toContain("isActive: !stale && running > 0")
    expect(strategyApi).not.toContain("isActive: true")
    expect(strategyRow).toContain("disabled={!onToggle}")

    const liveGetterStart = liveStage.indexOf("export async function getLivePositions(")
    const liveGetterEnd = liveStage.indexOf("export async function getLivePositionsByStatus", liveGetterStart)
    const liveGetter = liveStage.slice(liveGetterStart, liveGetterEnd)
    expect(liveGetter).toContain('lrange(`live:positions:${connectionId}`, 0, -1)')
    expect(liveGetter).toContain("const READ_BATCH_SIZE = 32")
    expect(liveGetter).not.toContain("0, 500")

    expect(positionsApi).toContain("getOpenLivePositionReadModels(connectionId, LIVE_POSITION_OPEN_READ_LIMIT)")
    expect(positionsApi).toContain("getClosedLivePositionReadModels(connectionId, LIVE_POSITION_CLOSED_READ_LIMIT)")
    expect(positionsApi).toContain("possiblyTruncated")
    expect(positionsApi).not.toContain("live:positions:${connectionId}:closed`, 0, 99")
    expect(connectionStats).not.toContain("symbolsSet.slice(0, 50)")
    expect(connectionStats).toContain("const READ_BATCH_SIZE = 32")
    expect(legacyStrategies).not.toContain("return configs.slice(0, 50)")
    expect(legacyStrategies).not.toContain("return strategies.slice(0, 150)")
    expect(legacyIndications).not.toContain("return positions.slice(0, 250)")
  })

  test("QuickStart functional overview aggregates fresh canonical stage rows without fabricated PF", () => {
    const overview = read("app/api/trade-engine/functional-overview/route.ts")
    const progression = read("app/api/connections/progression/[id]/stats/route.ts")

    expect(overview).toContain("aggregateFunctionalOverviewStage")
    expect(overview).toContain("resolveOverviewActiveSymbols")
    expect(overview).toContain('semantics: "last-observed-active-symbol-rows-with-explicit-freshness"')
    expect(overview).toContain("OVERVIEW_STAGE_ROW_FRESH_MS")
    expect(overview).toContain("mapInBatches")
    expect(overview).toContain("client.dbSize()")
    expect(overview).toContain('dataSource: "canonical-stage-and-position-ledgers"')
    expect(overview).not.toContain('const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]')
    expect(overview).not.toContain("avgProfitFactorBase = 1.2")
    expect(overview).not.toContain("mainSetsCount * 4")
    expect(overview).not.toContain("each item ~200 bytes")
    expect(progression).not.toContain("baseWinRateProxy")
    expect(progression).not.toContain("approxSharpe")
    expect(progression).not.toContain("ratePerMin")
    expect(progression).not.toContain("indication_live_cycle_count),\n      n(progHash.indication_cycle_count)")
    expect(progression).toContain('client.zcount(`indications:${connectionId}:window`')
    expect(progression).toContain("indicationWindowMeasured")
    expect(progression).toContain("avgNotionalUsd")
    expect(progression).toContain("avgPosPerSet:    0")
    expect(read("components/dashboard/quickstart-overview-dialog.tsx")).not.toContain(
      "(value / totalIndAll) * evalMain5m",
    )
  })

  test("new custom preset types expose the Normal family and no Only selector", () => {
    const dialog = read("components/presets/preset-type-dialog.tsx")
    const createRoute = read("app/api/preset-types/route.ts")
    const updateRoute = read("app/api/preset-types/[id]/route.ts")

    expect(dialog).toContain("const [blockEnabled, setBlockEnabled] = useState(true)")
    expect(dialog).toContain("const [normalEnabled, setNormalEnabled] = useState(true)")
    expect(dialog).toContain("setBlockEnabled(presetType.block_enabled ?? true)")
    expect(dialog).not.toContain("Block Only")
    expect(dialog).not.toContain("DCA Only")
    expect(createRoute).toContain("block_enabled: body.block_enabled !== false")
    expect(createRoute).not.toContain("trailing_only: false")
    expect(createRoute).not.toContain("block_only: false")
    expect(createRoute).not.toContain("dca_only: false")
    expect(updateRoute).toContain("block_enabled: String(toBoolean(")
    expect(updateRoute).toContain('await client.hdel(key, "trailing_only", "block_only", "dca_only")')
    expect(updateRoute).toContain("normal_enabled: String(toBoolean(")
    expect(updateRoute).toContain("trailing_enabled: String(toBoolean(")
    expect(createRoute).toContain("await (client as any).persist(key)")
  })

  test("Base, Main, Real and Live remain mandatory steps with independent settings", () => {
    const dialog = read("components/settings/connection-settings-dialog.tsx")
    const settingsRoute = read("app/api/settings/connections/[id]/settings/route.ts")
    const strategiesRoute = read("app/api/settings/connections/[id]/strategies/route.ts")
    const migrations = read("lib/redis-migrations.ts")
    const stageEditor = dialog.slice(
      dialog.indexOf("function StrategyProfileEditor"),
      dialog.indexOf("// ── Strategy Options Panel"),
    )

    expect(stageEditor).toContain("Pipeline step · always active")
    expect(dialog).toContain("function normalizeStrategyChannel")
    expect(dialog).toContain("enabled: true")
    expect(stageEditor).not.toContain("onCheckedChange={(v) => update(type, { enabled: v })}")
    expect(settingsRoute).toContain("function enforceCombinedStrategyPipeline")
    expect(settingsRoute.match(/enforceCombinedStrategyPipeline\(/g)?.length).toBeGreaterThanOrEqual(4)
    expect(settingsRoute).toContain('"strategies", "coordination_settings", "coordinationSettings"')
    expect(strategiesRoute).toContain("is_enabled: true")
    expect(strategiesRoute).toContain("enabled: true")
    expect(strategiesRoute).not.toContain("is_enabled: !!strat.is_enabled")
    expect(migrations).toContain('strategy_stage_switches: "compatibility-only-always-true"')
    expect(read("lib/strategy-coordinator.ts")).toContain("normalEnabled: this._coordinationSettings.normalEnabled !== false")
    expect(read("lib/strategy-coordinator.ts")).not.toContain("blockOnly")
  })

  test("statistics never invent portfolio balance, TP/SL values, trailing values, or execution PF", () => {
    const analytics = read("lib/analytics.ts")
    const page = read("app/statistics/page.tsx")
    const table = read("components/statistics/strategy-performance-table.tsx")

    expect(analytics).toContain("grossProfit / grossLoss")
    expect(analytics).toContain("let balance = 0")
    expect(analytics).not.toContain("let balance = 10000")
    expect(analytics).not.toContain("trail_start: 0.6")
    expect(analytics).not.toContain("trail_stop: 0.2")
    expect(analytics).not.toContain("return 1.05")
    expect(analytics).not.toContain("return 2 // Default 2:1 ratio")
    expect(page).toContain(".map(toStatisticsPseudoPosition)")
    expect(page).not.toContain("takeprofit_factor: 2.0")
    expect(page).not.toContain("p.margin_used || 100")
    expect(table).toContain("TP Move")
  })

  test("Main axes and Base profiles remain exhaustive without a candidate ceiling", () => {
    const coordinator = read("lib/strategy-coordinator.ts")
    const configManager = read("lib/indication-config-manager.ts")

    expect(coordinator).toContain("complete, uncapped axis Cartesian product")
    expect(coordinator).not.toContain("cap at 1619")
    expect(coordinator).not.toContain("axis ceiling was")
    expect(configManager).not.toMatch(/\.slice\(\s*0\s*,\s*500\s*\)/)
  })


  test("trailing coordination survives Main cache and accumulated live sync", () => {
    const coordinator = read("lib/strategy-coordinator.ts")
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")

    expect(coordinator).toContain("trailingProfile: built.trailingProfile")
    expect(coordinator).toContain("Preserve it on")
    expect(coordinator).toContain("every Main projection")
    expect(coordinator).toContain("mutable cache patch")
    expect(coordinator).toContain("...(baseSet.trailingProfile && { trailingProfile: baseSet.trailingProfile })")

    expect(liveStage).toContain("setKey/parentSetKey/accumulatedSetKeys")
    expect(liveStage).toContain("every owning Set must be allowed")
    expect(liveStage).toContain("advance its trailing ratchet")
    expect(liveStage).toContain("const liveKeys = new Set<string>()")
    expect(liveStage).toContain("Array.isArray(p.accumulatedSetKeys)")
    expect(liveStage).toContain("liveKeys.has(pseudoSetKey)")
  })






  test("live exchange dispatch does not block testnet exchange positions", () => {
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")
    const injector = read("app/api/system/inject-credentials/route.ts")
    const liveTradeRoute = read("app/api/settings/connections/[id]/live-trade/route.ts")

    expect(liveStage).toContain("testnet connection — routing order through testnet connector endpoint")
    expect(liveStage).toContain("Live order proceeding on exchange testnet endpoint")
    expect(liveStage).not.toContain("Testnet connection detected — live order placement blocked")
    expect(injector).toContain("Preserve the operator-selected exchange environment")
    expect(injector).not.toContain("connectionId === 'bingx-x01' ? \"1\"")
    expect(liveTradeRoute).toContain("isTestnet: isTruthyFlag(connection.is_testnet)")
  })

  test("live-stage system-close-only is per-connection cached and honors connection settings", () => {
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")
    const cacheStart = liveStage.indexOf("const SYSTEM_CLOSE_TTL_MS")
    const cacheEnd = liveStage.indexOf("async function updateProtectionOrders", cacheStart)
    const cacheBlock = liveStage.slice(cacheStart, cacheEnd)

    expect(cacheBlock).toContain("systemCloseCacheByConnection")
    expect(cacheBlock).toContain("function parseSystemCloseFlag")
    expect(cacheBlock).toContain("getCachedSystemCloseOnly(connectionId: string)")
    expect(cacheBlock).toContain("settings:connection_settings:${connectionId}")
    expect(cacheBlock).toContain("connection_settings:${connectionId}")
    expect(cacheBlock).toContain("Per-connection settings win over global app settings")
    expect(liveStage).toContain("getCachedSystemCloseOnly(pos.connectionId)")
    expect(liveStage).toContain("parseSystemCloseFlag((pos as any)?.use_system_close_only)")
  })

  test("large paper books use a fair bounded position Stage instead of starving recovery requests", () => {
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")
    const simulatedSweep = liveStage.slice(
      liveStage.indexOf("export async function processSimulatedPositions"),
      liveStage.indexOf("export async function syncWithExchange"),
    )

    expect(liveStage).toContain("SIMULATED_POSITION_STAGE_BATCH_SIZE = 96")
    expect(liveStage).toContain("getSimulatedPositionStageRows")
    expect(liveStage).toContain("selectSimulatedPositionStageRows")
    expect(liveStage).toContain("updateSimulatedPositionStageRow(position)")
    expect(simulatedSweep).toContain("const allSimulated")
    expect(simulatedSweep).toContain("selectSimulatedPositionStageRows(connectionId, allSimulated)")
    expect(simulatedSweep).toContain("TP/SL, trailing and max-hold handling")

    const exchangeSync = liveStage.slice(liveStage.indexOf("export async function syncWithExchange"))
    const liveGateIndex = exchangeSync.indexOf("const liveTradeOn = await isLiveTradeEnabledForConnection(connectionId)")
    const lifecycleGateIndex = exchangeSync.indexOf("const hasOwnedExchangeLifecycle = lifecycleRows.some")
    const allOpenIndex = exchangeSync.indexOf("const allOpenRaw =")
    expect(liveGateIndex).toBeGreaterThan(-1)
    expect(lifecycleGateIndex).toBeGreaterThan(liveGateIndex)
    expect(allOpenIndex).toBeGreaterThan(lifecycleGateIndex)
    expect(exchangeSync).toContain("const simSummary = await processSimulatedPositions(connectionId)")
  })


  test("inline Redis memory cleanup protects durable engine state and evicts volatile progression data", () => {
    const source = read("lib/redis-db.ts")
    const cleanupStart = source.indexOf("private startTTLCleanup")
    const cleanupEnd = source.indexOf("private describeKeyFamilies", cleanupStart)
    const cleanupBlock = source.slice(cleanupStart, cleanupEnd)
    const evictionStart = source.indexOf("private evictOldRecords")
    const evictionEnd = source.indexOf("private cleanupVolatileRuntimeState", evictionStart)
    const evictionBlock = source.slice(evictionStart, evictionEnd)

    expect(cleanupBlock).toContain("process.memoryUsage?.()")
    expect(cleanupBlock).toContain("const isCritical = rssMB > CMEM.rssHardMB")
    expect(cleanupBlock).toContain("const isMemoryWarm")
    expect(cleanupBlock).toContain("const hasKeyPressure")
    expect(cleanupBlock).toContain("FULL_CLEANUP_INTERVAL_MS")
    expect(cleanupBlock).toContain("WARM_EVICTION_MIN_INTERVAL_MS")
    expect(cleanupBlock).toContain("Key count is not heap pressure")
    expect(cleanupBlock).toContain('cleanupVolatileRuntimeState({ mode: "activeOwnerSafe", reason: "critical-rss" })')
    expect(cleanupBlock).toContain("ttlCleanupTimer.unref?.()")
    expect(evictionBlock).toContain("Do not force a V8 collection here")
    expect(evictionBlock).not.toContain(";(globalThis as any).gc?.()")
    expect(source).toContain("const maxChunkBytes = 64 * 1024")
    expect(source).toContain("const cooperativeYieldEveryRows = 32")
    expect(source).toContain("const cooperativeYieldAfterMs = 1")
    expect(source).toContain("const stringKeys = Array.from(d.strings.keys())")
    expect(source).toContain("Map iterators include entries inserted after iteration began")
    expect(source).toContain("private hasActiveInlineEngineOwner")
    expect(source).toContain("INLINE_REDIS_SNAPSHOT_WHILE_ENGINE_RUNNING !== \"1\"")
    expect(source).toContain("full inline snapshot is intentionally a quiescent checkpoint")

    for (const durablePrefix of [
      'k.startsWith("live:position:")',
      'k.startsWith("live:positions:")',
      'k.startsWith("progression:")',
      'k.startsWith("connection:")',
      'k.startsWith("trade_engine:")',
      'k.startsWith("app_settings")',
    ]) {
      expect(evictionBlock).toContain(durablePrefix)
    }

    expect(evictionBlock).toContain("settings:pseudo_position")
    expect(evictionBlock).toContain("settings:strategies")
    expect(evictionBlock).toContain("transient pipeline data")
    expect(source).toContain("async cleanupVolatileRuntimeState")
  })



  test("production InlineLocalRedis is fail-closed unless explicitly enabled", () => {
    const redisDb = read("lib/redis-db.ts")
    const readiness = read("lib/production-readiness.ts")
    const envExample = read(".env.example")

    expect(redisDb).toContain("function isProdInlineRedisAllowed()")
    expect(redisDb).toContain("function isKiloLocalPreviewRuntime()")
    expect(redisDb).toContain("if (!isKiloLocalPreviewRuntime()) this.startPersistence()")
    expect(redisDb).toContain('return process.env.ALLOW_PROD_INLINE_REDIS === "1"')
    expect(redisDb).toContain("throw new Error(getMissingProductionRedisError())")
    expect(redisDb).toContain("ALLOW_INLINE_REDIS_LIVE_TRADING")
    expect(readiness).toContain('process.env.ALLOW_PROD_INLINE_REDIS === "1"')
    expect(readiness).toContain("!kiloLocalPreviewInlineAllowed")
    expect(readiness).toContain("ALLOW_PROD_INLINE_REDIS=1")
    expect(readiness).toContain('"Global coordinator requires shared Redis"')
    expect(readiness).toContain('"shared_persistence_required"')
    expect(envExample).toContain("ALLOW_PROD_INLINE_REDIS=0")
  })

  test("production readiness exempts credentials only under the explicit paper-mode override", () => {
    const readiness = read("lib/production-readiness.ts")
    expect(readiness).toContain('const forceSimulated = process.env.FORCE_SIMULATED === "1" && process.env.FORCE_LIVE !== "1"')
    expect(readiness).toContain("if (requireConnectionCredentials && !forceSimulated && !hasCreds)")
    expect(readiness).toContain("FORCE_LIVE always wins")
  })

  test("global pipelines cannot be deadlocked by a credentialless sibling connection", () => {
    const readiness = read("lib/production-readiness.ts")
    const autoStart = read("lib/trade-engine-auto-start.ts")
    const liveToggle = read("app/api/settings/connections/[id]/live-trade/route.ts")
    expect(readiness).toContain("requireConnectionCredentials?: boolean")
    expect(autoStart).toContain("assertProductionReadiness({ requireConnectionCredentials: false })")
    expect(autoStart).toContain("checkProductionReadiness({ requireConnectionCredentials: false })")
    expect(liveToggle).toContain("checkProductionReadiness({ requireConnectionCredentials: false })")
    expect(liveToggle).toContain("evaluateRealTradeReadiness({")
  })

  test("a targeted connection settings save never launches a global sibling healing sweep", () => {
    const source = read("lib/connection-recoordinator.ts")
    const targetedStart = source.slice(
      source.indexOf("if (globalRunning)"),
      source.indexOf("} else {", source.indexOf("if (globalRunning)")),
    )
    expect(targetedStart).toContain("coordinator.startMissingEngines([after])")
    expect(targetedStart).not.toContain("runTradeEngineHealingSweep")
  })

  test("simulated live-stage orders use the idempotent ledger path without polluting real counters", () => {
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")
    const simStart = liveStage.indexOf("if (!isLiveTradeEnabled) {")
    const simEnd = liveStage.indexOf("if (!exchangeConnector || typeof exchangeConnector.placeOrder !== \"function\")", simStart)
    const simBlock = liveStage.slice(simStart, simEnd)

    expect(simBlock).toContain("await savePosition(livePosition)")
    expect(simBlock).toContain("await recordFillCountersOnce(")
    expect(simBlock).toContain('incrementMetric(connectionId, "live_orders_simulated_count")')
    expect(simBlock).toContain('incrementMetric(connectionId, "live_simulated_positions_created_count")')
    expect(simBlock).not.toContain('incrementMetric(connectionId, "live_orders_placed_count")')
    expect(simBlock).not.toContain('incrementOrdersBySymbol(connectionId, realPosition.symbol, realPosition.direction, "placed")')
    expect(liveStage).toContain('await incrementMetric(connectionId, "live_orders_filled_count")')
    expect(liveStage).toContain('await incrementOrdersBySymbol(connectionId, symbol, direction, "filled")')
    expect(liveStage).toContain("await recordConfirmedStrategyEntry(connectionId, position")
    const liveOrderService = read("lib/live-order-service.ts")
    expect(liveOrderService).toContain('if (event === "simulated")')
    expect(liveOrderService).toContain('await client.hincrby(progKey, "live_orders_simulated_count", 1)')
    expect(liveOrderService).toContain('await client.hincrby(progKey, "live_simulated_positions_created_count", 1)')
    expect(liveOrderService).toContain('if (event !== "simulated") await recordPerSymbolOrderCounter')
    const statsRoute = read("app/api/connections/progression/[id]/stats/route.ts")
    expect(statsRoute).toContain("Real exchange and paper execution must stay deliberately separate")
    expect(statsRoute).toContain("simulatedPositionsCreated: n(progHash.live_simulated_positions_created_count)")
    expect(statsRoute).toContain("simulatedPositionsClosed:  n(progHash.live_simulated_positions_closed_count)")
    expect(statsRoute).toContain("simulatedPositionsOpen: Math.max(")
    expect(statsRoute).toContain("simulatedVolumeUsdTotal")
    expect(statsRoute).toContain("simulatedWinRate")
    const detailedLogs = read("app/api/trade-engine/detailed-logs/route.ts")
    expect(detailedLogs).toContain('simulatedPositionsCreated: progressionCounter("live_simulated_positions_created_count")')
    expect(detailedLogs).toContain('simulatedPositionsClosed: progressionCounter("live_simulated_positions_closed_count")')
    expect(detailedLogs).toContain("simulatedPositionsOpen")
    const productionSoak = read("scripts/verify-prod-soak.mjs")
    expect(productionSoak).toContain("liveExecution.simulatedPositionsCreated")
    expect(productionSoak).toContain("sample.simulatedPositionsCreated")
    expect(productionSoak).toContain("Forced-simulation soak mutated real exchange execution counters")
    expect(simBlock.indexOf("await savePosition(livePosition)")).toBeLessThan(
      simBlock.indexOf('incrementMetric(connectionId, "live_orders_simulated_count")'),
    )
  })

  test("live-stage save path maintains production reconciliation indexes", () => {
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")
    const saveStart = liveStage.indexOf("async function savePosition(position: LivePosition")
    const saveEnd = liveStage.indexOf(`/**
 * Batch save multiple positions`, saveStart)
    const saveBlock = liveStage.slice(saveStart, saveEnd)

    expect(saveBlock).toContain("live:position:tracking:${position.connectionId}:${trackingId}")
    expect(saveBlock).toContain("exchangeData.clientOrderIds")
    expect(saveBlock).toContain("exchangeData.exchangePositionId")
    expect(saveBlock).toContain("const liveSetIndexKey = `live_set_keys:${position.connectionId}`")
    expect(saveBlock).toContain("getLivePositionSetLineageKeys(position)")
    expect(saveBlock).toContain("await client.sadd(liveSetIndexKey, setKey)")
    expect(saveBlock).toContain("await client.srem(liveSetIndexKey, setKey)")
    expect(saveBlock).toContain("await keepDurable(liveSetIndexKey)")
  })

  test("live positions route does not use production KEYS fallback", () => {
    const route = read("app/api/trading/live-positions/route.ts")
    const altIndex = read("lib/live-position-alt-index.ts")

    expect(route).toContain("getAlternateLivePositionKeys")
    expect(route).toContain("partialLegacyScan")
    expect(route).not.toMatch(/(?:client|getRedisClient\(\))\.keys\s*\(/)
    expect(route).not.toContain("export async function indexAlternateLivePositionKey")

    expect(altIndex).toContain("live:position:live:${connectionId}:index")
    expect(altIndex).toContain("client.scan")
    expect(altIndex).toContain("LEGACY_SCAN_MAX_KEYS")
    expect(altIndex).toContain("indexAlternateLivePositionKey")
  })

  test("hot-path performance guards cover stats, rotating Real overlays, exhaustive strategy input, and heap telemetry", () => {
    const statsRoute = read("app/api/connections/progression/[id]/stats/route.ts")
    const coordinator = read("lib/strategy-coordinator.ts")
    const setsProcessor = read("lib/strategy-sets-processor.ts")
    const engineManager = read("lib/trade-engine/engine-manager.ts")

    expect(statsRoute).toContain("const slowDiagnostic = setTimeout")
    expect(statsRoute).toContain("clearTimeout(slowDiagnostic)")
    expect(coordinator).toContain("PositionContext")
    expect(coordinator).toContain("perSymbolOpenByDir")
    expect(coordinator).toContain("posCtx?.perSymbolOpenByDir?.[symbol] ?? { long: 0, short: 0 }")
    expect(coordinator).toContain("strategyBlockMaterializationBatchSize")
    expect(coordinator).toContain("materializationCursor")
    expect(setsProcessor).toContain("let selectedTotal = 0")
    expect(setsProcessor).toContain("rejectedDirectionTotal++")
    expect(setsProcessor).not.toContain("selectTopIndications")
    expect(engineManager).toContain("process.memoryUsage().heapTotal")
    expect(engineManager).not.toContain('require("v8")')
    expect(engineManager).not.toContain("JSON.stringify(effectiveForceSymbols)")
  })

  test("unchanged 280ms Direct-Trade pulses reuse an exact snapshot without hiding closed outcomes", () => {
    const setProcessor = read("lib/indication-sets-processor.ts")

    expect(setProcessor).toContain("EXACT_SNAPSHOT_CACHE_MAX_AGE_MS")
    expect(setProcessor).toContain("function realtimeMarketSignature")
    expect(setProcessor).toContain('if (mode !== "historical")')
    expect(setProcessor).toContain("invalidateExactSnapshotCache")
    expect(setProcessor).toContain("exactSnapshotCacheKey(this.connectionId, symbol, marketData)")
    expect(setProcessor).toContain("const closedForwardOutcomes = this.currentCyclePersistenceEnabled")
    expect(setProcessor).toContain("const refreshed = closedForwardOutcomes")
    expect(setProcessor).toContain("refreshCachedOutcomeRows(cached)")
    expect(setProcessor).toContain("writeExactSnapshotCache(snapshotKey, refreshed)")
    expect(setProcessor).toContain("writeExactSnapshotCache(snapshotKey, completed)")
    expect(setProcessor).toContain("private async closePendingRealtimeOutcomes(symbol: string, marketData: any): Promise<boolean>")
    const indicationProcessor = read("lib/trade-engine/indication-processor-fixed.ts")
    expect(indicationProcessor).toContain('__indicationSnapshotMode: isHistorical ? "historical" : "realtime"')
  })

  test("historic replay is fair to the 280ms Direct-Trade control plane", () => {
    const engineManager = read("lib/trade-engine/engine-manager.ts")

    expect(engineManager).toContain("PREHISTORIC_REPLAY_SYMBOLS_PER_TICK")
    expect(engineManager).toContain("PREHISTORIC_REPLAY_MIN_PAUSE_MS")
    expect(engineManager).toContain("const scheduledSymbols = Array.from(")
    expect(engineManager).toContain("mapWithConcurrency(scheduledSymbols, replayConcurrency, replayOneSymbol, { yieldEvery: 1 })")
    expect(engineManager).toContain("replaySymbolCursor = (replaySymbolCursor + scheduledSymbols.length) % symbols.length")
  })


  test("settings recoordination fingerprints live sizing, leverage, margin, and control-order settings", () => {
    const recoordinator = read("lib/connection-recoordinator.ts")
    const progression = read("lib/progression-state-manager.ts")
    const settingsCoordinator = read("lib/settings-coordinator.ts")

    for (const field of [
      "live_volume_factor",
      "preset_volume_factor",
      "volume_step_ratio",
      "leveragePercentage",
      "useMaximalLeverage",
      "maxLeverage",
      "margin_type",
      "position_mode",
      "useSystemCloseOnly",
      "use_system_close_only",
    ]) {
      expect(recoordinator).toContain(`"${field}"`)
      expect(progression).toContain(`"${field}"`)
      expect(settingsCoordinator).toContain(`"${field}"`)
    }

    expect(recoordinator).toContain("const destructiveProgressionChange = symbolsChanged")
    expect(recoordinator).not.toContain("const destructiveProgressionChange = symbolsChanged || modeChanged")
    expect(recoordinator).toContain("const liveOrderSettingsChanged = hasAnyChangedField(normalizedChangedFields, LIVE_ORDER_SETTING_FIELDS)")
    expect(recoordinator).toContain("const requiresProgressRecoordination = destructiveProgressionChange || strategyOrCoordinationChanged")
    expect(recoordinator).toContain("if (requiresProgressRecoordination || liveOrderSettingsChanged)")
    expect(recoordinator).toContain('settings_recoordination_reason: "live-order-settings-reload:queued-for-processing"')
    expect(recoordinator).toContain("strategy_recompute_requested")
    expect(recoordinator).toContain('reason: "live-sizing-order-protection-settings"')
    expect(recoordinator).toContain("Strategy/coordination changes deliberately stay hot-reload-only")
    expect(settingsCoordinator).toContain("PROGRESSION_RESTART_FIELDS")
    expect(settingsCoordinator).toContain("HOT_RELOAD_FIELDS")
  })

  test("live control-order system-close mode is scoped, cached, and order-limit safe", () => {
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")
    const cacheStart = liveStage.indexOf("const SYSTEM_CLOSE_TTL_MS")
    const cacheEnd = liveStage.indexOf("async function updateProtectionOrders", cacheStart)
    const cacheBlock = liveStage.slice(cacheStart, cacheEnd)
    const protectionStart = liveStage.indexOf("async function updateProtectionOrders")
    const protectionEnd = liveStage.indexOf("async function", protectionStart + 1)
    const protectionBlock = liveStage.slice(protectionStart, protectionEnd)

    expect(cacheBlock).toContain("systemCloseCacheByConnection")
    expect(cacheBlock).toContain("Promise.all")
    expect(cacheBlock).toContain("getAppSettings().catch")
    expect(cacheBlock).toContain("settings:connection_settings:${connectionId}")
    expect(cacheBlock).toContain("connection_settings:${connectionId}")
    expect(cacheBlock).toContain("const merged = {")
    expect(cacheBlock).toContain("...(appSettings || {}),")
    expect(cacheBlock).toContain("...(connSettings || {}),")
    expect(cacheBlock).toContain("...(prefixedConnSettings || {}),")
    expect(cacheBlock).not.toContain("_systemCloseCacheValue")
    expect(cacheBlock).not.toContain("_systemCloseInflight")

    expect(protectionBlock).toContain("getCachedSystemCloseOnly(pos.connectionId)")
    expect(protectionBlock).toContain("cancelProtectionOrder(connector, pos.symbol, pos.stopLossOrderId")
    expect(protectionBlock).toContain("cancelProtectionOrder(connector, pos.symbol, pos.takeProfitOrderId")
    expect(protectionBlock).toContain("return result")
  })

  test("recoordination stamps missing or anonymous progression snapshots", () => {
    const source = read("lib/progression-state-manager.ts")
    const start = source.indexOf("static async recoordinateForActualOne")
    const end = source.indexOf("static async ensureJustUniqueProgression", start)
    const block = source.slice(start, end)

    expect(block).toContain("let initializedMissingProgression = false")
    expect(block).toContain("Keep going after creation so we immediately stamp")
    expect(block).toContain("initializedMissingProgression = true")
    expect(block).toContain('const settingsMismatch = storedFingerprint === "" || storedFingerprint !== liveFingerprint')
    expect(block).toContain("if (initializedMissingProgression)")
    expect(block).toContain("completedHistoricCacheMatches")
    expect(block).toContain("completed_progression_fingerprint")
    expect(block).toContain("verified-process-restart-cache")
    expect(block).toContain("progress_settings_snapshot: JSON.stringify(liveSnapshot)")
    expect(block).toContain("client.del(`realtime:${connectionId}`)")
    expect(block).toContain('reason: "no active progression"')
  })

  test("live progression verification scripts remain runnable and phase-aware", () => {
    const liveScript = read("scripts/test-progression-live.mjs")
    const stabilityScript = read("scripts/verify-stability.sh")

    expect(liveScript).toContain("const baseUrl = process.env.BASE_URL || `http://localhost:${port}`")
    expect(liveScript).toContain("'starting'")
    expect(liveScript).toContain("const historicTotal = Number(stats.historic?.symbolsTotal ?? 0)")
    expect(liveScript).not.toContain("const activeIndications = stats.activeCounts?.indications || {};\n  const activeIndications")
    expect(liveScript).toContain("const openPositionsList = Array.isArray(openPositionsValue) ? openPositionsValue : []")

    expect(stabilityScript).toContain("PASSED=$((PASSED+1))")
    expect(stabilityScript).toContain("FAILED=$((FAILED+1))")
    expect(stabilityScript).not.toContain("((PASSED++))")
    expect(stabilityScript).not.toContain("((FAILED++))")
  })

  test("progression stats timeout timer is cleared after successful polls", () => {
    const statsRoute = read("app/api/connections/progression/[id]/stats/route.ts")

    expect(statsRoute).toContain("const slowDiagnostic = setTimeout")
    expect(statsRoute).toContain("slowDiagnostic.unref?.()")
    expect(statsRoute).toContain("finally {")
    expect(statsRoute).toContain("clearTimeout(slowDiagnostic)")
  })

  test("progression stats cache never carries request-bound Response objects across Workerd requests", () => {
    const statsRoute = read("app/api/connections/progression/[id]/stats/route.ts")

    expect(statsRoute).toContain("type StatsResponseSnapshot")
    expect(statsRoute).toContain("responseFromStatsSnapshot")
    expect(statsRoute).toContain("snapshotStatsResponse")
    expect(statsRoute).toContain("body: await response.text()")
    expect(statsRoute).not.toContain("response: response.clone()")
    expect(statsRoute).not.toContain("cached.response.clone()")
  })

  test("real-stage active block overlays reuse per-cycle direction indexes", () => {
    const coordinator = read("lib/strategy-coordinator.ts")
    const fnStart = coordinator.indexOf("private async buildActiveRealBlockOverlaysForReal")
    const fnEnd = coordinator.indexOf("private async createLiveSets", fnStart)
    const blockFn = coordinator.slice(fnStart, fnEnd)

    expect(blockFn).toContain("activeRealByDirSnapshot?: { long: number; short: number }")
    expect(blockFn).toContain("activeLiveByDirSnapshot?: { long: number; short: number }")
    expect(blockFn).toContain("Use the PositionContext snapshot built once per cycle")
    expect(blockFn).toContain("activeRealByDirSnapshot")
    expect(blockFn).toContain("activeLiveByDirSnapshot")
    expect(blockFn).toContain("if (this._coordinationSettings.blockActiveRealEnabled && !activeRealByDirSnapshot)")
    expect(coordinator).toContain("posCtx?.perSymbolOpenByDir?.[symbol] ?? { long: 0, short: 0 }")
    expect(coordinator).toContain("posCtx?.perSymbolLiveOpenByDir?.[symbol] ?? { long: 0, short: 0 }")
  })

  test("dashboard footer and production monitoring bar stay visible at page bottom", () => {
    const source = read("components/dashboard/dashboard.tsx")
    const monitor = read("components/dashboard/system-monitoring-panel.tsx")

    expect(source).toContain("function DashboardRuntimeFooter()")
    expect(source).toContain("Current service session")
    expect(source).toContain("data?.startup?.boot_id")
    expect(source).toContain("data?.startup?.started_at")
    expect(source).toContain("Restarts/reloads:")
    expect(source).not.toContain("cts-v-dashboard-started-at")
    expect(source).not.toContain("createSessionInstanceId")
    expect(source).toContain("Running: {formatDuration")
    expect(source).toContain("<DashboardRuntimeFooter />")
    expect(source.indexOf("<DashboardRuntimeFooter />")).toBeLessThan(source.indexOf("<SystemMonitoringPanel />"))

    expect(monitor).toContain("DEFAULT_MONITOR")
    expect(monitor).toContain('useState<CompactMonitor>(DEFAULT_MONITOR)')
    expect(monitor).not.toContain("if (!data) return null")
    expect(monitor).toContain("monitoring unavailable")
    expect(monitor).toContain("CPU")
    expect(monitor).toContain("Mem")
    expect(monitor).toContain("Redis")
  })

  test("the Overall editor closes only after verified Settings persistence", () => {
    const page = read("app/settings/page.tsx")
    const dialog = read("components/settings/settings-editor-dialog.tsx")
    const overall = read("components/settings/tabs/overall-tab.tsx")

    expect(page).toContain("const saveAllSettings = async (settingsOverride?: Settings): Promise<boolean>")
    expect(page).toContain("settingsData?.persistenceVerified !== true")
    expect(dialog).toContain("const saved = await onSave(settings)")
    expect(dialog).toContain("if (saved !== false) onOpenChange(false)")
    expect(overall).toContain("return saveSettings(updatedSettings)")
  })

  test("getConnection merges credentials and exchange settings from settings connection hash", async () => {
    jest.resetModules()
    jest.unmock("@/lib/redis-db")
    jest.doMock("@/lib/redis-migrations", () => ({
      getLatestMigrationVersion: jest.fn(() => 0),
      runMigrations: jest.fn(async () => undefined),
      resetMigrationRunState: jest.fn(),
    }))

    const redisDb = await import("@/lib/redis-db")
    await redisDb.initRedis()
    const client = redisDb.getRedisClient()
    await client.flushDb()

    await client.hset("connection:bingx-x01", {
      id: "bingx-x01",
      name: "BingX X01",
      exchange: "",
      updated_at: "2026-07-07T00:00:00.000Z",
    })
    await client.hset("settings:connection:bingx-x01", {
      api_key: "settings-api-key",
      api_secret: "settings-api-secret",
      api_passphrase: "settings-passphrase",
      exchange: "bingx",
      api_type: "swap",
      contract_type: "perpetual",
      margin_type: "cross",
      position_mode: "one_way",
      is_testnet: "0",
      live_volume_factor: "0.1",
      force_symbols: JSON.stringify(["BTCUSDT", "ETHUSDT"]),
      updated_at: "2026-07-08T00:00:00.000Z",
    })

    const connection = await redisDb.getConnection("bingx-x01")

    expect(connection).toMatchObject({
      id: "bingx-x01",
      name: "BingX X01",
      api_key: "settings-api-key",
      api_secret: "settings-api-secret",
      api_passphrase: "settings-passphrase",
      exchange: "bingx",
      api_type: "swap",
      contract_type: "perpetual",
      margin_type: "cross",
      position_mode: "one_way",
      is_testnet: false,
      live_volume_factor: 0.1,
      force_symbols: ["BTCUSDT", "ETHUSDT"],
    })

    await client.flushDb()
  })

  test("live position mutation helpers preserve token/version semantics without Redis EVAL", () => {
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")

    expect(liveStage).toContain("InlineLocalRedis / minimal test clients may not expose EVAL")
    expect(liveStage).toContain("script.includes('redis.call(\"GET\", KEYS[1])')")
    expect(liveStage).toContain("script.includes('redis.call(\"HGET\", KEYS[1], \"version\")')")
    expect(liveStage).toContain("if (currentVersion !== args[0]) return 0")
    expect(liveStage).toContain("if (!allowed.includes(currentStatus)) return 0")
    expect(liveStage).toContain('throw new Error("Redis client does not support EVAL")')
  })

  test("real live trading is blocked when shared Redis is missing in any server mode", () => {
    const gates = read("lib/real-trade-gates.ts")
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")

    expect(gates).toContain("getRealTradeBlockReason")
    expect(gates).toContain('process.env.NODE_ENV === "production"')
    expect(gates).toContain('process.env.ALLOW_LIVE_ORDER_PLACEMENT !== "1"')
    expect(gates).toContain("hasDurableLiveCoordination()")
    expect(gates).toContain("!hasSharedRedisConfig() &&")
    expect(gates).toContain("ALLOW_INLINE_REDIS_LIVE_TRADING")
    expect(gates).toContain("ALLOW_KILO_SQLITE_LIVE_TRADING")
    expect(gates).toContain("shared Redis is not configured")
    expect(liveStage).toContain("readinessIntentForExecution(connSettings, executionIntent)")
    expect(liveStage).toContain("evaluateRealTradeReadiness(connSettings, readinessIntent)")
    expect(liveStage).toContain("readinessIntentForExecution(freshSettings, freshExecutionIntent)")
    expect(liveStage).toContain("evaluateRealTradeReadiness(freshSettings, freshReadinessIntent)")
    expect(liveStage).toContain("A requested live run must fail visibly")
    expect(liveStage).toContain('livePosition.executionMode = "blocked"')
  })

  test("settings dialog saves are single-pass and do not replay stale delayed state", () => {
    const settingsRoute = read("app/api/settings/connections/[id]/settings/route.ts")
    const recoordinator = read("lib/connection-recoordinator.ts")

    expect(settingsRoute).toContain("Recoordination is intentionally centralized in recoordinateAfterSettingsChange() below")
    expect(settingsRoute).not.toContain("ProgressionStateManager.recoordinateForActualOne(id)")
    expect(settingsRoute).not.toContain("setTimeout(() =>")
    expect(settingsRoute).toContain("settingsPatch,")
    expect(recoordinator).toContain("await writeOrBundle(`settings:connection_settings:${id}`, hashPatch)")
    expect(recoordinator).toContain("relatedHashPatches")
    expect(settingsRoute).toContain("making progression appear to switch between old and new settings")

    expect(recoordinator).toContain("runSerializedForConnection")
    expect(recoordinator).toContain("destructiveProgressionChange")
    expect(recoordinator).toContain("settings_recoordination_pending")
  })

  test("volume saves stay explicit and do not start an immediate historic pass", () => {
    const volumeRoute = read("app/api/settings/connections/[id]/volume/route.ts")
    const engineManager = read("lib/trade-engine/engine-manager.ts")
    const fields = read("lib/trade-engine/settings-change-fields.ts")

    expect(volumeRoute).toContain("changedFieldsOverride: Array.from(new Set([...Object.keys(patch), ...Object.keys(settingsPatch)]))")
    expect(volumeRoute).not.toContain('...Object.keys(settingsPatch), "connection_settings"')
    expect(fields).toContain("export function isLiveSizingOnlyChange")
    expect(engineManager).toContain("const immediateStrategyReevaluationRequired =")
    expect(engineManager).toContain("!isLiveSizingOnlyChange(changedFields)")
    expect(engineManager).toContain("if (immediateStrategyReevaluationRequired)")
  })

  test("trailing range settings drive recoordination, Set accounting, and control-order variant labels", () => {
    const coordinator = read("lib/strategy-coordinator.ts")
    const settingsCoordinator = read("lib/settings-coordinator.ts")
    const recoordinator = read("lib/connection-recoordinator.ts")
    const progression = read("lib/progression-state-manager.ts")

    for (const field of ["strategyBaseTrailingEnabled", "strategyBaseTrailingVariants", "trailingMinStep"]) {
      expect(settingsCoordinator).toContain(`"${field}"`)
      expect(recoordinator).toContain(`"${field}"`)
      expect(progression).toContain(`"${field}"`)
    }

    expect(coordinator).toContain("const settings = { ...(appSettings as Record<string, unknown>), ...connSettings }")
    expect(coordinator).toContain("trailing_sets:        String(baseTrailingSets)")
    expect(coordinator).toContain("[`s:${symbol}:trailing`]:   String(baseTrailingSets)")
    expect(coordinator).toContain("[`${symbol}:base:trailing`]: String(baseTrailingRunningNow)")
    expect(coordinator).toContain('cached.variant = "trailing"')
    expect(coordinator).toContain('(set.variant ?? profile.name) as SetCoordRecord["variant"]')
    expect(coordinator).toContain('baseDefault.trailingProfile && baseDefault.indicationType !== "special"')
  })


  test("max stop-loss ratio setting gates Base pseudo Set SL range systemwide", () => {
    const settingsTypes = read("components/settings/types.ts")
    const defaults = read("components/settings/utils.ts")
    const settingsRoute = read("app/api/settings/connections/[id]/settings/route.ts")
    const settingsDialog = read("components/settings/connection-settings-dialog.tsx")
    const settingsCoordinator = read("lib/settings-coordinator.ts")
    const recoordinator = read("lib/connection-recoordinator.ts")
    const progression = read("lib/progression-state-manager.ts")
    const slRange = read("lib/stoploss-ratio-range.ts")
    const basePseudo = read("lib/base-pseudo-position-manager.ts")
    const indicationState = read("lib/indication-state-manager.ts")
    const calculator = read("lib/indication-calculator.ts")

    expect(settingsTypes).toContain("maxStopLossRatio: number")
    expect(defaults).toContain("maxStopLossRatio: DEFAULT_MAX_STOP_LOSS_RATIO")
    expect(settingsDialog).toContain("Max StopLoss Ratio (0.25–2.5)")
    expect(settingsDialog).toContain("default 2.5 (max)")
    expect(settingsRoute).toContain('"maxStopLossRatio"')
    expect(settingsRoute).toContain('"max_stoploss_ratio"')

    for (const source of [settingsCoordinator, recoordinator, progression]) {
      expect(source).toContain('"maxStopLossRatio"')
      expect(source).toContain('"max_stoploss_ratio"')
    }

    expect(slRange).toContain("STOP_LOSS_RATIO_MIN = 0.25")
    expect(slRange).toContain("STOP_LOSS_RATIO_MAX = 2.5")
    expect(slRange).toContain("STOP_LOSS_RATIO_STEP = 0.25")
    expect(basePseudo).toContain("if (Number(config.slRatio) > maxStopLossRatio)")
    expect(indicationState).toContain("const slRatios = await this.getStopLossRatios()")
    expect(calculator).toContain("Math.floor((2.5 - 0.25) / 0.25) + 1")
  })

  test("BingX live order/control path defaults to the bingx-api library fast path", () => {
    const bingx = read("lib/exchange-connectors/bingx-connector.ts")
    const factory = read("lib/exchange-connectors/factory.ts")
    const marketData = read("lib/market-data-loader.ts")
    const connectionTests = read("lib/connection-test-scheduler.ts")
    const engineManager = read("lib/trade-engine/engine-manager.ts")
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")
    const migrations = read("lib/redis-migrations.ts")

    expect(bingx).toContain("public async warmUpFastPath()")
    expect(bingx).toContain("tradeService.tradeOrder")
    expect(bingx).toContain('recordSdkFallback("placeStopOrder"')
    expect(factory).toContain('connectionLibrary: this.resolveExchangeName(connection) === "bingx" ? "sdk"')
    expect(marketData).toContain("exchangeConnectorFactory.getOrCreateConnector(String(conn.id))")
    expect(engineManager).toContain('connectionId: this.connectionId')
    expect(connectionTests).toContain("exchangeConnectorFactory.getOrCreateConnector(connection.id)")
    expect(connectionTests).not.toContain("isTestnet: false, // Always mainnet")
    expect(liveStage).toContain("EXCHANGE_TIMEOUT_PLACE_STOP_MS    = 8_000")
    expect(liveStage).toContain("const [slPlacement, tpPlacement] = await Promise.all")
    expect(liveStage).toContain("const slOrderId = slPlacement.orderId")
    expect(liveStage).toContain("const tpOrderId = tpPlacement.orderId")
    expect(migrations).toContain("066-bingx-sdk-fast-order-default")
    expect(migrations).toContain('connection_library: "sdk"')
  })

  test("realtime and monitoring surfaces never present random telemetry as live", () => {
    const marketMonitor = read("components/realtime/market-data-monitor.tsx")
    const marketRoute = read("app/api/market-data/route.ts")
    const healthRoute = read("app/api/monitoring/health/route.ts")
    const positionMonitor = read("components/realtime/position-monitor.tsx")
    const positionRoute = read("app/api/data/positions/route.ts")
    const connectionState = read("components/dashboard/connection-state-tabs.tsx")
    const logistics = read("lib/logistics-workflow.ts")

    for (const source of [marketMonitor, marketRoute, healthRoute, connectionState, logistics]) {
      expect(source).not.toContain("Math.random()")
    }

    expect(marketMonitor).toContain("Paper/synthetic engine snapshots (never presented as live)")
    expect(marketMonitor).toContain('setStatus("simulated")')
    expect(marketRoute).toContain("Synthetic engine data is explicitly labelled")
    expect(marketRoute).toContain("no configured symbol is sliced or dropped")
    expect(marketRoute).toContain("MARKET_READ_CONCURRENCY = 8")
    expect(marketRoute).not.toContain("getBasePrice")
    expect(healthRoute).toContain("getSystemResourceMetrics")
    expect(healthRoute).toContain("getDashboardWorkflowSnapshot")
    expect(healthRoute).not.toContain("System Operational")
    expect(positionMonitor).toContain("/api/data/positions?connectionId=")
    expect(positionMonitor).toContain("payload.data")
    expect(positionMonitor).not.toContain("/api/positions/${connectionId}")
    expect(positionRoute).toContain("lrange(`live:positions:${connectionId}`, 0, -1)")
    expect(positionRoute).not.toContain("lrange(`live:positions:${connectionId}`, 0, 500)")
    expect(connectionState).toContain("/api/structure/metrics?connectionId=")
    expect(logistics).toContain("Math.max(...latencySamples)")
    expect(logistics).not.toContain("avgLatency + 120")
  })

  test("Indications page reads every canonical exact snapshot and exposes measured filters", () => {
    const route = read("app/api/data/indications/route.ts")
    const page = read("app/indications/page.tsx")
    const filters = read("components/indications/indication-filters-advanced.tsx")
    const row = read("components/indications/indication-row-compact.tsx")

    expect(route).toContain("indications_snapshot:index:${connectionId}")
    expect(route).toContain("scanSnapshotKeys")
    expect(route).toContain("mapWithConcurrency(snapshotKeys, 32")
    expect(route).toContain("Common · ${commonName.toUpperCase()}")
    expect(route).not.toContain("indications:${connectionId}:${t}:latest")
    expect(page).not.toContain('resolvedConnectionId || "demo-mode"')
    expect(page).toContain("availableSymbols={availableSymbols}")
    expect(page).toContain("availableTypes={availableTypes}")
    expect(page).toContain("Exported ${rows.length} measured indications")
    expect(filters).not.toContain('const defaultSymbols = ["BTC"')
    expect(filters).toContain("availableTypes.map")
    expect(row).toContain("Runtime indication state (read only)")
  })

  test("monitoring pages use canonical ledgers and the current bounded log index", () => {
    const system = read("app/api/monitoring/system/route.ts")
    const comprehensive = read("app/api/monitoring/comprehensive/route.ts")
    const logs = read("app/api/monitoring/logs/route.ts")
    const logger = read("lib/system-logger.ts")
    const monitoringPage = read("app/monitoring/page.tsx")

    expect(system).toContain("getDashboardWorkflowSnapshot")
    expect(system).toContain("getOpenLivePositionReadModels(connectionId, LIVE_POSITION_OPEN_READ_LIMIT)")
    expect(system).toContain("new PseudoPositionManager(connectionId).getActivePositions()")
    expect(system).not.toContain("getPseudoPositions(undefined, 10)")
    expect(system).not.toContain('status: "running"')
    expect(comprehensive).toContain("getClosedLivePositionReadModels(connectionId, LIVE_POSITION_CLOSED_READ_LIMIT)")
    expect(comprehensive).toContain("getSystemResourceMetrics")
    expect(comprehensive).not.toContain("DatabaseManager")
    expect(logs).toContain("SystemLogger.getLogs")
    expect(logs).not.toContain('smembers("logs:all")')
    expect(logger).toContain('pipeline.lpush("logs:all:list", logId)')
    expect(logger).toContain('pipeline.expire("logs:all:list", 604800)')
    expect(logger).toContain('pipeline.expire(`logs:${category}:list`, 604800)')
    expect(monitoringPage).toContain("[selectedConnectionId]")
  })

  test("queued refresh requests stay durable when drained by a non-owner process", () => {
    const source = read("lib/trade-engine.ts")

    expect(source).toContain("Refresh request for ${request.connectionId} is not local; leaving queued for owner")
    expect(source).toContain("if (!this.isEngineRunning(request.connectionId))")
    expect(source).toMatch(/if \(!this\.isEngineRunning\(request\.connectionId\)\) {[\s\S]*?return "defer"[\s\S]*?await this\.applyPendingChangesNow\(request\.connectionId\)/)
  })


  test("progression-visible settings include flattened coordination and leverage keys", () => {
    const route = read("app/api/settings/connections/[id]/settings/route.ts")
    const setStart = route.indexOf("const PROGRESSION_VISIBLE_SETTING_KEYS = new Set([")
    expect(setStart).toBeGreaterThanOrEqual(0)
    const setBlock = route.slice(setStart, route.indexOf("])", setStart) + 2)

    for (const key of [
      "variantTrailingEnabled",
      "variantBlockEnabled",
      "variantDcaEnabled",
      "axisPrevEnabled",
      "axisLastEnabled",
      "axisContEnabled",
      "axisPauseEnabled",
      "axisPrevMaxWindow",
      "axisLastMaxWindow",
      "axisContMaxWindow",
      "axisPauseMaxWindow",
      "blockVolumeRatio",
      "blockProfitFactorRatio",
      "blockMaxStack",
      "blockPauseCountRatio",
      "blockActiveRealEnabled",
      "blockActiveLiveEnabled",
      "useSystemCloseOnly",
      "use_system_close_only",
      "leveragePercentage",
      "useMaximalLeverage",
    ]) {
      expect(setBlock).toContain(`"${key}"`)
    }
  })


  test("settings PATCH keeps symbol/settings persistence single-writer until recoordination apply", () => {
    const route = read("app/api/settings/connections/[id]/settings/route.ts")
    const patchStart = route.indexOf("export async function PATCH")
    const applyStart = route.indexOf("const { connection: appliedConnection", patchStart)
    expect(patchStart).toBeGreaterThanOrEqual(0)
    expect(applyStart).toBeGreaterThan(patchStart)

    const beforeApply = route.slice(patchStart, applyStart)
    expect(beforeApply).toContain("Settings saves must stay")
    expect(beforeApply).not.toContain("updateConnection(")
    expect(beforeApply).not.toContain("setSettings(")
    expect(beforeApply).not.toContain(".hset(")
  })

  test("settings PATCH mirrors flattened progression-visible fields into both trade-engine state hashes", async () => {
    jest.resetModules()

    const hset = jest.fn().mockResolvedValue(1)
    const connection = {
      id: "conn-progress-visible",
      name: "Progress Visible",
      exchange: "bingx",
      connection_settings: {},
      updated_at: "2026-07-09T00:00:00.000Z",
    }

    jest.doMock("@/lib/redis-db", () => ({
      initRedis: jest.fn().mockResolvedValue(undefined),
      getConnection: jest.fn().mockResolvedValue(connection),
      updateConnection: jest.fn(async (_id: string, patch: Record<string, unknown>) => ({ ...connection, ...patch })),
      getRedisClient: jest.fn(() => ({ hset })),
      setSettings: jest.fn().mockResolvedValue(undefined),
      getSettings: jest.fn().mockResolvedValue({}),
      persistNow: jest.fn().mockResolvedValue(undefined),
    }))
    jest.doMock("@/lib/system-logger", () => ({
      SystemLogger: {
        logConnection: jest.fn().mockResolvedValue(undefined),
        logError: jest.fn().mockResolvedValue(undefined),
      },
    }))
    jest.doMock("@/lib/redis-operations", () => ({
      RedisTrades: { getTradesByConnection: jest.fn().mockResolvedValue([]) },
      RedisPositions: { getPositionsByConnection: jest.fn().mockResolvedValue([]) },
    }))
    const applyMainConnectionSettingsChange = jest.fn().mockResolvedValue({
        completion: {
          completedAt: "2026-07-09T00:00:01.000Z",
          refreshQueued: false,
          refreshStatus: "applied_locally",
        },
      })
    jest.doMock("@/lib/connection-recoordinator", () => ({
      applyMainConnectionSettingsChange,
    }))
    jest.doMock("@/lib/trade-engine", () => ({ getTradeEngine: jest.fn(() => null) }))
    jest.doMock("@/lib/top-symbols", () => ({
      fetchTopSymbols: jest.fn(),
      normaliseSort: jest.fn((sort: string) => sort),
    }))

    const { PATCH } = await import("../../app/api/settings/connections/[id]/settings/route")
    const response = await PATCH(
      {
        json: async () => ({
          coordination_settings: {
            variants: { trailing: false, block: true, dca: false },
            axes: {
              prev: { enabled: true, maxWindow: 2 },
              last: { enabled: false, maxWindow: 3 },
              cont: { enabled: true, maxWindow: 4 },
              pause: { enabled: false, maxWindow: 5 },
            },
            blockVolumeRatio: 1.75,
            blockMaxStack: 6,
            blockPauseCountRatio: 2.5,
            blockActiveRealEnabled: true,
            blockActiveLiveEnabled: false,
          },
          useSystemCloseOnly: true,
          leveragePercentage: 42,
          useMaximalLeverage: false,
        }),
      } as any,
      { params: Promise.resolve({ id: "conn-progress-visible" }) },
    )

    expect(response.status).toBe(200)
    expect(hset).not.toHaveBeenCalled()
    expect(applyMainConnectionSettingsChange).toHaveBeenCalledTimes(1)
    const applyOptions = applyMainConnectionSettingsChange.mock.calls[0][2]
    expect(applyOptions.tradeEngineStatePatch).toEqual(expect.objectContaining({
        variantTrailingEnabled: "false",
        variantBlockEnabled: "true",
        variantDcaEnabled: "false",
        axisPrevEnabled: "true",
        axisLastEnabled: "false",
        axisContEnabled: "true",
        axisPauseEnabled: "false",
        axisPrevMaxWindow: "4",
        axisLastMaxWindow: "3",
        axisContMaxWindow: "4",
        axisPauseMaxWindow: "5",
        blockVolumeRatio: "1.75",
        blockMaxStack: "6",
        blockPauseCountRatio: "2.5",
        blockActiveRealEnabled: "true",
        blockActiveLiveEnabled: "false",
        useSystemCloseOnly: "true",
        use_system_close_only: "true",
        leveragePercentage: "42",
        useMaximalLeverage: "false",
    }))
  })

  test("live order failure paths update global and per-symbol failed counters", () => {
    const source = read("lib/trade-engine/stages/live-stage.ts")
    const failedMetric = 'await incrementMetric(connectionId, "live_orders_failed_count")'
    const failedBySymbol = 'await incrementOrdersBySymbol(connectionId, realPosition.symbol, realPosition.direction, "failed")'

    const failedMetricCount = source.split(failedMetric).length - 1
    const failedBySymbolCount = source.split(failedBySymbol).length - 1

    expect(failedMetricCount).toBeGreaterThanOrEqual(5)
    expect(failedBySymbolCount).toBe(failedMetricCount)

    for (const marker of [
      'Exchange connector not available or missing placeOrder',
      '`No authoritative exchange ticker available for ${realPosition.symbol}`',
      '`Exchange circuit breaker active for ${realPosition.symbol} — retrying in <5min`',
      'Entry order rejected for ${realPosition.symbol}',
      '`Live pipeline unhandled error for ${realPosition.symbol}`',
    ]) {
      const markerIndex = source.indexOf(marker)
      expect(markerIndex).toBeGreaterThanOrEqual(0)
      const block = source.slice(Math.max(0, markerIndex - 1200), markerIndex + 2500)
      expect(block).toContain('incrementMetric(connectionId, "live_orders_failed_count")')
      expect(block).toContain('incrementOrdersBySymbol(connectionId, realPosition.symbol, realPosition.direction, "failed")')
    }

    expect(source).toMatch(/async function incrementOrdersBySymbol[\s\S]*?catch \{[\s\S]*?best-effort/)
  })

  test("dashboard stats surface active advanced indications and logical Real evaluated counts", () => {
    const statsRoute = read("app/api/connections/progression/[id]/stats/route.ts")
    const quickstart = read("components/dashboard/quickstart-section.tsx")
    const activeCard = read("components/dashboard/active-connection-card.tsx")

    expect(statsRoute).toContain("let activeRealPassedSeen = false")
    expect(statsRoute).toContain("const _realLogicalPassed = Number(progHash.strategies_real_logical_passed")
    expect(statsRoute).toContain("real: activeRealInput > 0 && activeRealPassedSeen")
    expect(statsRoute).toContain("return activeRealInput || stratEvaluated.real || 0")
    expect(statsRoute).not.toContain("return stratEvaluated.real || 0\n            // NOTE: Real accounting has three meanings")
    expect(statsRoute).toContain("live:  activeStratByStage.live  || 0")
    expect(statsRoute).toContain("const mainFunnelInput = strategyRows.base.valid > 0 ? strategyRows.base.valid : activeMainInput")
    expect(statsRoute).toContain("const mainFunnelPassed = strategyRows.base.valid > 0 ? strategyRows.main.valid : activeMainPassedParents")
    expect(statsRoute).not.toContain("_pct(strategyRows.main.valid, strategyRows.base.total)")

    expect(quickstart).toContain("indActiveAdvanced: number")
    expect(quickstart).toContain("let indActAdv  = s.breakdown?.indications?.activeAdvanced || 0")
    expect(quickstart).toContain('{ label: "Adv",  value: stats.indActiveAdvanced }')

    expect(activeCard).toContain("indicationsActiveAdvanced: number")
    expect(activeCard).toContain("indicationsActiveAdvanced: nonNegativeMetric(activeInd.activeAdvanced ?? ind.activeAdvanced)")
    expect(activeCard).toContain("indicationsCalculatedActiveAdvanced: nonNegativeMetric(calculatedInd.activeAdvanced ?? activeInd.activeAdvanced ?? ind.activeAdvanced)")
    expect(activeCard).toContain("Current Indications · qualified / calculated")
    expect(activeCard).toContain('{ label: "Adv", value: prehistoricStats.indicationsActiveAdvanced, calculated: prehistoricStats.indicationsCalculatedActiveAdvanced }')
  })

  test("main connection cards use canonical ids for progression and stats polling", () => {
    const manager = read("components/dashboard/dashboard-active-connections-manager.tsx")
    const activeConnections = read("lib/active-connections.ts")

    expect(manager).toContain('const canonId = conn.id.replace(/^conn-/, "")')
    expect(manager).toContain("id: `active-${canonId}`")
    expect(manager).toContain("connectionId: canonId")
    expect(manager).toContain("details: normalizedDetails")
    expect(manager).not.toContain("connectionId: conn.id")
    expect(activeConnections).toContain('const canonId = conn.id.replace(/^conn-/, "")')
    expect(activeConnections).toContain("connectionId: canonId")
  })


  test("progression status endpoint timeboxes auxiliary log IO for responsive dashboard cards", () => {
    const route = read("app/api/connections/progression/[id]/route.ts")

    expect(route).toContain("const PROGRESSION_AUX_TIMEOUT_MS = 750")
    expect(route).toContain("async function withProgressionTimeout")
    expect(route).toContain('withProgressionTimeout("log flush", connectionId, forceFlushLogs(connectionId), undefined)')
    expect(route).toContain("getProgressionLogs(connectionId, { flush: false })")
    expect(route).not.toContain('const recentLogs = await withProgressionTimeout("recent logs", connectionId, getProgressionLogs(connectionId), [])')
    expect(route).toContain("returning live snapshot without blocking UI")
  })


  test("hot-path progression logs do not force immediate stdout and Redis flushes", () => {
    const source = read("lib/engine-progression-logs.ts")

    expect(source).toContain("options: { flush?: boolean } = {}")
    expect(source).toContain("if (options.flush !== false)")
    expect(source).toContain("function isImmediateFlushPhase")
    expect(source).toContain('phase.startsWith("quickstart")')
    expect(source).toContain("IMMEDIATE_FLUSH_PHASES.includes(phase)")
    expect(source).not.toContain("IMMEDIATE_FLUSH_PHASES.some(p => phase.includes(p))")
    expect(source).toContain("indications_sets")
    expect(source).toContain("live_trading")
    expect(source).toContain("starve dashboard progress endpoints")
    expect(source).not.toContain('"realtime", "live_trading", "error"')
  })

  test("canonical connection-settings mirror wins over stale legacy defaults for production progression", () => {
    const manager = read("lib/trade-engine/engine-manager.ts")
    const progression = read("lib/progression-state-manager.ts")
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")

    const overlay = read("lib/connection-settings-overlay.ts")
    const legacyIndex = overlay.indexOf("hgetall(`connection_settings:${")
    const canonicalIndex = overlay.indexOf("hgetall(`settings:connection_settings:${")
    expect(legacyIndex).toBeGreaterThan(-1)
    expect(canonicalIndex).toBeGreaterThan(-1)
    expect(legacyIndex).toBeLessThan(canonicalIndex)

    expect(manager).toContain("canonical settings mirror must win")
    expect(progression).toContain("getCanonicalConnectionSettingsOverlay(connectionId)")

    const mergeBlock = liveStage.slice(
      liveStage.indexOf("const merged = {"),
      liveStage.indexOf("const value = parseSystemCloseFlag"),
    )
    expect(mergeBlock.indexOf("...(connSettings || {})")).toBeLessThan(mergeBlock.indexOf("...(prefixedConnSettings || {})"))
    expect(mergeBlock).toContain("stale legacy defaults cannot re-enable")
  })


  test("production live order connector refuses simulated fallback when credentials are missing", () => {
    const source = read("lib/live-order-service.ts")

    expect(source).toContain('process.env.NODE_ENV === "production"')
    expect(source).toContain('process.env.ALLOW_PROD_SIMULATED !== "1"')
    expect(source).toContain("missing_live_exchange_credentials")
    expect(source.indexOf("missing_live_exchange_credentials")).toBeLessThan(source.indexOf("new SimulatedConnector"))
  })


  test("strategy coordination and live volume calculations use canonical settings overlays", () => {
    const volume = read("lib/volume-calculator.ts")
    const strategy = read("lib/strategy-coordinator.ts")
    const overlay = read("lib/connection-settings-overlay.ts")

    expect(overlay).toContain("connection_settings:${connectionId}")
    expect(overlay).toContain("settings:connection_settings:${connectionId}")
    expect(overlay.indexOf("legacySettings")).toBeLessThan(overlay.indexOf("canonicalSettings"))
    expect(overlay).toContain("overlayNonEmpty")

    expect(volume).toContain("getCanonicalConnectionSettingsOverlay(connectionId)")
    expect(volume).toContain("this AFTER all overlays")
    expect(volume.indexOf("const connSettings = await getCanonicalConnectionSettingsOverlay(connectionId)")).toBeLessThan(volume.indexOf("const positionCostRaw ="))
    expect(volume).toContain("producing default-sized live")

    expect(strategy).toContain("getCanonicalConnectionSettingsOverlay(this.connectionId)")
    expect(strategy).toContain("const s: Record<string, unknown> = overlayNonEmpty")
    expect(strategy).not.toContain("hgetall(`connection_settings:${this.connectionId}`)")
  })


  test("progression recoordination resolves operator symbols before stale engine-state symbols", () => {
    const source = read("lib/progression-state-manager.ts")
    const block = source.slice(
      source.indexOf("Canonical operator selections must beat trade-engine-state"),
      source.indexOf("const liveSymbolCount = currentSymbols.length"),
    )

    expect(source).toContain("const connectionSettings = await getCanonicalConnectionSettingsOverlay(connectionId)")
    expect(block.indexOf("connectionSettings.force_symbols")).toBeLessThan(block.indexOf("state.force_symbols"))
    expect(block.indexOf("connectionSettings.symbols")).toBeLessThan(block.indexOf("state.symbols"))
    expect(block).toContain("next 12-symbol")
  })


  test("QuickStart records symbol diagnostics without allowing a runtime cap", () => {
    const quickStart = read("app/api/trade-engine/quick-start/route.ts")
    const manager = read("lib/trade-engine/engine-manager.ts")

    expect(quickStart).toContain("dev_symbol_count_override: String(symbols.length)")
    expect(quickStart).toContain("tradeEngineStatePatch: {")
    expect(quickStart).toContain("config_set_symbols_total: String(symbols.length)")
    expect(quickStart).toContain("so an explicit multi-symbol smoke is never sliced back to the safe default one")
    expect(manager).not.toContain("(connSettings as any)?.dev_symbol_count_override")
  })

  test("supervised live smoke is admin-gated, SDK-first, and cleans up authoritatively", () => {
    const route = read("app/api/admin/live-order-smoke/route.ts")
    const smoke = read("lib/live-order-smoke.ts")
    const connector = read("lib/exchange-connectors/bingx-connector.ts")
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")
    const legacyTest = read("app/api/test/live-orders-test/route.ts")
    const testingOrder = read("app/api/testing/place-order/route.ts")

    expect(route).toContain("authorizeAdminBearer")
    expect(route).toContain("getLiveOrderSafetyFailure")
    expect(smoke).toContain("authoritativeAccountSnapshot")
    expect(smoke).toContain("accountFlatBefore")
    expect(smoke).toContain("accountFlatAfter")
    expect(smoke).toContain("cleanupComplete")
    expect(smoke).toContain("mainnet is read-only")
    expect(smoke).toContain('const expectedTransport = report.mainnet ? "bingx-api" : "signed-rest-fallback"')
    expect(smoke).toContain('report.transport.open?.transport === expectedTransport')
    expect(connector).toContain("SDK_ACK_WITHOUT_ORDER_ID")
    expect(connector).toContain("REST retry suppressed to prevent a duplicate order")
    expect(liveStage).toContain('client.get("live_order_smoke:active")')
    expect(legacyTest).toContain("authorizeAdminBearer")
    expect(testingOrder).toContain("authorizeAdminBearer")
    expect(read("scripts/direct-place-order.ts")).toContain("Direct connector order placement is disabled")
  })

  test("high-frequency indication and Real statistics use bounded hourly rollups", () => {
    const tracker = read("lib/statistics-tracker.ts")
    const dbShim = read("lib/db.ts")
    const migrations = read("lib/redis-migrations.ts")

    expect(tracker).toContain("statistics:hourly:${kind}:${connectionId}")
    expect(tracker).toContain("STATISTICS_ROLLUP_MAX_HOURS = 7 * 24")
    expect(tracker).not.toContain("INSERT INTO indications")
    expect(tracker).not.toContain("INSERT INTO strategies_real")
    expect(dbShim).toContain("HIGH_FREQUENCY_ROLLUP_ONLY_TABLES")
    expect(migrations).toContain('name: "079-repair-hourly-statistics-rollups"')
  })

  test("production status APIs distinguish connected inline state from durable shared Redis", () => {
    const persistence = read("app/api/persistence/status/route.ts")
    const database = read("app/api/settings/database-status/route.ts")
    const initStatus = read("app/api/system/init-status/route.ts")

    expect(persistence).toContain("isSharedPersistenceBackend(backend)")
    expect(persistence).toContain("getRealTradeInfrastructureBlockReason().length === 0")
    expect(persistence).toContain('status: shared ? "ok" : "degraded"')
    expect(persistence).toContain("cross_instance_durable: shared")
    expect(persistence).toContain("live_order_coordination: liveOrderCoordinationReady")
    expect(persistence).not.toContain('last_snapshot: "Within last 3 minutes"')

    expect(database).toContain("isSharedConfigured: shared")
    expect(database).toContain("isCrossInstanceDurable: shared")
    expect(database).toContain('"inline://process-local"')
    expect(database).not.toContain('"redis://connected"')

    expect(initStatus).toContain("site_instance_scope: sharedRedis ? \"shared-cross-instance\" : \"process-local\"")
    expect(initStatus).toContain("cross_instance_durable: sharedRedis")
    expect(initStatus).toContain("last_tick_fresh: continuityAgeMs !== null && continuityAgeMs <= 90_000")
    expect(initStatus).toContain("last_tick_fresh: liveRecoveryAgeMs !== null && liveRecoveryAgeMs <= 90_000")
  })

  test("realtime pipeline processes the full configured basket by default", () => {
    const engine = read("lib/trade-engine/engine-manager.ts")
    const env = read(".env.example")

    expect(engine).toContain("REALTIME_PIPELINE_SYMBOLS_PER_TICK")
    expect(engine).toContain(": configuredSymbols.length")
    expect(engine).toContain("let realtimeSymbolCursor = 0")
    expect(engine).toContain("configuredSymbols[(realtimeSymbolCursor + offset) % configuredSymbols.length]")
    expect(engine).toContain("realtimeSymbolCursor = (realtimeSymbolCursor + symbols.length) % configuredSymbols.length")
    expect(env).toContain("REALTIME_PIPELINE_SYMBOLS_PER_TICK=")
  })

  test("a successful historic generation cancels an older deferred retry", () => {
    const engine = read("lib/trade-engine/engine-manager.ts")

    expect(engine).toContain("A cancelled older generation can have armed a retry")
    expect(engine).toContain("clearTimeout(this.prehistoricRetryTimer)")
    expect(engine).toContain("unregisterEngineTimer(this.prehistoricRetryTimer)")
    expect(engine).toContain("if (!this.prehistoricTimer) this.schedulePrehistoricProgressionAfterRealtimeWarmup()")
  })

  test("a canonical-selection cancellation hands off instead of retrying a second historic matrix", () => {
    const engine = read("lib/trade-engine/engine-manager.ts")

    expect(engine).toContain('"PrehistoricProcessingCancelledError"')
    expect(engine).toContain('requestPrehistoricRecoordination("canonical symbol selection changed during historic bootstrap")')
    expect(engine).toContain("if (selectionSuperseded || error instanceof PrehistoricRunSupersededError || !run.shouldContinue())")
  })

  test("Kilo managed persistence is installable and serializes every dashboard control path", () => {
    const pkg = read("package.json")
    const redis = read("lib/redis-db.ts")
    const kiloClient = read("lib/kilo-database-client.ts")
    const quickStart = read("app/api/trade-engine/quick-start/route.ts")
    const routes = [
      "app/api/trade-engine/start/route.ts",
      "app/api/trade-engine/stop/route.ts",
      "app/api/trade-engine/pause/route.ts",
      "app/api/trade-engine/resume/route.ts",
      "app/api/settings/route.ts",
      "app/api/settings/system/route.ts",
      "app/api/settings/risk-and-engines/route.ts",
      "app/api/settings/connections/[id]/live-trade/route.ts",
      "app/api/settings/connections/[id]/toggle-dashboard/route.ts",
    ].map(read)

    expect(pkg).toContain('"@kilocode/app-builder-db": "file:vendor/app-builder-db-marker"')
    expect(pkg).not.toContain('github:Kilo-Org/app-builder-db')
    expect(pkg).toContain('"drizzle-orm": "0.45.2"')
    expect(pkg).toContain('"db:migrate": "node scripts/run-managed-db-migrate.mjs"')
    const migrateRunner = read("scripts/run-managed-db-migrate.mjs")
    expect(migrateRunner).toContain('process.env.KILO_DEPLOYMENT === "1"')
    expect(migrateRunner).toContain('console.info("[db:migrate] Skipped: this deployment does not use Kilo managed SQLite.")')
    expect(migrateRunner).toContain('spawn(process.execPath, ["--import", "tsx", "src/db/migrate.ts"]')
    expect(migrateRunner).toContain('"src/db/migrate.ts"')
    const migrate = read("src/db/migrate.ts")
    expect(migrate).toContain('DB_URL and DB_TOKEN are not configured')
    expect(migrate).toContain('process.env.KILO_DEPLOYMENT === "1"')
    expect(migrate).toContain('process.env.CTS_DEPLOYMENT_RUNTIME === "kilo-deploy"')
    expect(migrate).toContain('RUN_MANAGED_DB_MIGRATIONS === "1"')
    expect(migrate).toContain('await import("./index")')
    expect(migrate).toContain('drizzleMigrate(')
    expect(migrate).toContain('executeKiloDatabaseQuery(query, [], "run")')
    const installer = read("scripts/install.sh")
    expect(installer).toContain("CONFIG SET appendonly yes")
    expect(installer).toContain("CONFIG SET appendfsync everysec")
    expect(installer).toContain("CONFIG SET protected-mode yes")
    expect(installer).toContain("CONFIG SET maxmemory-policy noeviction")
    expect(read("src/db/migrations/0000_naive_captain_britain.sql"))
      .toContain("cts_runtime_snapshot_singleton")
    expect(kiloClient).toContain('body: JSON.stringify({ sql, params, method })')
    expect(kiloClient).toContain('Authorization: `Bearer ${token}`')
    expect(kiloClient).toContain("registerKiloSqliteBinding")
    expect(kiloClient).toContain("hasKiloDatabaseBackend")
    expect(read("custom-worker.ts")).toContain("registerWorkerDatabaseBinding")
    expect(read("vendor/app-builder-db-marker/README.md"))
      .toContain("No application code imports this marker")
    expect(redis).toContain("createKiloDatabaseQuery({ url, token })")
    expect(redis).toContain("Kilo snapshot CAS conflict")
    expect(redis).toContain("acquireSharedSnapshotLease")
    expect(quickStart).toContain('"api:trade-engine:quick-start"')
    expect(quickStart).toContain("sharedPersistenceLeaseHeld: true")
    for (const route of routes) expect(route).toContain("withSharedPersistenceLease")
  })

  test("the retired Kilo credential bootstrap path is permanently fail-closed", () => {
    const bootstrap = read("app/api/internal/kilo-db-bootstrap/route.ts")

    expect(bootstrap).toContain("return new NextResponse(null")
    expect(bootstrap).toContain("status: 404")
    expect(bootstrap).not.toContain("process.env.DB_URL")
    expect(bootstrap).not.toContain("process.env.DB_TOKEN")
    expect(bootstrap).not.toContain("BOOTSTRAP_PUBLIC_KEY")
  })

  test("live smoke and Cloudflare deployment fail closed around non-durable engine ownership", () => {
    const smoke = read("lib/live-order-smoke.ts")
    const wrangler = read("wrangler.jsonc")
    const continuity = read("app/api/cron/server-continuity/route.ts")
    const recovery = read("app/api/cron/sync-live-positions/route.ts")

    expect(smoke).toContain("getRealTradeInfrastructureBlockReason()")
    expect(smoke).toContain("coordinationGatePassed = infrastructureBlockReason.length === 0")
    expect(wrangler).toContain('"DISABLE_IN_PROCESS_CONTINUITY": "1"')
    expect(wrangler).toContain('"DISABLE_TRADE_ENGINE_IN_PROCESS": "1"')
    expect(continuity).toContain('last_tick_source: requestSource(request)')
    expect(recovery).toContain('DIAGNOSTIC_KEY = "system:coordination:live-recovery"')
    expect(recovery).toContain('last_tick_source: requestSource(request)')
    const dashboardPulse = read("app/api/runtime/dashboard-pulse/route.ts")
    expect(dashboardPulse).toContain('verifyAuth(request)')
    expect(dashboardPulse).toContain('/api/cron/server-continuity')
    expect(dashboardPulse).toContain('/api/cron/sync-live-positions')
    expect(dashboardPulse).toContain('"authenticated-dashboard-fallback"')
    expect(dashboardPulse).toContain('"same-origin-paper-dashboard-fallback"')
    expect(dashboardPulse).toContain('getRealTradeInfrastructureBlockReason().length > 0')
    expect(dashboardPulse).toContain("isForcedSimulation()")
    expect(dashboardPulse).toContain('process.env.ALLOW_LIVE_ORDER_PLACEMENT !== "1"')
    expect(dashboardPulse).toContain('request.headers.get("x-cts-dashboard-pulse") === "1"')
    expect(dashboardPulse).toContain('!fetchSite || fetchSite === "same-origin"')
    expect(dashboardPulse).toContain('requestHostname.endsWith(".kiloapps.io")')
    expect(read("components/engine-auto-initializer.tsx")).toContain('window.location.hostname.toLowerCase().endsWith(".kiloapps.io")')
    expect(read("components/engine-auto-initializer.tsx")).toContain('"x-cts-dashboard-pulse": "1"')
    expect(read("scripts/run-prod-preview-check.mjs")).toContain("await runPostDeployVerifier()")
    expect(read("scripts/verify-prod-preview.mjs")).toContain('REQUIRE_FRESH_CONTINUITY === "1"')
    expect(read("scripts/post-deploy-verify.sh")).toContain('/api/data/positions?connectionId=bingx-x01')
    expect(read("scripts/verify-prod-soak.mjs")).toContain('RUNTIME_MODE === "production" ? 1_000 : 3_000')
  })

  test("Structure and Logistics surfaces publish measured runtime data without placeholder health", () => {
    const metrics = read("app/api/structure/metrics/route.ts")
    const modules = read("app/api/structure/modules/route.ts")
    const workflow = read("lib/dashboard-workflow.ts")
    const logistics = read("lib/logistics-workflow.ts")
    const page = read("app/structure/page.tsx")
    const connectionState = read("components/dashboard/connection-state-tabs.tsx")

    expect(metrics).toContain("getSystemResourceMetrics()")
    expect(metrics).toContain("getObservedRedisRequestsPerSecond()")
    expect(metrics).toContain("client.dbSize()")
    expect(metrics).toContain("database_keys: databaseKeys")
    expect(metrics).toContain("uptime_hours: Math.round((process.uptime() / 3600)")
    expect(metrics).not.toContain("database_size: 45")
    expect(metrics).not.toContain("const cpuUsage = (memoryUsage.heapUsed")
    expect(metrics).not.toContain("AVG(profit_loss_percent)")

    expect(modules).toContain("getDashboardWorkflowSnapshot({ preferredConnectionId })")
    expect(modules).toContain("await getRedisClient().ping()")
    expect(modules).toContain("progression?.cycleSuccessRate")
    expect(modules).not.toContain("health: activeConnections > 0 ? 98")
    expect(modules).not.toContain('last_update: "2 min ago"')

    expect(workflow).toContain("const prehistoricDataSize = prehistoricSymbols")
    expect(workflow).not.toContain("client.scan(")
    expect(workflow).toContain("strategy_detail:${connId}:base")
    expect(workflow).toContain("sumCurrentStageSets")
    expect(workflow).not.toContain("settings:strategies:${connId}:*:sets")
    expect(logistics).toContain("Math.max(...latencySamples)")
    expect(logistics).not.toContain("avgLatency + 120")
    expect(page).toContain("Redis Operations/min")
    expect(page).toContain("Not instrumented")
    expect(page).not.toContain("<Badge variant=\"default\">Excellent</Badge>")
    expect(page).not.toContain("System Running Optimally")
    expect(connectionState).toContain("/api/structure/metrics?connectionId=")
    expect(connectionState).not.toContain("Math.random()")
    expect(connectionState).not.toContain("High latency detected")
  })

  test("Preset Common processing preserves the configured 30-minute lane end to end", () => {
    const optimizer = read("lib/preset-optimizer.ts")

    expect(optimizer).toContain(": [1, 5, 15, 30]")
    expect(optimizer).toContain("Math.min(60, Math.round(timeframeMinutesInput || 1))")
    expect(optimizer).toContain("Math.min(60, Math.round(config.params.timeframeMinutes || 1))")
    expect(optimizer).not.toContain("Math.min(15, Math.round(timeframeMinutesInput || 1))")
    expect(optimizer).not.toContain("Math.min(15, Math.round(config.params.timeframeMinutes || 1))")
  })

  test("legacy strategy monitoring reads canonical fresh Base/Main/Real/Live row snapshots", () => {
    const route = read("app/api/monitoring/strategies/[id]/route.ts")
    const overview = read("components/dashboard/intervals-strategies-overview.tsx")
    const coordinator = read("lib/strategy-coordinator.ts")

    expect(route).toContain('STRATEGY_STAGES: readonly StrategyStage[] = ["base", "main", "real", "live"]')
    expect(route).toContain("strategy_detail:${connectionId}:${stage}")
    expect(route).toContain("Stages cannot be enabled or disabled independently")
    expect(route).toContain('semantics: "current-fresh-row-snapshot"')
    expect(route).toContain("now - timestamp > 5 * 60_000")
    expect(route).not.toContain("`strategies:${connectionId}:${type}`")
    expect(overview).toContain("current sets")
    expect(overview).toContain("Pass Rate")
    expect(overview).toContain("one combined process")
    expect(overview).toContain("no row is independently switchable")
    expect(overview).not.toContain("Total Indications")
    expect(coordinator).toContain("const baseValidSetKeys = new Set<string>()")
    expect(coordinator).toContain("const mainBaseInputCount = baseValidCount")
    expect(coordinator).toContain("row_valid:   String(baseValidCount)")
    expect(coordinator).not.toContain("if (pf < this.PF_BASE_MIN) continue")
  })

  test("strategy stage stats keep authoritative zero snapshots separate from last-symbol fallbacks", () => {
    const route = read("app/api/connections/progression/[id]/stats/route.ts")

    expect(route).toContain("const activeStratStageSeen: Record<string, boolean>")
    expect(route).toContain("activeStratStageSeen[suffix] = true")
    expect(route).toContain("stratCounts[type] = activeStratStageSeen[type] ? fromActive")
  })

  test("Next workers share one Redis-coordinated runtime Base bootstrap", () => {
    const migrations = read("lib/redis-migrations.ts")
    const bootId = read("lib/runtime-boot-id.ts")
    const bootstrap = read("lib/redis-runtime-bootstrap.ts")
    const redisDb = read("lib/redis-db.ts")
    const devLauncher = read("scripts/start-development.mjs")
    const prodLauncher = read("scripts/start-production.mjs")
    const devVerifier = read("scripts/run-dev-preview-check.mjs")

    expect(bootId).toContain("process.env.CTS_RUNTIME_BOOT_ID")
    expect(migrations).toContain("ensureRuntimeBaseBootstrap")
    expect(bootstrap).toContain("system:database:base-bootstrap:")
    expect(migrations).toContain("NX: true")
    expect(migrations).toContain("RUNTIME_BOOTSTRAP_MARKER_TTL_SECONDS")
    expect(migrations).toContain("await releaseOwnedRedisLock(client, keys.baseLock, token)")
    expect(migrations).toContain("__v0_devBootGuardDone = false")
    expect(bootstrap).toContain("LATEST_REDIS_SCHEMA_VERSION = 105")
    expect(redisDb).toContain('hasSharedRuntimeMarker(getRedisClient(), "base")')
    expect(redisDb).toContain("ensureSharedVolatileStartupCleanup")
    expect(redisDb).toContain("markSharedRuntimeReady")
    for (const launcher of [devLauncher, prodLauncher, devVerifier]) {
      expect(launcher).toContain("CTS_RUNTIME_BOOT_ID")
      expect(launcher).toContain("CTS_RUNTIME_STARTED_AT")
    }
  })

  test("BingX live entry, protection, and venue setup keep their shared cooldown gate", () => {
    const bingx = read("lib/exchange-connectors/bingx-connector.ts")

    const methods = [
      { marker: "async placeOrder(", operation: "placeOrder" },
      { marker: "override async placeStopOrder(", operation: "placeStopOrder" },
      { marker: "async setLeverage(", operation: "setLeverage" },
      { marker: "async setMarginType(", operation: "setMarginType" },
    ]
    for (const { marker, operation } of methods) {
      const start = bingx.indexOf(marker)
      expect(start).toBeGreaterThanOrEqual(0)
      const end = bingx.indexOf("\n  async ", start + marker.length)
      const block = bingx.slice(start, end === -1 ? undefined : end)
      expect(block).toContain(`const release = await this.acquireBingxSlot("${operation}")`)
      expect(block).toMatch(/finally\s*\{\s*release\(\)\s*\}/)
    }
  })

  test("each row SL/TP stays fill-bounded while the separate security stop follows the slot", () => {
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")
    const reconcileStart = liveStage.indexOf("async function reconcileAggregateProtectionBook(")
    const reconcileEnd = liveStage.indexOf("async function finalizeQueuedAggregateProtection", reconcileStart)
    const reconcileBlock = liveStage.slice(reconcileStart, reconcileEnd)

    expect(liveStage).toContain(
      "const rawEffectiveQty = pos.executedQuantity > 0 ? pos.executedQuantity : (pos.quantity ?? 0)",
    )
    expect(reconcileBlock).toContain('"row_exact_guard"')
    expect(reconcileBlock).toContain("{ allowPendingAccumulation: true }")
    expect(reconcileBlock).not.toContain("allowQuantityOverrideAbovePosition: true")
    expect(reconcileBlock).toContain('"SecurityStop"')
    expect(reconcileBlock).toContain("plan.venueQuantity")
    expect(liveStage).toContain('reduceOnly: true,')
    expect(liveStage).toContain("securityStopQuantityDrifted(")
    expect(liveStage).toContain("leader.securityStopArmedQuantity = placement.armedQuantity")
    expect(liveStage).toContain(
      'await prepareProtectionSubmission(livePosition, "stopLoss", slPrice, livePosition.executedQuantity)',
    )
    expect(liveStage).toContain(
      'await prepareProtectionSubmission(livePosition, "takeProfit", tpPrice, livePosition.executedQuantity)',
    )
  })

  test("the authenticated VST preflight supplies authoritative control quantities and venue grids", () => {
    const soak = read("scripts/run-bingx-vst-live-soak.ts")
    const fixtureStart = soak.indexOf("const trackingFixtures = TRADE_PATHS.map")
    const fixtureEnd = soak.indexOf("const trackingStatistics", fixtureStart)
    const fixture = soak.slice(fixtureStart, fixtureEnd)

    expect(fixtureStart).toBeGreaterThanOrEqual(0)
    expect(fixture).toContain("priceTick: 0.1")
    expect(fixture).toContain("quantityStep: 0.001")
    expect(fixture).toContain("stopLossArmedQuantity: 0.01")
    expect(fixture).toContain("takeProfitArmedQuantity: 0.01")
    expect(fixture).toContain("securityStopArmedQuantity: 0.01")
  })

  test("row and security controls settle before any member changes physical quantity", () => {
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")

    expect(liveStage).toContain("async function requestAggregateProtectionSlotMutation(")
    expect(liveStage).toContain("aggregateProtectionMutationRequestedAt = Date.now()")
    expect(liveStage).toContain("aggregateProtectionMutationSettledAt = settledAt")
    expect(liveStage).toContain("aggregateProtectionMutationIsAbandoned(")
    expect(liveStage).toContain("Number(position.aggregateProtectionMutationRequestedAt || 0) > 0")
    expect(liveStage).toContain("if (!await requestAggregateProtectionSlotMutation(connector, position, reason)) return false")
    expect(liveStage).toContain("const aggregateReady = await requestAggregateProtectionSlotMutation(")
    expect(liveStage).toContain("const mutationRequested = members.some((member) =>")
    expect(liveStage).toContain("settleSlotControlsWithoutGuess(")
    expect(liveStage).toContain('"QuantityMutation"')
    expect(liveStage).toContain('"OwnershipMismatch"')
    expect(liveStage).toContain("row SL/TP remain independent")
    expect(liveStage).toContain("settleSecurityStopAcrossMembers(")
    expect(liveStage).toContain("await rearmProtectionAfterQuantityMutation(")
    expect(liveStage).toContain("const initialProtection = computeDesiredProtectionPrices(livePosition)")
    expect(liveStage).toContain('initialProtection.desiredSl,')
    expect(liveStage).toContain('initialProtection.desiredTp,')
    expect(liveStage).toContain('instrumentRulesSource: "bingx_contracts"')
  })

  test("Statistics exposes Main indications, real-order analytics, and a top time range", () => {
    const navigation = read("components/statistics/statistics-section-nav.tsx")
    const mainPage = read("app/statistics/indications/main/page.tsx")
    const dashboard = read("components/statistics/indication-analytics-dashboard.tsx")
    const indicationRoute = read("app/api/statistics/indications/route.ts")
    const progressionRoute = read("app/api/connections/progression/[id]/stats/route.ts")
    const statisticsPage = read("app/statistics/page.tsx")

    expect(navigation).toContain('/statistics/indications/main')
    expect(mainPage).toContain('mode="main"')
    expect(dashboard).toContain('"signal" | "main" | "common"')
    expect(indicationRoute).toContain("const MAIN_TYPES = [")
    expect(indicationRoute).toContain("closed.filter(isExecutedRealExchangePosition)")
    expect(indicationRoute).toContain("open.filter(isExecutedRealExchangePosition)")
    expect(progressionRoute).toContain("mainIndications,")
    expect(statisticsPage).toContain("Main Trade Engine · Indications")
    expect(statisticsPage).toContain("TOP_TIME_RANGES")
    expect(statisticsPage).toContain("Statistics time range")
    expect(statisticsPage).toContain("tradeHistoryInSelectedTimeRange")
  })

  test("calculated Block and DCA results stay visible when live execution is disabled", () => {
    const directStats = read("components/statistics/direct-trade-statistics.tsx")
    const pipeline = read("components/dashboard/strategy-pipeline.tsx")
    const quickStart = read("components/dashboard/quickstart-section.tsx")
    const connectionInfo = read("components/settings/connection-info-dialog.tsx")
    const activeCard = read("components/dashboard/active-connection-card.tsx")

    expect(directStats).not.toContain('{calculation.blockEnabled && <Card className="overflow-hidden p-4">')
    expect(pipeline).toContain('label="Block"')
    expect(pipeline).toContain('label="DCA"')
    expect(pipeline).toContain("Calculated continuously · live execution")
    expect(quickStart).toContain('label: "Block"')
    expect(quickStart).toContain('label: "DCA"')
    expect(quickStart).toContain('"calc only"')
    expect(connectionInfo).toContain("Calculated continuously · Block live")
    expect(activeCard).toContain('label: "Block"')
    expect(activeCard).toContain('label: "DCA"')
    expect(activeCard).toContain('" (calc)"')
  })

  test("Direct Trade Performance Stats exposes each indication type against internal results", () => {
    const performance = read("components/statistics/direct-trade-statistics.tsx")

    expect(performance).toContain("Indication types · live vs internal results")
    expect(performance).toContain("PF coordinate: 1.00 neutral · 1.10 = +1× PositionCost")
    expect(performance).toContain("row.liveEntryEnabled ? \"On\" : \"Calc only\"")
    expect(performance).toContain("row.internalAveragePnlPerSet")
    expect(performance).toContain("Only settled closed executions enter live W/L/BE")
  })

  test("all legacy and diagnostic entry routes carry the shared protection contract", () => {
    const stateMachine = read("lib/trade-engine/state-machine.ts")
    const orchestrator = read("lib/trade-execution-orchestrator.ts")
    const testingRoute = read("app/api/testing/place-order/route.ts")
    const directRoute = read("app/api/trade-engine/direct-trade/order/route.ts")

    expect(stateMachine).toContain("ExchangeConnectorFactory.getInstance().getOrCreateConnector")
    expect(stateMachine).toContain("requireProtection: true")
    expect(stateMachine).toContain("protectionStopLossPercent")
    expect(stateMachine).toContain("protectionTakeProfitPercent")
    expect(orchestrator).toContain("requireProtection: true")
    expect(orchestrator).toContain("signal.protectionStopLossPercent")
    expect(orchestrator).toContain("signal.protectionTakeProfitPercent")
    expect(testingRoute).toContain("requireProtection: true")
    expect(testingRoute).toContain("body.protectionStopLossPercent")
    expect(directRoute).toContain("requireProtection: kind === \"open\"")
    expect(directRoute).toContain("body?.protectionStopLossPercent")
    expect(directRoute).toContain("body?.protectionTakeProfitPercent")
  })

})

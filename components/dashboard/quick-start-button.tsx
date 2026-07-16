"use client"

import { buildConnectionMutationEventDetail, dispatchConnectionMutationEvents } from "@/lib/connection-events"
import React, { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Zap, Loader2, CheckCircle2, AlertCircle, RefreshCw } from "lucide-react"
import { toast } from "@/lib/simple-toast"
import { DetailedLoggingDialog } from "./detailed-logging-dialog"
import { QuickstartOverviewDialog } from "./quickstart-overview-dialog"
import { SystemDetailPanel } from "./system-detail-panel"
import { SeedSystemDialog } from "./seed-system-dialog"
import { QuickstartTestProcedureDialog } from "./quickstart-test-procedure-dialog"
import { QuickstartFullSystemTestDialog } from "./quickstart-full-system-test-dialog"
import { EngineProcessingLogDialog } from "./engine-processing-log-dialog"
import { useExchange } from "@/lib/exchange-context"
import { QUICKSTART_ENABLE_TIMEOUT_MS } from "@/lib/quickstart-timeouts"

interface QuickStartButtonProps {
  onQuickStartComplete?: () => void
}

interface QuickStartStep {
  id: string
  name: string
  status: "pending" | "loading" | "success" | "error"
  message?: string
}

interface FunctionalOverview {
  symbolsActive: number
  indicationsCalculated: number
  strategiesEvaluated: number
  baseSetsCreated: boolean
  mainSetsCreated: boolean
  realSetsCreated: boolean
  liveSetsCreated?: boolean
  positionsEntriesCreated: number
  counts?: {
    indicationCycles: number
    strategyCycles: number
    baseStrategies: number
    mainStrategies: number
    realStrategies: number
    liveStrategies: number
  }
}

interface OverallStats {
  symbols: {
    count: number
    processing: string[]
    prehistoricLoaded: number
    prehistoricDataSize: number
  }
  intervalsProcessed: number
  indicationsByType: {
    direction: number
    move: number
    active: number
    optimal: number
    auto: number
    trend: number
    total: number
  }
  pseudoPositions: {
    base: number
    baseByIndicationType: {
      direction: number
      move: number
      active: number
      optimal: number
      trend: number
    }
    main: number
    real: number
    total: number
  }
  livePositions: number
  cycleTimeMs: number
  totalDurationMs: number
}

const ENABLE_STEP_LABEL = "Enable selected Main Connection"
const DEFAULT_FETCH_TIMEOUT_MS = 12_000
const MIGRATION_STEP_TIMEOUT_MS = 60_000
const COORDINATOR_START_TIMEOUT_MS = 35_000

type QuickStartRequestBody = {
  action: "enable"
  connectionId?: string
  symbols?: string[]
  symbolOrder?: string
  symbolCount?: number
  is_live_trade?: boolean
  liveTrade?: boolean
}

const truthySetting = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (["1", "true", "yes", "on"].includes(normalized)) return true
    if (["0", "false", "no", "off", ""].includes(normalized)) return false
  }
  return undefined
}

const firstBoolean = (...values: unknown[]): boolean | undefined => {
  for (const value of values) {
    const parsed = truthySetting(value)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

const normalizePositiveInteger = (value: unknown): number | undefined => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  return Math.floor(numeric)
}

const buildQuickStartBodyFromSavedSettings = (
  selectedConnectionId: string | null,
  payload: { settings?: any; connection?: any } | null,
): QuickStartRequestBody => {
  if (!selectedConnectionId) {
    return { action: "enable", symbols: ["BTCUSDT"] }
  }

  const body: QuickStartRequestBody = { action: "enable", connectionId: selectedConnectionId }
  if (!payload?.settings) {
    return body
  }

  const { settings, connection } = payload

  if (Array.isArray(settings.symbols) && settings.symbols.length > 0) {
    body.symbols = settings.symbols.filter((symbol: unknown): symbol is string => (
      typeof symbol === "string" && symbol.trim().length > 0
    ))
  }

  if (!body.symbols?.length && typeof settings.symbol_order === "string" && settings.symbol_order.trim().length > 0) {
    body.symbolOrder = settings.symbol_order
  }

  const symbolCount = normalizePositiveInteger(settings.symbol_count)
  if (!body.symbols?.length && !body.symbolOrder && symbolCount !== undefined) {
    body.symbolCount = symbolCount
  }

  const liveTradeIntent = firstBoolean(
    connection?.live_trade_requested,
    settings.live_trade_requested,
    connection?.is_live_trade,
    settings.is_live_trade,
    connection?.live_trade_enabled,
    settings.live_trade_enabled,
  )
  if (liveTradeIntent !== undefined) {
    body.is_live_trade = liveTradeIntent
    body.liveTrade = liveTradeIntent
  }

  return body
}

export function QuickStartButton({ onQuickStartComplete }: QuickStartButtonProps) {
  const { selectedConnectionId, selectedConnection, selectedExchange, setSelectedConnectionId } = useExchange()
  const [isRunning, setIsRunning] = useState(false)
  const [functionalOverview, setFunctionalOverview] = useState<FunctionalOverview | null>(null)
  const [overallStats, setOverallStats] = useState<OverallStats | null>(null)
  const [steps, setSteps] = useState<QuickStartStep[]>([
    { id: "init",    name: "Initialize System",              status: "pending" },
    { id: "migrate", name: "Run Migrations",                 status: "pending" },
    { id: "test",    name: "Verify BingX Credentials",       status: "pending" },
    { id: "start",   name: "Start Global Trade Engine",      status: "pending" },
    { id: "enable",  name: ENABLE_STEP_LABEL,                status: "pending" },
    { id: "engine",  name: "Verify Engine + Progression",    status: "pending" },
  ])


  useEffect(() => {
    setSteps(prev => prev.map(s => (s.id === "enable" ? { ...s, name: ENABLE_STEP_LABEL } : s)))
  }, [selectedConnectionId])

  const updateStep = (stepId: string, status: QuickStartStep["status"], message?: string) => {
    setSteps(prev => prev.map(s => s.id === stepId ? { ...s, status, message } : s))
  }

  const updateStepName = (stepId: string, name: string) => {
    setSteps(prev => prev.map(s => s.id === stepId ? { ...s, name } : s))
  }

  const displayConnectionName = () => {
    return selectedConnection?.name || selectedConnection?.label || selectedConnectionId || selectedExchange || "BingX"
  }

  // Run a step — non-required steps never block the sequence
  const runStep = async (
    id: string,
    label: string,
    fn: () => Promise<string>,
    required = false
  ): Promise<string | null> => {
    updateStep(id, "loading")
    try {
      const msg = await fn()
      updateStep(id, "success", msg)
      return msg
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (required) {
        updateStep(id, "error", msg)
        throw new Error(`${label} failed: ${msg}`)
      }
      updateStep(id, "success", "Skipped")
      return null
    }
  }

  // Timed fetch that aborts the underlying request. A Promise.race-only timeout
  // leaves the mutating request alive, so the UI can show failure while the
  // server still enables an engine later — unsafe and especially confusing in
  // production.
  const timedFetch = async (
    url: string,
    opts?: RequestInit,
    ms = DEFAULT_FETCH_TIMEOUT_MS,
  ): Promise<Response> => {
    const controller = new AbortController()
    const upstreamSignal = opts?.signal
    const abortFromUpstream = () => controller.abort(upstreamSignal?.reason)
    if (upstreamSignal?.aborted) abortFromUpstream()
    else upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true })

    let timedOut = false
    const timeout = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, ms)

    try {
      return await fetch(url, { ...opts, cache: "no-store", signal: controller.signal })
    } catch (error) {
      if (timedOut) throw new Error(`Timeout ${ms / 1000}s: ${url}`)
      throw error
    } finally {
      window.clearTimeout(timeout)
      upstreamSignal?.removeEventListener("abort", abortFromUpstream)
    }
  }

  const handleQuickStart = async () => {
    setIsRunning(true)
    setFunctionalOverview(null)
    setSteps(prev => prev.map(s => ({ ...s, status: "pending", message: undefined })))

    let enabledConnectionId: string | null = null

    try {
      // STEP 1: Initialize (non-critical) - timeout: 15s
      await runStep("init", "STEP 1: Initialize System", async () => {
        const res = await timedFetch("/api/init", { method: "GET" }, 15000)
        return res.ok ? "System initialized" : "Already ready"
      })

      // STEP 2: Migrations (non-critical)
      await runStep("migrate", "STEP 2: Migrations", async () => {
        const res = await timedFetch("/api/install/database/migrate", { method: "POST" }, MIGRATION_STEP_TIMEOUT_MS)
        if (!res.ok) return "Up to date"
        const d = await res.json().catch(() => ({}))
        const n = d.migrations?.length ?? d.ranCount ?? 0
        return `${n} migration(s) applied`
      })

      // STEP 3: Verify BingX (non-critical - never blocks)
      let balanceInfo = ""
      await runStep("test", "STEP 3: Verify BingX Credentials", async () => {
        const res = await timedFetch("/api/settings/connections/test-bingx", { method: "GET" }, 20000)
        const d = await res.json().catch(() => ({}))
        if (d.success) {
          balanceInfo = d.connection?.testBalance ? ` | Balance: ${d.connection.testBalance}` : ""
          return `Ready - ${d.connection?.name ?? "BingX"}${balanceInfo}`
        }
        return `Credentials check: ${d.error ?? "skipped"}`
      })

      // STEP 4: Start global coordinator (REQUIRED)
      await runStep("start", "STEP 4: Start Global Coordinator", async () => {
        const res = await timedFetch("/api/trade-engine/start", { method: "POST" }, COORDINATOR_START_TIMEOUT_MS)
        const d = await res.json().catch(() => ({}))
        if (!res.ok || d.success === false) throw new Error(d.error ?? `HTTP ${res.status}`)
        const n = d.resumedConnections?.length ?? 0
        return `Coordinator running${n > 0 ? ` | Resumed ${n}` : ""}`
      }, true)

      // STEP 5: Enable selected main connection using saved symbol/live-trade settings (REQUIRED)
      await runStep("enable", "STEP 5: Enable selected Main Connection", async () => {
        const selectedName = displayConnectionName()
        let selectedSettingsPayload: { settings?: any; connection?: any } | null = null
        if (selectedConnectionId) {
          const settingsRes = await timedFetch(`/api/settings/connections/${selectedConnectionId}/settings`, { method: "GET" }, 12000)
          if (settingsRes.ok) {
            selectedSettingsPayload = await settingsRes.json().catch(() => null)
          }
        }

        const quickStartBody = buildQuickStartBodyFromSavedSettings(selectedConnectionId, selectedSettingsPayload)
        const symbolSource = Array.isArray(quickStartBody.symbols) && quickStartBody.symbols.length > 0
          ? `${quickStartBody.symbols.length} saved symbol${quickStartBody.symbols.length === 1 ? "" : "s"}`
          : quickStartBody.symbolOrder
            ? `symbol order ${quickStartBody.symbolOrder}`
            : quickStartBody.symbolCount
              ? `count ${quickStartBody.symbolCount}`
              : "saved connection defaults"

        updateStepName("enable", `Enable ${selectedName} (${symbolSource})`)
        const res = await timedFetch("/api/trade-engine/quick-start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(quickStartBody),
        }, QUICKSTART_ENABLE_TIMEOUT_MS)
        const d = await res.json().catch(() => ({}))
        if (!res.ok && !d.success) throw new Error(d.error ?? `HTTP ${res.status}`)
        if (!d.success) throw new Error(d.error ?? "Enable returned failure")
        enabledConnectionId = d.connection?.id ?? selectedConnectionId ?? null
        if (enabledConnectionId) {
          setSelectedConnectionId(enabledConnectionId)
        }
        if (d.overallStats) {
          setOverallStats(d.overallStats)
        }
        dispatchConnectionMutationEvents(buildConnectionMutationEventDetail(d, {
          connectionId: enabledConnectionId ?? undefined,
          engine: { action: "enable", status: d.engine?.status ?? d.engineStatus },
          source: "quick-start-button.enable",
        }))
        const syms = Array.isArray(d.connection?.symbols)
          ? d.connection.symbols.join(", ")
          : Array.isArray(quickStartBody.symbols) && quickStartBody.symbols.length > 0
            ? quickStartBody.symbols.join(", ")
            : quickStartBody.symbolOrder
              ? `auto (${quickStartBody.symbolOrder})`
              : quickStartBody.symbolCount
                ? `auto (${quickStartBody.symbolCount})`
                : "auto"
        return `${d.connection?.name ?? displayConnectionName()} enabled | ${syms}`
      }, true)

      // STEP 6: Verify the per-connection runtime. QuickStart already started
      // the Main progression in step 5; never mutate the Live Trade intent here.
      // The former fallback unconditionally posted is_live_trade=true, silently
      // turning a saved paper configuration into a real-order request.
      await runStep("engine", "STEP 6: Verify Engine + Progression", async () => {
        const connId = enabledConnectionId
        if (!connId) return "Skipped - no connection ID"
        const res = await timedFetch(`/api/connections/${connId}/engine-states`, { method: "GET" }, 12000)
        const d = await res.json().catch(() => ({}))
        if (!res.ok || d.success === false) throw new Error(d.error ?? `HTTP ${res.status}`)
        const runtime = d.engineRunning === true || d.runningHint === true ? "running" : "queued"
        const orders = d.live?.flag
          ? (d.live?.effective ? "Live Orders enabled" : "Live Orders requested / blocked")
          : "Paper processing"
        return `Engine ${runtime} | ${orders}`
      })

      toast.success(`Quick Start complete — ${displayConnectionName()} processing requested.`)

      // Fetch functional overview in background
      try {
        const res = await timedFetch("/api/trade-engine/functional-overview", {}, 6000)
        if (res.ok) {
          const d = await res.json()
          setFunctionalOverview(d)
        }
      } catch {
        // Non-critical: overview unavailable
      }

      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("engine-state-changed", { detail: { running: true } }))
      }
      onQuickStartComplete?.()
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error"
      toast.error(`Quick Start failed: ${msg}`)
    } finally {
      setIsRunning(false)
    }
  }

  const getStepIcon = (status: QuickStartStep["status"]) => {
    switch (status) {
      case "loading":
        return <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
      case "success":
        return <CheckCircle2 className="w-4 h-4 text-green-500" />
      case "error":
        return <AlertCircle className="w-4 h-4 text-red-500" />
      default:
        return <div className="w-4 h-4 rounded-full border-2 border-gray-300 dark:border-gray-600" />
    }
  }

  return (
    <Card className="border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <CardTitle className="text-lg flex items-center gap-2">
              <Zap className="w-5 h-5 text-blue-600" />
              Quick Start (BingX)
            </CardTitle>
            <CardDescription>
              Initialize, migrate, and start the selected connection with its saved settings.
            </CardDescription>
          </div>
          <Badge variant="outline" className="self-start text-xs">
            {isRunning ? "Running..." : "Ready"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Steps Progress */}
        <div className="space-y-2">
          {steps.map((step) => (
            <div key={step.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              {getStepIcon(step.status)}
              <span className="flex-1 font-medium">{step.name}</span>
              {step.message && <span className="w-full pl-7 text-xs text-gray-600 dark:text-gray-300 sm:w-auto sm:pl-0">{step.message}</span>}
            </div>
          ))}
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-2 pt-2">
          <Button
            onClick={handleQuickStart}
            disabled={isRunning}
            className="flex-1 gap-2"
            variant="default"
          >
            {isRunning ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Running Quick Start...
              </>
            ) : (
              <>
                <Zap className="w-4 h-4" />
                Start Quick Setup
              </>
            )}
          </Button>
           <Button
             onClick={() => {
               setSteps(steps.map(s => ({ ...s, status: "pending", message: undefined })))
               setIsRunning(false)
             }}
             disabled={isRunning}
             variant="outline"
             size="icon"
           >
             <RefreshCw className="w-4 h-4" />
           </Button>
           
           {/* System Detail Panel button */}
           <SystemDetailPanel />

           {/* Main / Log Overview button */}
           <QuickstartOverviewDialog />

            {/* Detailed Logs Button */}
            <DetailedLoggingDialog />
            
            {/* Seed 2.0 System Monitor Button */}
            <SeedSystemDialog />

             {/* System Test Procedure Dialog */}
             <QuickstartTestProcedureDialog />

             {/* Full System Monitor Test Dialog */}
             <QuickstartFullSystemTestDialog />

             {/* Engine Processing Live Log Dialog */}
             <EngineProcessingLogDialog />
         </div>

        {/* Info Box */}
        <div className="rounded border border-blue-200 bg-white/80 p-3 text-xs text-gray-600 dark:border-blue-900 dark:bg-blue-950/30 dark:text-gray-300">
          <p className="mb-2 font-semibold text-gray-700 dark:text-gray-200">This quick start will:</p>
          <ul className="list-disc list-inside space-y-1">
          <li>Initialize the complete system (preset types, connections)</li>
            <li>Run ALL database migrations (schema, indexes, TTL policies)</li>
            <li>Test BingX API connection (verify credentials & check balance)</li>
            <li>Start the trade engine</li>
            <li>Enable the selected Main Connection using its saved symbols, order, count, and Live Trade intent</li>
          </ul>
        </div>

        {/* Functional Overview - Displayed after successful completion */}
        {(functionalOverview || overallStats) && (
          <div className="rounded border border-green-200 bg-green-50 p-3 text-xs dark:border-green-900 dark:bg-green-950/25">
            <p className="mb-2 font-semibold text-green-700 dark:text-green-400">Functional Overview (System Ready):</p>
            <div className="grid grid-cols-1 gap-2 text-gray-700 dark:text-gray-200 sm:grid-cols-2">
              {functionalOverview && (
                <>
                  <div>
                    <span className="font-medium">Symbols Active:</span> {functionalOverview.symbolsActive}
                  </div>
                  <div>
                    <span className="font-medium">Indication Cycles:</span> {functionalOverview.counts?.indicationCycles || functionalOverview.indicationsCalculated}
                  </div>
                  <div>
                    <span className="font-medium">Strategy Cycles:</span> {functionalOverview.counts?.strategyCycles || 0}
                  </div>
                  <div>
                    <span className="font-medium">Strategies Evaluated:</span> {functionalOverview.strategiesEvaluated}
                  </div>
                  <div>
                    <span className="font-medium">Base Strategies:</span> {functionalOverview.counts?.baseStrategies || (functionalOverview.baseSetsCreated ? "Active" : "0")}
                  </div>
                  <div>
                    <span className="font-medium">Main Strategies:</span> {functionalOverview.counts?.mainStrategies || (functionalOverview.mainSetsCreated ? "Active" : "0")}
                  </div>
                  <div>
                    <span className="font-medium">Real Strategies:</span> {functionalOverview.counts?.realStrategies || (functionalOverview.realSetsCreated ? "Active" : "0")}
                  </div>
                  <div>
                    <span className="font-medium">Live Strategies:</span> {functionalOverview.counts?.liveStrategies || (functionalOverview.liveSetsCreated ? "Active" : "0")}
                  </div>
                  <div className="col-span-2">
                    <span className="font-medium">DB Position Entries:</span> {functionalOverview.positionsEntriesCreated}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Data Overview - Comprehensive prehistoric and processing stats */}
        {overallStats && (
          <div className="space-y-2 rounded border border-amber-200 bg-amber-50 p-3 text-xs dark:border-amber-900 dark:bg-amber-950/25">
            <p className="mb-2 font-semibold text-amber-700 dark:text-amber-400">Data Overview (Prehistoric & Processing):</p>
            
            {/* Prehistoric Data */}
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded bg-background/80 p-2 text-center">
                <div className="font-bold text-amber-700 dark:text-amber-400">{overallStats.symbols.prehistoricLoaded}</div>
                <div className="text-muted-foreground text-[10px]">Prehistoric Symbols</div>
              </div>
              <div className="rounded bg-background/80 p-2 text-center">
                <div className="font-bold text-amber-700 dark:text-amber-400">{overallStats.symbols.prehistoricDataSize}</div>
                <div className="text-muted-foreground text-[10px]">Data Keys</div>
              </div>
            </div>

            {/* Intervals */}
            <div className="rounded bg-background/80 p-2 text-center">
              <div className="font-bold text-blue-700 dark:text-blue-400">{overallStats.intervalsProcessed}</div>
              <div className="text-muted-foreground text-[10px]">Intervals Processed</div>
            </div>

            {/* Indications by Type */}
            <div className="space-y-1">
              <div className="text-muted-foreground text-[10px] font-medium">Indications by Type:</div>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-1">
                <div className="rounded bg-purple-50 p-1 text-center dark:bg-purple-950/30">
                  <div className="text-sm font-bold text-purple-700 dark:text-purple-400">{overallStats.indicationsByType.direction}</div>
                  <div className="text-muted-foreground text-[8px]">Dir</div>
                </div>
                <div className="rounded bg-purple-50 p-1 text-center dark:bg-purple-950/30">
                  <div className="text-sm font-bold text-purple-700 dark:text-purple-400">{overallStats.indicationsByType.move}</div>
                  <div className="text-muted-foreground text-[8px]">Move</div>
                </div>
                <div className="rounded bg-purple-50 p-1 text-center dark:bg-purple-950/30">
                  <div className="text-sm font-bold text-purple-700 dark:text-purple-400">{overallStats.indicationsByType.active}</div>
                  <div className="text-muted-foreground text-[8px]">Act</div>
                </div>
                <div className="rounded bg-purple-50 p-1 text-center dark:bg-purple-950/30">
                  <div className="text-sm font-bold text-purple-700 dark:text-purple-400">{overallStats.indicationsByType.optimal}</div>
                  <div className="text-muted-foreground text-[8px]">Opt</div>
                </div>
                <div className="rounded bg-purple-50 p-1 text-center dark:bg-purple-950/30">
                  <div className="text-sm font-bold text-purple-700 dark:text-purple-400">{overallStats.indicationsByType.auto}</div>
                  <div className="text-muted-foreground text-[8px]">Auto</div>
                </div>
                <div className="rounded bg-purple-50 p-1 text-center dark:bg-purple-950/30">
                  <div className="text-sm font-bold text-purple-700 dark:text-purple-400">{overallStats.indicationsByType.trend}</div>
                  <div className="text-muted-foreground text-[8px]">Trend</div>
                </div>
              </div>
              <div className="text-center text-[10px] text-purple-600 dark:text-purple-400">
                Total: <span className="font-bold">{overallStats.indicationsByType.total}</span>
              </div>
            </div>

            {/* Pseudo Positions */}
            <div className="space-y-1">
              <div className="text-muted-foreground text-[10px] font-medium">Pseudo Positions:</div>
              <div className="grid grid-cols-4 gap-1">
                <div className="rounded bg-green-50 p-1 text-center dark:bg-green-950/30">
                  <div className="text-sm font-bold text-green-700 dark:text-green-400">{overallStats.pseudoPositions.base}</div>
                  <div className="text-muted-foreground text-[8px]">Base</div>
                </div>
                <div className="rounded bg-green-50 p-1 text-center dark:bg-green-950/30">
                  <div className="text-sm font-bold text-green-700 dark:text-green-400">{overallStats.pseudoPositions.main}</div>
                  <div className="text-muted-foreground text-[8px]">Main</div>
                </div>
                <div className="rounded bg-green-50 p-1 text-center dark:bg-green-950/30">
                  <div className="text-sm font-bold text-green-700 dark:text-green-400">{overallStats.pseudoPositions.real}</div>
                  <div className="text-muted-foreground text-[8px]">Real</div>
                </div>
                <div className="rounded bg-green-50 p-1 text-center dark:bg-green-950/30">
                  <div className="text-sm font-bold text-green-700 dark:text-green-400">{overallStats.livePositions}</div>
                  <div className="text-muted-foreground text-[8px]">Live</div>
                </div>
              </div>
            </div>

            {/* Timing */}
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded bg-orange-50 p-2 text-center dark:bg-orange-950/30">
                <div className="font-bold text-orange-700 dark:text-orange-400">{overallStats.cycleTimeMs}</div>
                <div className="text-muted-foreground text-[10px]">Cycle Time (ms)</div>
              </div>
              <div className="rounded bg-orange-50 p-2 text-center dark:bg-orange-950/30">
                <div className="font-bold text-orange-700 dark:text-orange-400">{overallStats.totalDurationMs}</div>
                <div className="text-muted-foreground text-[10px]">Total Duration (ms)</div>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

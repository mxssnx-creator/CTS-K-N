"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { AlertCircle, CheckCircle2, Clock, Play, RefreshCw, Terminal, Zap, Activity } from "lucide-react"
import { useExchange } from "@/lib/exchange-context"

type EngineStageAckStage = "startup" | "market_data" | "prehistoric_data" | "base_sets" | "main_sets" | "real_sets" | "live_dispatch" | "live_sync" | "recoordination_complete"

function waitForStageAck(stages: EngineStageAckStage | EngineStageAckStage[], timeoutMs: number, connectionId = "*"): Promise<any> {
  const wanted = new Set(Array.isArray(stages) ? stages : [stages])
  return new Promise((resolve, reject) => {
    const source = new EventSource(`/api/ws?connectionId=${encodeURIComponent(connectionId)}`)
    const timer = setTimeout(() => {
      source.close()
      reject(new Error(`timeout waiting for stage acknowledgement: ${Array.from(wanted).join(", ")}`))
    }, timeoutMs)
    source.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        const payloads = message?.type === "history" && Array.isArray(message.data)
          ? message.data.filter((item: any) => item?.type === "engine-stage-ack").map((item: any) => item.data)
          : [message?.type === "engine-stage-ack" ? message.data : null]
        const payload = payloads.find((candidate: any) => candidate && wanted.has(candidate.stage))
        if (!payload) return
        clearTimeout(timer)
        source.close()
        payload.status === "ack" ? resolve(payload) : reject(new Error(payload.message || `${payload.stage} ${payload.status}`))
      } catch { /* heartbeat/history */ }
    }
    source.onerror = () => {
      clearTimeout(timer)
      source.close()
      reject(new Error("stage acknowledgement stream error"))
    }
  })
}

interface TestStep {
  id: string
  name: string
  description: string
  endpoint: string
  method?: "GET" | "POST"
  status: "pending" | "running" | "success" | "warning" | "error"
  duration?: number
  result?: any
  error?: string
}

interface TestReport {
  startedAt: Date
  completedAt?: Date
  totalSteps: number
  passedSteps: number
  failedSteps: number
  overallStatus: "pending" | "running" | "success" | "partial" | "failed"
}

interface LiveMonitorSnapshot {
  cycles: number
  indications: number
  strategies: number
  connections: number
  symbols: number
}

const TEST_STEPS: TestStep[] = [
  {
    id: "health",
    name: "System Health Check",
    description: "Verify base server health and endpoints are responding",
    endpoint: "/api/health",
    status: "pending",
  },
  {
    id: "init",
    name: "System Initialization",
    description: "Initialize base system components and configuration",
    endpoint: "/api/init",
    status: "pending",
  },
  {
    id: "migrations",
    name: "Database Migrations",
    description: "Validate all database schema migrations are applied",
    endpoint: "/api/install/database/migrate",
    method: "POST",
    status: "pending",
  },
  {
    id: "coordinator",
    name: "Start Coordinator",
    description: "Start global trade engine coordinator service",
    endpoint: "/api/trade-engine/start",
    method: "POST",
    status: "pending",
  },
  {
    id: "quickstart",
    name: "Run Quickstart Procedure",
    description: "Execute full quickstart workflow with BTCUSDT symbol",
    endpoint: "/api/trade-engine/quick-start",
    method: "POST",
    status: "pending",
  },
  {
    id: "verify_engine",
    name: "Engine Verification",
    description: "Verify engine state, connections, and processing status",
    endpoint: "/api/engine/verify",
    status: "pending",
  },
  {
    id: "monitoring",
    name: "System Monitoring Check",
    description: "Validate CPU, memory, database and module metrics",
    endpoint: "/api/system/monitoring",
    status: "pending",
  },
  {
    id: "prehistoric_progress",
    name: "Engine Cycle Progress Check",
    description: "Read live indication and strategy cycle counts from progression hashes",
    endpoint: "/api/monitoring/stats",
    status: "pending",
  },
  {
    id: "indications_active",
    name: "Indications Generation Check",
    description: "Verify realtime indications are being calculated",
    endpoint: "/api/main/system-stats-v3",
    status: "pending",
  },
  {
    id: "strategies_active",
    name: "Strategies Evaluation Check",
    description: "Verify strategies are running and evaluating",
    endpoint: "/api/strategies/overview",
    status: "pending",
  },
  {
    id: "final_health",
    name: "Final System Health",
    description: "Final health verification with all components running",
    endpoint: "/api/health/readiness",
    status: "pending",
  },
]

function extractCycleSummary(stepId: string, data: any): string | null {
  if (!data) return null

  if (stepId === "prehistoric_progress") {
    const cycles = data.statistics?.totalCycles || 0
    const indications = data.statistics?.totalIndications || 0
    const strategies = data.statistics?.totalStrategies || 0
    return `Cycles: ${cycles} | Indications: ${indications} | Strategies: ${strategies}`
  }
  if (stepId === "indications_active") {
    const ind = data.cycleStats?.indicationCycles || 0
    const strat = data.cycleStats?.strategyCycles || 0
    return `Indication cycles: ${ind} | Strategy cycles: ${strat}`
  }
  if (stepId === "strategies_active") {
    const total = data.total || (Array.isArray(data) ? data.length : 0)
    return `Strategy sets: ${total}`
  }
  if (stepId === "verify_engine" || stepId === "coordinator") {
    const running = data.running || data.isRunning || data.success
    return running ? "Engine confirmed running" : "Engine not running"
  }
  return null
}

export function QuickstartTestProcedureDialog() {
  const { selectedConnection } = useExchange()
  const [open, setOpen] = useState(false)
  const [steps, setSteps] = useState<TestStep[]>(TEST_STEPS)
  const [report, setReport] = useState<TestReport | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [currentStepIndex, setCurrentStepIndex] = useState(-1)
  const [liveMonitor, setLiveMonitor] = useState<LiveMonitorSnapshot | null>(null)
  const liveMonitorRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  // Poll live stats while test is running so we can see cycles incrementing
  useEffect(() => {
    if (!isRunning) {
      if (liveMonitorRef.current) clearInterval(liveMonitorRef.current)
      return
    }

    const poll = async () => {
      try {
        // Use per-connection engine-stats when a connection is selected for accurate counts
        const connId = selectedConnection?.id
        const statsUrl = connId
          ? `/api/trading/engine-stats?connection_id=${connId}`
          : "/api/monitoring/stats"
        const res = await fetch(statsUrl, { cache: "no-store" })
        if (!res.ok) return
        const data = await res.json()

        if (connId) {
          setLiveMonitor({
            cycles: data.indicationCycleCount || data.strategyCycleCount || data.cyclesCompleted || 0,
            indications: data.totalIndicationsCount || data.indications?.totalRecords || 0,
            // Canonical strategies total = Real-stage count (the cascade
            // filter's final output). Base/Main are intermediate stages of
            // the SAME strategies and must NOT be summed with Real.
            strategies: data.totalStrategyCount || data.realStrategyCount || 0,
            connections: 1,
            symbols: data.metadata?.symbolCount || data.symbolsProcessed || 0,
          })
        } else {
          setLiveMonitor({
            cycles: data.statistics?.totalCycles || 0,
            indications: data.statistics?.totalIndications || 0,
            strategies: data.statistics?.totalStrategies || 0,
            connections: data.activeConnections || 0,
            symbols: data.statistics?.symbolsProcessed || 0,
          })
        }
      } catch { /* non-critical */ }
    }

    poll()
    liveMonitorRef.current = setInterval(poll, 3000)
    return () => {
      if (liveMonitorRef.current) clearInterval(liveMonitorRef.current)
    }
  }, [isRunning, selectedConnection?.id])

  const resetTest = useCallback(() => {
    setSteps(
      TEST_STEPS.map((s) => ({
        ...s,
        status: "pending",
        result: undefined,
        error: undefined,
        duration: undefined,
      })),
    )
    setReport(null)
    setCurrentStepIndex(-1)
    setIsRunning(false)
    setLiveMonitor(null)
  }, [])

  const runStep = useCallback(async (step: TestStep, index: number): Promise<TestStep> => {
    const startTime = Date.now()

    setSteps((prev) => {
      const next = [...prev]
      next[index] = { ...step, status: "running" }
      return next
    })

    try {
      const method = step.method || "GET"
      const isPost = method === "POST"
      const res = await fetch(step.endpoint, {
        method,
        headers: isPost ? { "Content-Type": "application/json", "Cache-Control": "no-cache" } : { "Cache-Control": "no-cache" },
        body: isPost ? JSON.stringify({}) : undefined,
        signal: AbortSignal.timeout(25000),
      })

      const data = await res.json().catch(() => ({}))
      const duration = Date.now() - startTime

      if (res.ok || data.success) {
        return { ...step, status: "success", result: data, duration }
      } else {
        return {
          ...step,
          status: "warning",
          result: data,
          duration,
          error: data.error || `HTTP ${res.status}`,
        }
      }
    } catch (err) {
      const duration = Date.now() - startTime
      return {
        ...step,
        status: "error",
        duration,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }, [])

  const runFullTest = useCallback(async () => {
    setIsRunning(true)
    setLiveMonitor(null)
    setReport({
      startedAt: new Date(),
      totalSteps: TEST_STEPS.length,
      passedSteps: 0,
      failedSteps: 0,
      overallStatus: "running",
    })

    for (let i = 0; i < TEST_STEPS.length; i++) {
      setCurrentStepIndex(i)
      let result = await runStep(TEST_STEPS[i], i)

      if (["quickstart", "coordinator", "prehistoric_progress", "indications_active", "strategies_active"].includes(TEST_STEPS[i].id)) {
        const stages: EngineStageAckStage[] = TEST_STEPS[i].id === "quickstart" ? ["startup", "recoordination_complete"] :
          TEST_STEPS[i].id === "coordinator" ? ["recoordination_complete"] :
          TEST_STEPS[i].id === "prehistoric_progress" ? ["prehistoric_data"] :
          TEST_STEPS[i].id === "indications_active" ? ["live_dispatch"] : ["base_sets", "main_sets", "real_sets"]
        try {
          const ack = await waitForStageAck(stages, 30000, selectedConnection?.id || "*")
          result = { ...result, result: { ...(result.result || {}), stageAck: ack } }
        } catch (err) {
          result = {
            ...result,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          }
        }
      }

      setSteps((prev) => {
        const next = [...prev]
        next[i] = result
        return next
      })

      setReport((prev) =>
        prev
          ? {
              ...prev,
              passedSteps: prev.passedSteps + (result.status === "success" ? 1 : 0),
              failedSteps: prev.failedSteps + (result.status === "error" ? 1 : 0),
            }
          : prev,
      )
    }

    setReport((prev) =>
      prev
        ? {
            ...prev,
            completedAt: new Date(),
            overallStatus:
              prev.failedSteps > 0
                ? prev.passedSteps > 0
                  ? "partial"
                  : "failed"
                : "success",
          }
        : prev,
    )

    setIsRunning(false)
    setCurrentStepIndex(-1)
  }, [runStep])

  const getStatusIcon = (status: TestStep["status"]) => {
    switch (status) {
      case "running":
        return <Clock className="w-4 h-4 animate-spin text-blue-500" />
      case "success":
        return <CheckCircle2 className="w-4 h-4 text-green-500" />
      case "warning":
        return <AlertCircle className="w-4 h-4 text-yellow-500" />
      case "error":
        return <AlertCircle className="w-4 h-4 text-red-500" />
      default:
        return <div className="w-4 h-4 rounded-full border-2 border-muted-foreground/30" />
    }
  }

  const getOverallProgress = () => {
    if (!report) return 0
    const completed = steps.filter((s) => s.status !== "pending").length
    return (completed / TEST_STEPS.length) * 100
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary" className="gap-1 text-xs">
          <Terminal className="w-3.5 h-3.5" />
          Test Procedure
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-3xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5" />
            Quickstart System Test Procedure
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Progress bar */}
          {isRunning && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Running test procedure...</span>
                <span>{Math.round(getOverallProgress())}%</span>
              </div>
              <Progress value={getOverallProgress()} className="h-2" />
            </div>
          )}

          {/* Live engine monitor — shown while running */}
          {isRunning && (
            <Card className="p-3 bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800">
              <div className="flex items-center gap-2 mb-2">
                <Activity className="w-4 h-4 text-blue-500 animate-pulse" />
                <span className="text-xs font-semibold text-blue-700 dark:text-blue-300">Live Engine Monitor</span>
              </div>
              <div className="grid grid-cols-5 gap-2 text-center">
                {[
                  { label: "Cycles", value: liveMonitor?.cycles ?? "—" },
                  { label: "Indications", value: liveMonitor?.indications ?? "—" },
                  { label: "Strategies", value: liveMonitor?.strategies ?? "—" },
                  { label: "Connections", value: liveMonitor?.connections ?? "—" },
                  { label: "Symbols", value: liveMonitor?.symbols ?? "—" },
                ].map((m) => (
                  <div key={m.label} className="bg-white dark:bg-blue-950/40 rounded p-2">
                    <div className="text-[10px] text-muted-foreground">{m.label}</div>
                    <div className="text-sm font-bold tabular-nums">{m.value}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Summary badge */}
          {report && (
            <div className="flex items-center gap-2 flex-wrap">
              <Badge
                variant={
                  report.overallStatus === "success"
                    ? "default"
                    : report.overallStatus === "partial"
                      ? "secondary"
                      : report.overallStatus === "failed"
                        ? "destructive"
                        : "outline"
                }
              >
                {report.overallStatus.toUpperCase()}
              </Badge>
              <Badge variant="outline">
                Passed: {report.passedSteps} / Failed: {report.failedSteps} / Total: {TEST_STEPS.length}
              </Badge>
              {report.completedAt && (
                <Badge variant="outline">
                  {((report.completedAt.getTime() - report.startedAt.getTime()) / 1000).toFixed(1)}s
                </Badge>
              )}
            </div>
          )}

          {/* Test steps */}
          <ScrollArea className="h-[420px] pr-4">
            <div className="space-y-2">
              {steps.map((step, index) => {
                const summary = step.result ? extractCycleSummary(step.id, step.result) : null
                return (
                  <Card
                    key={step.id}
                    className={`p-3 transition-colors ${
                      currentStepIndex === index
                        ? "border-blue-400 bg-blue-50 dark:bg-blue-950/20"
                        : step.status === "success"
                          ? "border-green-200 bg-green-50/50 dark:bg-green-950/10"
                          : step.status === "error"
                            ? "border-red-200 bg-red-50/50 dark:bg-red-950/10"
                            : step.status === "warning"
                              ? "border-yellow-200 bg-yellow-50/50 dark:bg-yellow-950/10"
                              : ""
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="pt-0.5">{getStatusIcon(step.status)}</div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-sm">{step.name}</span>
                          {step.duration !== undefined && (
                            <span className="text-xs text-muted-foreground flex-shrink-0">{step.duration}ms</span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">{step.description}</p>

                        {/* Cycle summary line for relevant steps */}
                        {summary && (
                          <p className="text-xs font-mono text-blue-700 dark:text-blue-300 mt-1 bg-blue-50 dark:bg-blue-950/30 px-2 py-1 rounded">
                            {summary}
                          </p>
                        )}

                        {step.error && (
                          <p className="text-xs text-red-600 mt-1">{step.error}</p>
                        )}

                        {step.result && (step.status === "warning" || step.status === "error") && (
                          <pre className="mt-2 p-2 bg-muted rounded text-xs overflow-x-auto max-h-20">
                            {JSON.stringify(step.result, null, 2)}
                          </pre>
                        )}
                      </div>
                    </div>
                  </Card>
                )
              })}
            </div>
          </ScrollArea>

          <Separator />

          {/* Actions */}
          <div className="flex justify-between items-center">
            <p className="text-xs text-muted-foreground">
              Validates full system health including live engine cycle counts
            </p>

            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={resetTest} disabled={isRunning}>
                <RefreshCw className="w-3.5 h-3.5 mr-1" />
                Reset
              </Button>

              <Button size="sm" onClick={runFullTest} disabled={isRunning}>
                <Play className="w-3.5 h-3.5 mr-1" />
                {isRunning ? "Running..." : "Run Full Test"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

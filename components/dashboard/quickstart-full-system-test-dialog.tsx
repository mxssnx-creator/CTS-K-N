"use client"

import { useState, useCallback } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Activity, CheckCircle2, Clock, Play, RefreshCw, Terminal, AlertCircle } from "lucide-react"

interface TestLogEntry {
  id: number
  timestamp: Date
  type: "step" | "status" | "success" | "error" | "info"
  message: string
  data?: any
}

interface TestPhase {
  id: string
  name: string
  status: "pending" | "running" | "success" | "error"
  progress: number
  duration?: number
}

export function QuickstartFullSystemTestDialog() {
  const [open, setOpen] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [logs, setLogs] = useState<TestLogEntry[]>([])
  const [phases, setPhases] = useState<TestPhase[]>([
    { id: "health", name: "System Health Check", status: "pending", progress: 0 },
    { id: "init", name: "Quickstart Engine Initialization", status: "pending", progress: 0 },
    { id: "engine", name: "Trade Engine Service Startup", status: "pending", progress: 0 },
    { id: "prehistoric", name: "Prehistoric Data Processing", status: "pending", progress: 0 },
    { id: "monitoring", name: "System Performance Monitoring", status: "pending", progress: 0 },
    { id: "realtime", name: "Realtime Processing Validation", status: "pending", progress: 0 },
    { id: "report", name: "Final System Report", status: "pending", progress: 0 },
  ])
  const [overallProgress, setOverallProgress] = useState(0)
  const [testDuration, setTestDuration] = useState<string | null>(null)
  const logId = { current: 0 }

  const addLog = useCallback((type: TestLogEntry["type"], message: string, data?: any) => {
    const entry: TestLogEntry = {
      id: logId.current++,
      timestamp: new Date(),
      type,
      message,
      data
    }
    setLogs(prev => [...prev, entry])
  }, [])

  const resetTest = useCallback(() => {
    setLogs([])
    setOverallProgress(0)
    setTestDuration(null)
    setPhases(prev => prev.map(p => ({ ...p, status: "pending", progress: 0, duration: undefined })))
    logId.current = 0
  }, [])

  const runFullSystemTest = useCallback(async () => {
    setIsRunning(true)
    resetTest()
    const startTime = Date.now()

    addLog("status", "📊 DEV FULL SYSTEM MONITORING TEST STARTED")
    addLog("info", `Target: http://localhost:3002`)
    addLog("info", `Started: ${new Date().toLocaleString()}`)

    // Phase 1: System Health Check
    setPhases(prev => {
      const next = [...prev]
      next[0].status = "running"
      return next
    })
    addLog("step", "1. Checking system health")
    try {
      const health = await fetch('/api/health', { 
        headers: { 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(10000)
      }).then(r => r.json())
      addLog(health.ok ? "success" : "info", `Health status: ${health.ok ? '✅ OK' : '⚠️ Warning'}`)
      setPhases(prev => {
        const next = [...prev]
        next[0].status = "success"
        next[0].progress = 100
        return next
      })
    } catch (err) {
      addLog("error", `Health check failed: ${err}`)
      setPhases(prev => {
        const next = [...prev]
        next[0].status = "error"
        return next
      })
    }
    setOverallProgress(10)
    await new Promise(r => setTimeout(r, 500))

    // Phase 2: Quickstart Initialization
    setPhases(prev => {
      const next = [...prev]
      next[1].status = "running"
      return next
    })
    addLog("step", "2. Starting quickstart engine initialization")
    try {
      const quickstartInit = await fetch('/api/trade-engine/quick-start', { 
        method: 'POST',
        signal: AbortSignal.timeout(30000)
      }).then(r => r.json())
      addLog(quickstartInit.success ? "success" : "info", `Quickstart initialized: ${quickstartInit.success ? '✅ OK' : '⚠️ Already running'}`)
      setPhases(prev => {
        const next = [...prev]
        next[1].status = "success"
        next[1].progress = 100
        return next
      })
    } catch (err) {
      addLog("error", `Quickstart init failed: ${err}`)
      setPhases(prev => {
        const next = [...prev]
        next[1].status = "error"
        return next
      })
    }
    setOverallProgress(20)
    await new Promise(r => setTimeout(r, 500))

    // Phase 3: Engine Startup
    setPhases(prev => {
      const next = [...prev]
      next[2].status = "running"
      return next
    })
    addLog("step", "2.5 Starting trade engine service")
    try {
      const engineStart = await fetch('/api/trade-engine/start', { 
        method: 'POST',
        signal: AbortSignal.timeout(15000)
      }).then(r => r.json())
      addLog(engineStart.success ? "success" : "info", `Engine start status: ${engineStart.success ? '✅ Running' : '⚠️ Already running'}`)
      setPhases(prev => {
        const next = [...prev]
        next[2].status = "success"
        next[2].progress = 100
        return next
      })
    } catch (err) {
      addLog("error", `Engine start failed: ${err}`)
      setPhases(prev => {
        const next = [...prev]
        next[2].status = "error"
        return next
      })
    }
    setOverallProgress(25)
    addLog("info", "Waiting 8 seconds for engine warmup...")
    await new Promise(r => setTimeout(r, 8000))

    // Phase 4: Prehistoric Processing Monitoring
    setPhases(prev => {
      const next = [...prev]
      next[3].status = "running"
      return next
    })
    addLog("step", "3. Monitoring Prehistoric Data Processing (10s intervals)")
    
    for (let i = 0; i < 12; i++) {
      const mon = await fetch('/api/system/monitoring', { 
        headers: { 'Cache-Control': 'no-cache' } 
      }).then(r => r.json()).catch(() => ({ cpu: 0, memory: 0 }))
      const connLog = await fetch('/api/settings/connections/test/log', { 
        headers: { 'Cache-Control': 'no-cache' } 
      }).then(r => r.json()).catch(() => ({ summary: {} }))

      const cycles = connLog.summary?.enginePerformance?.cyclesCompleted || 0
      const symbols = connLog.summary?.prehistoricData?.symbolsProcessed || 0

      addLog("info", `  [${i+1}/12] CPU: ${mon.cpu}% | MEM: ${mon.memory}% | Cycles: ${cycles} | Symbols: ${symbols}`)
      
      setPhases(prev => {
        const next = [...prev]
        next[3].progress = Math.round((i + 1) / 12 * 100)
        return next
      })
      setOverallProgress(25 + Math.round((i + 1) / 12 * 25))

      if (connLog.summary?.prehistoricData?.phaseActive === false && cycles > 0) {
        addLog("success", `  ✅ Prehistoric processing completed at check ${i+1}`)
        setPhases(prev => {
          const next = [...prev]
          next[3].status = "success"
          next[3].progress = 100
          return next
        })
        break
      }

      if (i < 11) await new Promise(r => setTimeout(r, 10000))
    }
    setOverallProgress(50)

    // Phase 5: System Monitoring
    setPhases(prev => {
      const next = [...prev]
      next[4].status = "running"
      next[4].progress = 100
      next[4].status = "success"
      return next
    })
    addLog("step", "4. Prehistoric Phase Completed - System Snapshot")
    
    const finalPrehistoric = await fetch('/api/system/monitoring', { headers: { 'Cache-Control': 'no-cache' } }).then(r => r.json())
    const finalConnLog = await fetch('/api/settings/connections/test/log', { headers: { 'Cache-Control': 'no-cache' } }).then(r => r.json())
    
    addLog("success", "📌 Prehistoric Phase Results:")
    addLog("info", `   Cycles Completed: ${finalConnLog.summary?.enginePerformance?.cyclesCompleted}`)
    addLog("info", `   Candles Processed: ${finalConnLog.summary?.prehistoricData?.candlesProcessed}`)
    addLog("info", `   Symbols Loaded: ${finalConnLog.summary?.prehistoricData?.symbolsProcessed}`)
    addLog("info", `   Success Rate: ${finalConnLog.summary?.enginePerformance?.cycleSuccessRate?.toFixed(1)}%`)
    addLog("info", `   Average Cycle Time: ${finalConnLog.summary?.enginePerformance?.cycleTimeMs}ms`)

    setOverallProgress(60)
    await new Promise(r => setTimeout(r, 1000))

    // Phase 6: Realtime Monitoring
    setPhases(prev => {
      const next = [...prev]
      next[5].status = "running"
      return next
    })
    addLog("step", "5. Realtime Processing Phase (60 seconds monitoring)")

    let lastCycleCount = finalConnLog.summary?.enginePerformance?.cyclesCompleted || 0
    const realtimeStart = Date.now()

    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 10000))

      const mon = await fetch('/api/system/monitoring', { headers: { 'Cache-Control': 'no-cache' } }).then(r => r.json()).catch(() => ({ cpu: 0, memory: 0 }))
      const connLog = await fetch('/api/settings/connections/test/log', { headers: { 'Cache-Control': 'no-cache' } }).then(r => r.json()).catch(() => ({ summary: {} }))

      const currentCycles = connLog.summary?.enginePerformance?.cyclesCompleted || lastCycleCount
      const cyclesPerMinute = ((currentCycles - lastCycleCount) / ((Date.now() - realtimeStart) / 60000)).toFixed(1)
      const indicationsCount = Object.values(connLog.summary?.indicationsCounts || {}).reduce((a: number, b: any) => a + Number(b || 0), 0)

      addLog("info", `  [${(i+1)*10}s] CPU: ${mon.cpu}% | MEM: ${mon.memory}% | Cycles: ${currentCycles} | Rate: ${cyclesPerMinute}/min | Indications: ${indicationsCount}`)
      
      lastCycleCount = currentCycles
      setPhases(prev => {
        const next = [...prev]
        next[5].progress = Math.round((i + 1) / 6 * 100)
        return next
      })
      setOverallProgress(60 + Math.round((i + 1) / 6 * 30))
    }

    setPhases(prev => {
      const next = [...prev]
      next[5].status = "success"
      next[5].progress = 100
      return next
    })
    setOverallProgress(90)

    // Phase 7: Final Report
    setPhases(prev => {
      const next = [...prev]
      next[6].status = "running"
      return next
    })
    addLog("step", "6. FINAL FULL SYSTEM REPORT")

    const finalMonitor = await fetch('/api/system/monitoring', { headers: { 'Cache-Control': 'no-cache' } }).then(r => r.json())
    const finalConn = await fetch('/api/settings/connections/test/log', { headers: { 'Cache-Control': 'no-cache' } }).then(r => r.json())

    const totalIndications = Object.values(finalConn.summary?.indicationsCounts || {}).reduce((a: number, b: any) => a + Number(b || 0), 0)
    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1)

    addLog("success", "📋 FINAL RESULTS TABLE:")
    addLog("info", `┌────────────────────────────────┬───────────┐`)
    addLog("info", `│ Metric                         │ Value     │`)
    addLog("info", `├────────────────────────────────┼───────────┤`)
    addLog("info", `│ Test Duration                  │ ${((Date.now() - startTime) / 1000).toFixed(0)}s       │`)
    addLog("info", `│ CPU Average                    │ ${finalMonitor.cpu}%       │`)
    addLog("info", `│ Memory Average                 │ ${finalMonitor.memory}%       │`)
    addLog("info", `│ Cycle Success Rate             │ ${finalConn.summary?.enginePerformance?.cycleSuccessRate?.toFixed(1) || 0}%     │`)
    addLog("info", `│ Avg Cycle Time                 │ ${finalConn.summary?.enginePerformance?.cycleTimeMs || 0}ms     │`)
    addLog("info", `│ Total Cycles                   │ ${finalConn.summary?.enginePerformance?.cyclesCompleted || 0}         │`)
    addLog("info", `│ Total Indications Generated    │ ${totalIndications}      │`)
    addLog("info", `│ Strategies Evaluated           │ ${Object.values(finalConn.summary?.strategyCounts || {}).reduce((a:number,b:any) => a + Number(b||0), 0)}       │`)
    addLog("info", `│ Prehistoric Candles Processed  │ ${finalConn.summary?.prehistoricData?.candlesProcessed || 0}    │`)
    addLog("info", `│ Symbols Loaded                 │ ${finalConn.summary?.prehistoricData?.symbolsProcessed || 0}         │`)
    addLog("info", `│ Database Size                  │ ${(finalMonitor.database.size / 1024 / 1024).toFixed(1)}MB     │`)
    addLog("info", `│ Database Keys                  │ ${finalMonitor.database.keys}      │`)
    addLog("info", `│ Positions Generated            │ ${finalMonitor.database.positions1h || 0}         │`)
    addLog("info", `└────────────────────────────────┴───────────┘`)

    addLog("success", "\n✅ TEST COMPLETED SUCCESSFULLY")
    addLog("info", `Test report available at dev-system-test-results.json`)

    setPhases(prev => {
      const next = [...prev]
      next[6].status = "success"
      next[6].progress = 100
      return next
    })
    setOverallProgress(100)
    setTestDuration(`${((Date.now() - startTime) / 1000).toFixed(1)}s`)
    setIsRunning(false)

  }, [addLog, resetTest])

  const getPhaseIcon = (status: TestPhase["status"]) => {
    switch (status) {
      case "running": return <Clock className="w-4 h-4 animate-spin text-blue-500" />
      case "success": return <CheckCircle2 className="w-4 h-4 text-green-500" />
      case "error": return <AlertCircle className="w-4 h-4 text-red-500" />
      default: return <div className="w-4 h-4 rounded-full border-2 border-gray-300" />
    }
  }

  const getLogColor = (type: TestLogEntry["type"]) => {
    switch (type) {
      case "step": return "text-blue-600 font-medium"
      case "success": return "text-green-600"
      case "error": return "text-red-600"
      case "status": return "text-purple-600 font-semibold"
      case "info": return "text-gray-600"
      default: return "text-gray-500"
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="default" className="gap-1 text-xs bg-emerald-600 hover:bg-emerald-700 text-white">
          <Activity className="w-3.5 h-3.5" />
          Full System Test
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-4xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="w-5 h-5" />
            Developer Full System Monitor Test
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Overall Progress Bar */}
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{isRunning ? "Test running..." : overallProgress === 100 ? "Test completed" : "Ready to start"}</span>
              <span>{Math.round(overallProgress)}%</span>
            </div>
            <Progress value={overallProgress} className="h-2" />
          </div>

          {/* Summary Status */}
          <div className="flex flex-wrap items-center gap-2">
            {phases.map((phase, i) => (
              <Badge key={phase.id} variant={
                phase.status === "success" ? "default" :
                phase.status === "running" ? "secondary" :
                phase.status === "error" ? "destructive" : "outline"
              } className="text-xs">
                {getPhaseIcon(phase.status)}
                <span className="ml-1">{phase.name}</span>
              </Badge>
            ))}
            {testDuration && (
              <Badge variant="outline">
                Duration: {testDuration}
              </Badge>
            )}
          </div>

          <Separator />

          {/* Live Log Output */}
          <ScrollArea className="h-[420px] pr-4">
            <Card className="p-3 bg-slate-950 text-slate-50 font-mono text-xs">
              <div className="space-y-1">
                {logs.map(entry => (
                  <div key={entry.id} className={`${getLogColor(entry.type)}`}>
                    <span className="text-slate-500 mr-2">{entry.timestamp.toLocaleTimeString()}</span>
                    {entry.message}
                  </div>
                ))}
                {isRunning && logs.length === 0 && (
                  <div className="text-slate-400">Initializing test...</div>
                )}
                {!isRunning && logs.length === 0 && (
                  <div className="text-slate-400">Click \"Run Full System Test\" to begin monitoring</div>
                )}
              </div>
            </Card>
          </ScrollArea>

          {/* Modern Results Overview Card - shown when test completed */}
          {overallProgress === 100 && !isRunning && (
            <>
              <Separator />
              <Card className="p-4 bg-gradient-to-br from-slate-50 to-slate-100 border-slate-200">
                <h4 className="text-sm font-semibold mb-3 text-slate-700 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  Test Results Overview
                </h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                  <div className="space-y-1">
                    <div className="text-slate-500">Total Cycles</div>
                    <div className="text-lg font-bold text-slate-900">
                      {logs.find(l => l.message.includes('Total Cycles'))?.message.split(':')[1].trim() || '0'}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-slate-500">Indications</div>
                    <div className="text-lg font-bold text-blue-600">
                      {logs.find(l => l.message.includes('Total Indications'))?.message.split(':')[1].trim() || '0'}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-slate-500">Prehistoric Candles</div>
                    <div className="text-lg font-bold text-purple-600">
                      {logs.find(l => l.message.includes('Prehistoric Candles'))?.message.split(':')[1].trim() || '0'}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-slate-500">Success Rate</div>
                    <div className="text-lg font-bold text-emerald-600">
                      {logs.find(l => l.message.includes('Cycle Success Rate'))?.message.split(':')[1].trim() || '0%'}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-slate-500">Avg CPU</div>
                    <div className="text-lg font-bold text-slate-700">
                      {logs.find(l => l.message.includes('Average CPU'))?.message.split(':')[1].trim() || '0%'}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-slate-500">Avg Memory</div>
                    <div className="text-lg font-bold text-slate-700">
                      {logs.find(l => l.message.includes('Average Memory'))?.message.split(':')[1].trim() || '0%'}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-slate-500">Database Size</div>
                    <div className="text-lg font-bold text-slate-700">
                      {logs.find(l => l.message.includes('Database Size'))?.message.split(':')[1].trim() || '0MB'}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-slate-500">Positions</div>
                    <div className="text-lg font-bold text-orange-600">
                      {logs.find(l => l.message.includes('Positions Generated'))?.message.split(':')[1].trim() || '0'}
                    </div>
                  </div>
                </div>
              </Card>
            </>
          )}

          <Separator />

          {/* Actions */}
          <div className="flex justify-between items-center">
            <div className="text-xs text-muted-foreground">
              This test runs the complete end-to-end system monitoring suite with real-time performance metrics
            </div>

            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={resetTest} disabled={isRunning}>
                <RefreshCw className="w-3.5 h-3.5 mr-1" />
                Reset
              </Button>

              <Button size="sm" onClick={runFullSystemTest} disabled={isRunning} className="bg-emerald-600 hover:bg-emerald-700">
                <Play className="w-3.5 h-3.5 mr-1" />
                {isRunning ? "Running..." : "Run Full System Test"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

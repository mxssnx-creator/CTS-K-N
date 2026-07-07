"use client"
export const dynamic = "force-dynamic"


import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Play, CheckCircle2, XCircle, Loader2, TrendingUp, DollarSign } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/page-header"

interface EngineTestStep {
  step: string
  status: "pending" | "running" | "success" | "failed"
  duration: number
  details: string
  data?: any
}

export default function EngineTestingPage() {
  const [selectedConnection, setSelectedConnection] = useState("")
  const [useTestnet, setUseTestnet] = useState(true)
  const [minVolume, setMinVolume] = useState("10")
  const [symbol, setSymbol] = useState("BTCUSDT")
  const [connections, setConnections] = useState<any[]>([])
  const [testing, setTesting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [testSteps, setTestSteps] = useState<EngineTestStep[]>([])
  const [summary, setSummary] = useState<any>(null)

  useEffect(() => {
    loadConnections()
  }, [])

  const loadConnections = async () => {
    try {
      const response = await fetch("/api/settings/connections?enabled=true")
      if (response.ok) {
        const data = await response.json()
        setConnections(data.connections || [])
        if (data.connections.length > 0) {
          setSelectedConnection(data.connections[0].id)
        }
      }
    } catch (error) {
      console.error("[v0] Failed to load connections:", error)
    }
  }

  const runEngineTest = async () => {
    setTesting(true)
    setProgress(0)
    setTestSteps([])
    const startTime = Date.now()

    const steps = [
      { name: "Initialize Engine", key: "init" },
      { name: "Load Market Data", key: "market_data" },
      { name: "Calculate Indicators", key: "indicators" },
      { name: "Generate Strategy Signal", key: "strategy" },
      { name: "Place Test Order", key: "order" },
      { name: "Monitor Position", key: "position" },
      { name: "Update Take Profit/Stop Loss", key: "update_tp_sl" },
      { name: "Close Position", key: "close" },
      { name: "Verify Rate Limits", key: "rate_limits" },
      { name: "Batch Processing Test", key: "batch" },
    ]

    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]
        setProgress((i / steps.length) * 100)

        setTestSteps((prev) => [
          ...prev,
          { step: step.name, status: "running", duration: 0, details: "Processing..." },
        ])

        const stepStart = Date.now()

        const response = await fetch(`/api/testing/engine/${step.key}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connectionId: selectedConnection,
            useTestnet,
            minVolume: parseFloat(minVolume),
            symbol,
          }),
        })

        const data = await response.json()
        const duration = Date.now() - stepStart

        setTestSteps((prev) =>
          prev.map((s) =>
            s.step === step.name
              ? {
                  step: step.name,
                  status: response.ok ? "success" : "failed",
                  duration,
                  details: data.message || "Completed",
                  data: data.data,
                }
              : s
          )
        )

        if (!response.ok) break

        await new Promise((resolve) => setTimeout(resolve, 500))
      }

      const totalDuration = Date.now() - startTime
      const successCount = testSteps.filter((s) => s.status === "success").length
      const failedCount = testSteps.filter((s) => s.status === "failed").length

      setSummary({
        totalSteps: steps.length,
        passed: successCount,
        failed: failedCount,
        duration: totalDuration,
        status: failedCount === 0 ? "success" : "partial",
      })

      setProgress(100)
      toast.success(`Engine test completed: ${successCount}/${steps.length} steps passed`)
    } catch (error) {
      toast.error("Engine test failed: " + (error instanceof Error ? error.message : "Unknown error"))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="flex flex-col h-screen">
      <PageHeader 
        title="Engine Testing" 
        description="Test trading engine with live position placement and management"
      />
      <div className="flex-1 overflow-auto">
        <div className="p-6 space-y-6">

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Test Configuration</CardTitle>
            <CardDescription>Configure engine test parameters</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Connection</Label>
              <Select value={selectedConnection} onValueChange={setSelectedConnection}>
                <SelectTrigger>
                  <SelectValue placeholder="Select connection" />
                </SelectTrigger>
                <SelectContent>
                  {connections.map((conn) => (
                    <SelectItem key={conn.id} value={conn.id}>
                      {conn.name} ({conn.exchange})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Trading Pair</Label>
              <Select value={symbol} onValueChange={setSymbol}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="BTCUSDT">BTC/USDT</SelectItem>
                  <SelectItem value="ETHUSDT">ETH/USDT</SelectItem>
                  <SelectItem value="BNBUSDT">BNB/USDT</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Minimum Volume (USDT)</Label>
              <Input
                type="number"
                value={minVolume}
                onChange={(e) => setMinVolume(e.target.value)}
                placeholder="10"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Use Testnet</Label>
                <Switch checked={useTestnet} onCheckedChange={setUseTestnet} />
              </div>
              <p className="text-xs text-muted-foreground">
                {useTestnet ? "Safe testing mode" : "Real funds at risk"}
              </p>
            </div>

            <Button onClick={runEngineTest} disabled={testing} className="w-full" size="lg">
              {testing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Testing...
                </>
              ) : (
                <>
                  <Play className="mr-2 h-4 w-4" />
                  Start Engine Test
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Test Progression</CardTitle>
            <CardDescription>Real-time engine test status and results</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {testing && (
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Progress</span>
                  <span>{Math.round(progress)}%</span>
                </div>
                <Progress value={progress} />
              </div>
            )}

            <div className="space-y-3">
              {testSteps.map((step, index) => (
                <div
                  key={index}
                  className="flex items-start justify-between p-4 border rounded-lg"
                >
                  <div className="flex items-start gap-3 flex-1">
                    <div className="mt-0.5">
                      {step.status === "running" && (
                        <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
                      )}
                      {step.status === "success" && (
                        <CheckCircle2 className="h-5 w-5 text-green-500" />
                      )}
                      {step.status === "failed" && <XCircle className="h-5 w-5 text-red-500" />}
                      {step.status === "pending" && (
                        <div className="h-5 w-5 rounded-full border-2 border-muted" />
                      )}
                    </div>
                    <div className="flex-1">
                      <p className="font-medium">{step.step}</p>
                      <p className="text-sm text-muted-foreground">{step.details}</p>
                      {step.data && (
                        <div className="mt-2 p-2 bg-muted rounded text-xs font-mono">
                          {JSON.stringify(step.data, null, 2)}
                        </div>
                      )}
                    </div>
                  </div>
                  {step.duration > 0 && (
                    <Badge variant={step.status === "success" ? "default" : "destructive"}>
                      {step.duration}ms
                    </Badge>
                  )}
                </div>
              ))}

              {testSteps.length === 0 && !testing && (
                <div className="text-center py-12 text-muted-foreground">
                  Configure test parameters and start engine test
                </div>
              )}
            </div>

            {summary && (
              <div className="mt-6 p-6 bg-muted rounded-lg space-y-4">
                <h3 className="font-semibold text-lg">Test Summary</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="text-center">
                    <p className="text-sm text-muted-foreground">Total Steps</p>
                    <p className="text-3xl font-bold">{summary.totalSteps}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-sm text-muted-foreground">Passed</p>
                    <p className="text-3xl font-bold text-green-500">{summary.passed}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-sm text-muted-foreground">Failed</p>
                    <p className="text-3xl font-bold text-red-500">{summary.failed}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-sm text-muted-foreground">Duration</p>
                    <p className="text-3xl font-bold">{(summary.duration / 1000).toFixed(2)}s</p>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
        </div>
      </div>
    </div>
  )
}

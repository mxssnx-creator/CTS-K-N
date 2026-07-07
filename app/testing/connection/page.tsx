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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Play, CheckCircle2, XCircle, Loader2, Activity } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/page-header"

interface TestResult {
  test: string
  status: "success" | "failed" | "running"
  duration: number
  message: string
  details?: any
}

export default function ConnectionTestingPage() {
  const [selectedExchange, setSelectedExchange] = useState("bybit")
  const [selectedConnection, setSelectedConnection] = useState("")
  const [apiType, setApiType] = useState("unified")
  const [useTestnet, setUseTestnet] = useState(true)
  const [apiKey, setApiKey] = useState("")
  const [apiSecret, setApiSecret] = useState("")
  const [connections, setConnections] = useState<any[]>([])
  const [testing, setTesting] = useState(false)
  const [testResults, setTestResults] = useState<TestResult[]>([])
  const [testSummary, setTestSummary] = useState<any>(null)

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

  const runConnectionTest = async () => {
    setTesting(true)
    setTestResults([])
    const startTime = Date.now()

    const tests = [
      { name: "Connection Initialization", key: "init" },
      { name: "Account Balance", key: "balance" },
      { name: "Market Data Fetch", key: "market_data" },
      { name: "Order Book", key: "orderbook" },
      { name: "Rate Limits", key: "rate_limits" },
    ]

    try {
      for (const test of tests) {
        setTestResults((prev) => [
          ...prev,
          { test: test.name, status: "running", duration: 0, message: "Running..." },
        ])

        const testStart = Date.now()
        
        // Simulate API call
        const response = await fetch(`/api/testing/connection/${test.key}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            exchange: selectedExchange,
            apiType,
            useTestnet,
            apiKey,
            apiSecret,
            connectionId: selectedConnection,
          }),
        })

        const data = await response.json()
        const duration = Date.now() - testStart

        setTestResults((prev) =>
          prev.map((r) =>
            r.test === test.name
              ? {
                  test: test.name,
                  status: response.ok ? "success" : "failed",
                  duration,
                  message: data.message || (response.ok ? "Success" : "Failed"),
                  details: data.details,
                }
              : r
          )
        )

        if (!response.ok) break
      }

      const totalDuration = Date.now() - startTime
      const successCount = testResults.filter((r) => r.status === "success").length
      const failedCount = testResults.filter((r) => r.status === "failed").length

      setTestSummary({
        totalTests: tests.length,
        passed: successCount,
        failed: failedCount,
        duration: totalDuration,
        status: failedCount === 0 ? "success" : "partial",
      })

      toast.success(`Connection test completed: ${successCount}/${tests.length} passed`)
    } catch (error) {
      toast.error("Test failed: " + (error instanceof Error ? error.message : "Unknown error"))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="flex flex-col h-screen">
      <PageHeader 
        title="Connection Testing" 
        description="Test exchange API connectivity and functionality"
      />
      <div className="flex-1 overflow-auto">
        <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold mb-2">Connection Testing</h1>
        <p className="text-muted-foreground">
          Test exchange API connections with various operations
        </p>
      </div>

      <Tabs defaultValue="config" className="space-y-6">
        <TabsList>
          <TabsTrigger value="config">Configuration</TabsTrigger>
          <TabsTrigger value="results">Test Results</TabsTrigger>
        </TabsList>

        <TabsContent value="config" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Test Configuration</CardTitle>
              <CardDescription>Configure connection settings for testing</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Exchange</Label>
                  <Select value={selectedExchange} onValueChange={setSelectedExchange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bybit">Bybit</SelectItem>
                      <SelectItem value="binance">Binance</SelectItem>
                      <SelectItem value="okx">OKX</SelectItem>
                      <SelectItem value="bingx">BingX</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Existing Connection</Label>
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
                  <Label>API Type</Label>
                  <Select value={apiType} onValueChange={setApiType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unified">Unified</SelectItem>
                      <SelectItem value="spot">Spot</SelectItem>
                      <SelectItem value="futures">Futures</SelectItem>
                      <SelectItem value="margin">Margin</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Use Testnet</Label>
                    <Switch checked={useTestnet} onCheckedChange={setUseTestnet} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {useTestnet ? "Testing on testnet (safe)" : "Testing on mainnet (real funds)"}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <Label>API Key (optional - uses connection if selected)</Label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Leave empty to use selected connection"
                />
              </div>

              <div className="space-y-2">
                <Label>API Secret (optional)</Label>
                <Input
                  type="password"
                  value={apiSecret}
                  onChange={(e) => setApiSecret(e.target.value)}
                  placeholder="Leave empty to use selected connection"
                />
              </div>

              <Button onClick={runConnectionTest} disabled={testing} className="w-full" size="lg">
                {testing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Testing...
                  </>
                ) : (
                  <>
                    <Play className="mr-2 h-4 w-4" />
                    Run Connection Test
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="results" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Test Results</CardTitle>
              <CardDescription>Detailed results of connection tests</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {testResults.map((result, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between p-4 border rounded-lg"
                  >
                    <div className="flex items-center gap-3">
                      {result.status === "running" && (
                        <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
                      )}
                      {result.status === "success" && (
                        <CheckCircle2 className="h-5 w-5 text-green-500" />
                      )}
                      {result.status === "failed" && <XCircle className="h-5 w-5 text-red-500" />}
                      <div>
                        <p className="font-medium">{result.test}</p>
                        <p className="text-sm text-muted-foreground">{result.message}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <Badge variant={result.status === "success" ? "default" : "destructive"}>
                        {result.duration}ms
                      </Badge>
                    </div>
                  </div>
                ))}

                {testResults.length === 0 && (
                  <div className="text-center py-12 text-muted-foreground">
                    No test results yet. Configure and run a test.
                  </div>
                )}
              </div>

              {testSummary && (
                <div className="mt-6 p-4 bg-muted rounded-lg">
                  <h3 className="font-semibold mb-3">Test Summary</h3>
                  <div className="grid grid-cols-4 gap-4">
                    <div>
                      <p className="text-sm text-muted-foreground">Total Tests</p>
                      <p className="text-2xl font-bold">{testSummary.totalTests}</p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Passed</p>
                      <p className="text-2xl font-bold text-green-500">{testSummary.passed}</p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Failed</p>
                      <p className="text-2xl font-bold text-red-500">{testSummary.failed}</p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Duration</p>
                      <p className="text-2xl font-bold">{testSummary.duration}ms</p>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
        </div>
      </div>
    </div>
  )
}

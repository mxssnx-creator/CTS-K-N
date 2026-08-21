"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, CheckCircle2, XCircle, Play, RefreshCw, Loader2, Send } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { LIVE_ORDER_CONFIRMATION_PHRASE } from "@/lib/live-order-safety"
import { useExchange } from "@/lib/exchange-context"

interface TestResult {
  testName: string
  success: boolean
  duration: number
  details: string
  error?: string
}

interface TestReport {
  connectionId: string
  connectionName: string
  exchange: string
  timestamp: number
  tests: TestResult[]
  summary: {
    totalTests: number
    passed: number
    failed: number
    successRate: number
  }
}

interface PlacedOrder {
  orderId: string
  symbol: string
  side: string
  quantity: number
  leverage: number
  timestamp: number
  success: boolean
}

export default function OrderTestingPage() {
  const { selectedConnectionId } = useExchange()
  const connectionId = selectedConnectionId ?? ""
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState<TestReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adminSecret, setAdminSecret] = useState("")
  const [confirmationText, setConfirmationText] = useState("")
  const [liveAcknowledged, setLiveAcknowledged] = useState(false)
  
  // Quick order placement state
  const [placingOrder, setPlacingOrder] = useState(false)
  const [orderSymbol, setOrderSymbol] = useState("BTC/USDT")
  const [orderSide, setOrderSide] = useState<"buy" | "sell">("buy")
  const [leverage, setLeverage] = useState(20)
  const [volume, setVolume] = useState(0.001)
  const [placedOrders, setPlacedOrders] = useState<PlacedOrder[]>([])
  const liveRequestReady = adminSecret.trim().length >= 16 &&
    liveAcknowledged && confirmationText === LIVE_ORDER_CONFIRMATION_PHRASE

  const readFailure = async (response: Response): Promise<string> => {
    try {
      const payload = await response.json()
      return payload.error || payload.message || `HTTP ${response.status}`
    } catch {
      return `HTTP ${response.status}`
    }
  }

  const runTests = async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch("/api/test/live-orders-test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminSecret}`,
        },
        body: JSON.stringify({
          connectionId,
          liveOrderConfirmation: confirmationText,
          confirmLiveOrderPlacement: liveAcknowledged,
        }),
      })

      if (!response.ok) {
        throw new Error(await readFailure(response))
      }

      const data = await response.json()
      setReport(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  }

  const placeOrderWithMaxLeverageMinVolume = async () => {
    setPlacingOrder(true)
    setError(null)
    try {
      const response = await fetch("/api/testing/place-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminSecret}`,
        },
        body: JSON.stringify({
          connectionId,
          symbol: orderSymbol,
          side: orderSide,
          quantity: volume,
          leverage,
          liveOrderConfirmation: confirmationText,
          confirmLiveOrderPlacement: liveAcknowledged,
        }),
      })

      if (!response.ok) {
        throw new Error(await readFailure(response))
      }

      const result = await response.json()
      
      if (result.success) {
        const newOrder: PlacedOrder = {
          orderId: result.orderId || "N/A",
          symbol: orderSymbol,
          side: orderSide,
          quantity: volume,
          leverage,
          timestamp: Date.now(),
          success: true,
        }
        setPlacedOrders((current) => [newOrder, ...current])
        setError(null)
      } else {
        setError(result.error || "Failed to place order")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setPlacingOrder(false)
    }
  }

  const getStatusIcon = (success: boolean) => {
    return success ? (
      <CheckCircle2 className="w-5 h-5 text-green-600" />
    ) : (
      <XCircle className="w-5 h-5 text-red-600" />
    )
  }

  return (
    <div className="page-section flex flex-col gap-5">
      <Alert variant="destructive" className="border-destructive/35 bg-destructive/5">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          This page can place real exchange orders. The server must explicitly enable live placement, and every request requires admin authentication plus the exact confirmation phrase.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Live-test authorization</CardTitle>
          <CardDescription>Credentials remain in this page state and are not stored by the interface.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="order-test-admin-secret">Admin secret</Label>
            <Input
              id="order-test-admin-secret"
              type="password"
              autoComplete="off"
              value={adminSecret}
              onChange={(event) => setAdminSecret(event.target.value)}
              placeholder="Server ADMIN_SECRET"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="order-test-confirmation">Confirmation phrase</Label>
            <Input
              id="order-test-confirmation"
              value={confirmationText}
              onChange={(event) => setConfirmationText(event.target.value)}
              placeholder={LIVE_ORDER_CONFIRMATION_PHRASE}
              autoComplete="off"
            />
          </div>
          <label className="flex items-start gap-3 rounded-lg border bg-muted/25 p-3 text-sm lg:col-span-2">
            <Checkbox
              checked={liveAcknowledged}
              onCheckedChange={(checked) => setLiveAcknowledged(checked === true)}
              aria-label="Acknowledge real order execution"
            />
            <span>
              <span className="block font-medium">I authorize supervised real-order testing</span>
              <span className="block text-xs text-muted-foreground">Orders and protective controls can affect the selected live exchange account.</span>
            </span>
          </label>
        </CardContent>
      </Card>

      <Card className="border-sky-500/25 bg-sky-500/5">
        <CardHeader>
          <CardTitle>Quick Order Placement</CardTitle>
          <CardDescription>Place orders with max leverage and minimal volume</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">Selected connection</label>
              <input
                type="text"
                value={connectionId}
                readOnly
                placeholder="Select an active connection"
                className="w-full px-3 py-2 border border-input bg-background rounded-md mt-1"
                disabled
              />
            </div>
            <div>
              <label className="text-sm font-medium">Symbol</label>
              <input
                type="text"
                value={orderSymbol}
                onChange={(e) => setOrderSymbol(e.target.value)}
                placeholder="BTC/USDT"
                className="w-full px-3 py-2 border border-input bg-background rounded-md mt-1"
                disabled={placingOrder}
              />
            </div>
            <div>
              <label className="text-sm font-medium">Side</label>
              <select
                value={orderSide}
                onChange={(e) => setOrderSide(e.target.value as "buy" | "sell")}
                className="w-full px-3 py-2 border border-input bg-background rounded-md mt-1"
                disabled={placingOrder}
              >
                <option value="buy">Buy</option>
                <option value="sell">Sell</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">Leverage: {leverage}x</label>
              <input
                type="range"
                min="1"
                max="125"
                value={leverage}
                onChange={(e) => setLeverage(Number(e.target.value))}
                className="w-full mt-1"
                disabled={placingOrder}
              />
              <div className="text-xs text-muted-foreground mt-1">Min volume will adjust leverage if needed</div>
            </div>
            <div>
              <label className="text-sm font-medium">Volume (Coins): {volume}</label>
              <input
                type="number"
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                step="0.0001"
                min="0.0001"
                max="1"
                className="w-full px-3 py-2 border border-input bg-background rounded-md mt-1"
                disabled={placingOrder}
              />
            </div>
            <div className="flex items-end">
              <Button
                onClick={placeOrderWithMaxLeverageMinVolume}
                disabled={placingOrder || !liveRequestReady || !connectionId.trim() || !orderSymbol.trim() || volume <= 0}
                className="w-full gap-2"
              >
                {placingOrder ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Placing...
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    Place Order
                  </>
                )}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {placedOrders.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Placed Orders</CardTitle>
            <CardDescription>{placedOrders.length} order(s) placed</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {placedOrders.map((order, idx) => (
                <div key={idx} className="border border-border rounded-lg p-3 bg-muted/25">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold text-sm">{order.symbol} - {order.side.toUpperCase()}</p>
                      <p className="text-xs text-muted-foreground">
                        Qty: {order.quantity} | Leverage: {order.leverage}x | Order ID: {order.orderId}
                      </p>
                      <p className="text-xs text-muted-foreground">{new Date(order.timestamp).toLocaleTimeString()}</p>
                    </div>
                    <CheckCircle2 className="w-5 h-5 text-green-600" />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Test Configuration</CardTitle>
          <CardDescription>Run comprehensive tests for the active connection selection</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-4 items-end">
          <div className="flex-1">
            <label className="text-sm font-medium">Selected connection</label>
            <input
              type="text"
              value={connectionId}
              readOnly
              placeholder="Select an active connection"
              className="w-full px-3 py-2 border border-input bg-background rounded-md mt-1"
              disabled
            />
          </div>
          <Button onClick={runTests} disabled={loading || !liveRequestReady || !connectionId.trim()} className="gap-2">
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Testing...
              </>
            ) : (
              <>
                <Play className="w-4 h-4" />
                Run Tests
              </>
            )}
          </Button>
          {report && (
            <Button variant="outline" onClick={runTests} disabled={loading || !liveRequestReady || !connectionId.trim()} className="gap-2">
              <RefreshCw className="w-4 h-4" />
              Retry
            </Button>
          )}
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {report && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Test Summary</CardTitle>
              <CardDescription>
                {report.connectionName} ({report.exchange}) - {new Date(report.timestamp).toLocaleString()}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-4 gap-4">
                <div className="text-center p-4 bg-muted/25 rounded-lg">
                  <div className="text-3xl font-bold">{report.summary.totalTests}</div>
                  <div className="text-sm text-muted-foreground">Total Tests</div>
                </div>
                <div className="text-center p-4 bg-emerald-500/10 rounded-lg">
                  <div className="text-3xl font-bold text-green-600">{report.summary.passed}</div>
                  <div className="text-sm text-muted-foreground">Passed</div>
                </div>
                <div className="text-center p-4 bg-destructive/10 rounded-lg">
                  <div className="text-3xl font-bold text-red-600">{report.summary.failed}</div>
                  <div className="text-sm text-muted-foreground">Failed</div>
                </div>
                <div className="text-center p-4 bg-sky-500/10 rounded-lg">
                  <div className="text-3xl font-bold text-blue-600">{report.summary.successRate.toFixed(1)}%</div>
                  <div className="text-sm text-muted-foreground">Success Rate</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Test Results</CardTitle>
              <CardDescription>Detailed results for each test</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {report.tests.map((test, idx) => (
                  <div key={idx} className="border border-border rounded-lg p-4">
                    <div className="flex items-start gap-3">
                      <div className="mt-1">{getStatusIcon(test.success)}</div>
                      <div className="flex-1">
                        <h3 className="font-semibold flex items-center gap-2">
                          {test.testName}
                          <span className="text-sm text-muted-foreground">({test.duration}ms)</span>
                        </h3>
                        <p className="text-sm text-foreground mt-1">{test.details}</p>
                        {test.error && (
                          <p className="text-sm text-red-600 mt-2">Error: {test.error}</p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="bg-sky-500/10 border-sky-500/30">
            <CardHeader>
              <CardTitle>Test Information</CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-2">
              <p>
                <strong>Test Suite:</strong> Comprehensive order lifecycle testing including market orders, limit orders, stop loss orders, control order creation/cancellation, and position management.
              </p>
              <p>
                <strong>Quantity:</strong> The server normalizes the requested quantity against exchange precision and minimum-order rules; rejected constraints remain visible in the result.
              </p>
              <p>
                <strong>Exchange scope:</strong> The selected configured connector determines which native order and protection capabilities are exercised.
              </p>
              <p>
                <strong>Safety:</strong> Authentication, server enablement, request confirmation, order IDs, cancellations, and protection checks are reported independently; a partial pass is never presented as complete success.
              </p>
            </CardContent>
          </Card>
        </>
      )}

      {!report && !loading && (
        <Card className="bg-muted/25">
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-center">Click "Run Tests" to start the comprehensive order testing suite.</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

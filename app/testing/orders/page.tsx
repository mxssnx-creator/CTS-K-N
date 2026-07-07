"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, CheckCircle2, XCircle, Play, RefreshCw, Loader2, Send } from "lucide-react"

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
  const [connectionId, setConnectionId] = useState("bingx-x01")
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState<TestReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  
  // Quick order placement state
  const [placingOrder, setPlacingOrder] = useState(false)
  const [orderSymbol, setOrderSymbol] = useState("BTC/USDT")
  const [orderSide, setOrderSide] = useState<"buy" | "sell">("buy")
  const [leverage, setLeverage] = useState(20)
  const [volume, setVolume] = useState(0.001)
  const [placedOrders, setPlacedOrders] = useState<PlacedOrder[]>([])

  const runTests = async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch("/api/test/live-orders-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId }),
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId,
          symbol: orderSymbol,
          side: orderSide,
          quantity: volume,
          leverage,
        }),
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
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
        setPlacedOrders([newOrder, ...placedOrders])
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
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-3xl font-bold">Order Testing Suite</h1>
        <p className="text-gray-600 mt-2">Comprehensive testing for order placement, cancellation, and lifecycle management</p>
      </div>

      <Card className="border-blue-200 bg-blue-50">
        <CardHeader>
          <CardTitle className="text-blue-900">Quick Order Placement</CardTitle>
          <CardDescription>Place orders with max leverage and minimal volume</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">Connection ID</label>
              <input
                type="text"
                value={connectionId}
                onChange={(e) => setConnectionId(e.target.value)}
                placeholder="bingx-x01"
                className="w-full px-3 py-2 border border-gray-300 rounded-md mt-1"
                disabled={placingOrder}
              />
            </div>
            <div>
              <label className="text-sm font-medium">Symbol</label>
              <input
                type="text"
                value={orderSymbol}
                onChange={(e) => setOrderSymbol(e.target.value)}
                placeholder="BTC/USDT"
                className="w-full px-3 py-2 border border-gray-300 rounded-md mt-1"
                disabled={placingOrder}
              />
            </div>
            <div>
              <label className="text-sm font-medium">Side</label>
              <select
                value={orderSide}
                onChange={(e) => setOrderSide(e.target.value as "buy" | "sell")}
                className="w-full px-3 py-2 border border-gray-300 rounded-md mt-1"
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
              <div className="text-xs text-gray-600 mt-1">Min volume will adjust leverage if needed</div>
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
                className="w-full px-3 py-2 border border-gray-300 rounded-md mt-1"
                disabled={placingOrder}
              />
            </div>
            <div className="flex items-end">
              <Button
                onClick={placeOrderWithMaxLeverageMinVolume}
                disabled={placingOrder}
                className="w-full gap-2 bg-blue-600 hover:bg-blue-700"
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
                <div key={idx} className="border border-gray-200 rounded-lg p-3 bg-gray-50">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold text-sm">{order.symbol} - {order.side.toUpperCase()}</p>
                      <p className="text-xs text-gray-600">
                        Qty: {order.quantity} | Leverage: {order.leverage}x | Order ID: {order.orderId}
                      </p>
                      <p className="text-xs text-gray-500">{new Date(order.timestamp).toLocaleTimeString()}</p>
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
          <CardDescription>Select connection and run comprehensive tests</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-4 items-end">
          <div className="flex-1">
            <label className="text-sm font-medium">Connection ID</label>
            <input
              type="text"
              value={connectionId}
              onChange={(e) => setConnectionId(e.target.value)}
              placeholder="Enter connection ID"
              className="w-full px-3 py-2 border border-gray-300 rounded-md mt-1"
              disabled={loading}
            />
          </div>
          <Button onClick={runTests} disabled={loading} className="gap-2">
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
            <Button variant="outline" onClick={runTests} disabled={loading} className="gap-2">
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
                <div className="text-center p-4 bg-gray-50 rounded-lg">
                  <div className="text-3xl font-bold">{report.summary.totalTests}</div>
                  <div className="text-sm text-gray-600">Total Tests</div>
                </div>
                <div className="text-center p-4 bg-green-50 rounded-lg">
                  <div className="text-3xl font-bold text-green-600">{report.summary.passed}</div>
                  <div className="text-sm text-gray-600">Passed</div>
                </div>
                <div className="text-center p-4 bg-red-50 rounded-lg">
                  <div className="text-3xl font-bold text-red-600">{report.summary.failed}</div>
                  <div className="text-sm text-gray-600">Failed</div>
                </div>
                <div className="text-center p-4 bg-blue-50 rounded-lg">
                  <div className="text-3xl font-bold text-blue-600">{report.summary.successRate.toFixed(1)}%</div>
                  <div className="text-sm text-gray-600">Success Rate</div>
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
                  <div key={idx} className="border border-gray-200 rounded-lg p-4">
                    <div className="flex items-start gap-3">
                      <div className="mt-1">{getStatusIcon(test.success)}</div>
                      <div className="flex-1">
                        <h3 className="font-semibold flex items-center gap-2">
                          {test.testName}
                          <span className="text-sm text-gray-500">({test.duration}ms)</span>
                        </h3>
                        <p className="text-sm text-gray-700 mt-1">{test.details}</p>
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

          <Card className="bg-blue-50 border-blue-200">
            <CardHeader>
              <CardTitle>Test Information</CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-2">
              <p>
                <strong>Test Suite:</strong> Comprehensive order lifecycle testing including market orders, limit orders, stop loss orders, control order creation/cancellation, and position management.
              </p>
              <p>
                <strong>Minimum Balance:</strong> Tests adapt to available balance. Market orders require {`>= 10`} USDT. Tests use minimal quantities to work with low balances.
              </p>
              <p>
                <strong>Exchange Support:</strong> Full support for BingX, Bybit, Binance, OKX, Pionex, OrangeX - each with native order types and features.
              </p>
              <p>
                <strong>Fixed Issues:</strong> Critical BingX symbol conversion bug fixed (slash format handling). Order placement now working across all supported exchanges.
              </p>
            </CardContent>
          </Card>
        </>
      )}

      {!report && !loading && (
        <Card className="bg-gray-50">
          <CardContent className="pt-6">
            <p className="text-gray-600 text-center">Click "Run Tests" to start the comprehensive order testing suite.</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

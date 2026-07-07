"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"

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

export function TestLiveOrders({ connectionId }: { connectionId: string }) {
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState<TestReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  const runTest = async () => {
    try {
      setLoading(true)
      setError(null)
      setReport(null)

      const response = await fetch("/api/test/live-orders-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId }),
      })

      if (!response.ok) {
        const errData = await response.json()
        throw new Error(errData.error || "Test failed")
      }

      const data = await response.json()
      setReport(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <Button onClick={runTest} disabled={loading}>
        {loading ? "Running Tests..." : "Test Live Orders & Positions"}
      </Button>

      {error && (
        <Card className="p-4 bg-red-50 border-red-200">
          <p className="text-red-700">Error: {error}</p>
        </Card>
      )}

      {report && (
        <Card className="p-4 space-y-4">
          <div className="space-y-2">
            <h3 className="font-semibold">{report.connectionName} ({report.exchange})</h3>
            <div className="text-sm text-gray-600">
              <p>
                Results: <span className="font-semibold text-green-600">{report.summary.passed}</span> passed,{" "}
                <span className="font-semibold text-red-600">{report.summary.failed}</span> failed (
                {report.summary.successRate.toFixed(1)}%)
              </p>
            </div>
          </div>

          <div className="space-y-2">
            {report.tests.map((test, i) => (
              <div
                key={i}
                className={`p-3 rounded border text-sm ${
                  test.success
                    ? "bg-green-50 border-green-200"
                    : "bg-red-50 border-red-200"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{test.testName}</span>
                  <span className={test.success ? "text-green-600" : "text-red-600"}>
                    {test.success ? "✓" : "✗"}
                  </span>
                </div>
                <p className="text-xs text-gray-600 mt-1">{test.details}</p>
                {test.error && (
                  <p className="text-xs text-red-600 mt-1">Error: {test.error}</p>
                )}
                <p className="text-xs text-gray-500 mt-1">{test.duration}ms</p>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

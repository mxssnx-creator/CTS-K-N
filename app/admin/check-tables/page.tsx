"use client"
export const dynamic = "force-dynamic"


import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"

export default function CheckTablesPage() {
  const [result, setResult] = useState<any>(null)
  const [loading, setLoading] = useState(false)

  async function checkTables() {
    setLoading(true)
    try {
      const response = await fetch("/api/admin/check-tables")
      const data = await response.json()
      setResult(data)
    } catch (error) {
      console.error("Failed to check tables:", error)
      setResult({ success: false, error: String(error) })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold mb-6">Database Table Inspector</h1>
      
      <Button onClick={checkTables} disabled={loading} className="mb-6">
        {loading ? "Checking..." : "Check Tables"}
      </Button>

      {result && (
        <Card className="p-6">
          <pre className="overflow-auto text-sm">
            {JSON.stringify(result, null, 2)}
          </pre>
        </Card>
      )}
    </div>
  )
}

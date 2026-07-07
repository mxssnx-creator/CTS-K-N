"use client"
export const dynamic = "force-dynamic"


import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"

export default function MigratePage() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<any>(null)

  async function runMigrations() {
    setLoading(true)
    setResult(null)

    try {
      const response = await fetch("/api/admin/run-migrations", {
        method: "POST",
      })

      const data = await response.json()
      setResult(data)
    } catch (error: any) {
      setResult({
        success: false,
        error: error.message || "Failed to run migrations",
      })
    } finally {
      setLoading(false)
    }
  }

  async function resetAndInit() {
    if (!confirm("This will DROP ALL TABLES and recreate them. All data will be lost. Continue?")) {
      return
    }

    setLoading(true)
    setResult(null)

    try {
      const response = await fetch("/api/admin/reset-and-init", {
        method: "POST",
      })

      const data = await response.json()
      setResult(data)
    } catch (error: any) {
      setResult({
        success: false,
        error: error.message || "Failed to reset database",
      })
    } finally {
      setLoading(false)
    }
  }

  async function initDirect() {
    if (!confirm("This will execute the SQL file directly using SQLite batch mode. Continue?")) {
      return
    }

    setLoading(true)
    setResult(null)

    try {
      const response = await fetch("/api/admin/init-database-direct", {
        method: "POST",
      })

      const data = await response.json()
      setResult(data)
    } catch (error: any) {
      setResult({
        success: false,
        error: error.message || "Failed to initialize database",
      })
    } finally {
      setLoading(false)
    }
  }

  async function quickReinit() {
    setLoading(true)
    setResult(null)

    try {
      const response = await fetch("/api/admin/reinit-db", {
        method: "POST",
      })

      const data = await response.json()
      setResult(data)
    } catch (error: any) {
      setResult({
        success: false,
        error: error.message || "Failed to reinitialize database",
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-6">
      <Card className="p-6 max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold mb-4">Database Migrations</h1>
        <p className="text-muted-foreground mb-6">
          Click the button below to run all database migrations and create missing tables.
        </p>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Button onClick={quickReinit} disabled={loading} size="lg" variant="default">
            {loading ? "Updating..." : "Quick Reinit"}
          </Button>
          <Button onClick={runMigrations} disabled={loading} size="lg" variant="outline">
            {loading ? "Running..." : "Run Migrations"}
          </Button>
          <Button onClick={initDirect} disabled={loading} size="lg" variant="secondary">
            {loading ? "Initializing..." : "Direct Init"}
          </Button>
          <Button onClick={resetAndInit} disabled={loading} size="lg" variant="destructive">
            {loading ? "Resetting..." : "Reset All"}
          </Button>
        </div>
        <div className="text-sm text-muted-foreground space-y-2 mt-4 p-4 bg-muted rounded-lg">
          <p><strong>Quick Reinit (Recommended):</strong> Quickly re-executes the SQL file to add any missing tables</p>
          <p><strong>Run Migrations:</strong> Parses and executes SQL statements one by one with tracking</p>
          <p><strong>Direct Init:</strong> Full initialization using SQLite batch execution</p>
          <p><strong>Reset All:</strong> Drops all tables first, then recreates (⚠️ loses all data)</p>
        </div>

        {result && (
          <div className="mt-6 p-4 rounded-lg bg-muted">
            <h2 className="font-semibold mb-2">
              {result.success ? "✅ Success" : "❌ Failed"}
            </h2>
            {result.applied !== undefined && (
              <div className="space-y-1 text-sm">
                <p>Applied: {result.applied}</p>
                <p>Skipped: {result.skipped}</p>
                <p>Failed: {result.failed}</p>
                <p className="mt-2">{result.message}</p>
              </div>
            )}
            {result.tables !== undefined && (
              <div className="space-y-1 text-sm">
                <p className="font-semibold mt-2">Total tables: {result.tables}</p>
                {result.tableNames && result.tableNames.length <= 10 && (
                  <p className="text-xs text-muted-foreground">{result.tableNames.join(", ")}</p>
                )}
                <p className="mt-2">{result.message}</p>
              </div>
            )}
            {result.error && (
              <p className="text-destructive text-sm">{result.error}</p>
            )}
          </div>
        )}
      </Card>
    </div>
  )
}

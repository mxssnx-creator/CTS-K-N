"use client"

import { Button } from "@/components/ui/button"
import { Database, RefreshCw, Trash2 } from "lucide-react"
import { toast } from "sonner"

interface DatabaseActionsProps {
  onRefresh?: () => void
}

export function DatabaseActions({ onRefresh }: DatabaseActionsProps) {
  const handleRunMigration = async () => {
    try {
      const response = await fetch("/api/install/run-migration", {
        method: "POST",
      })
      const data = await response.json()
      if (data.success) {
        toast.success(`Migration complete: ${data.applied} applied, ${data.skipped} skipped`)
        onRefresh?.()
      } else {
        toast.error("Migration failed: " + data.error)
      }
    } catch (error) {
      toast.error("Failed to run migration")
    }
  }

  const handleCleanupData = async () => {
    try {
      const response = await fetch("/api/database/cleanup", {
        method: "POST",
      })
      const data = await response.json()
      if (data.success) {
        toast.success("Database cleanup complete")
        onRefresh?.()
      } else {
        toast.error("Cleanup failed: " + data.error)
      }
    } catch (error) {
      toast.error("Failed to cleanup database")
    }
  }

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Database Actions</h3>
      <div className="grid md:grid-cols-3 gap-4">
        <Button variant="outline" onClick={handleRunMigration}>
          <Database className="h-4 w-4 mr-2" />
          Run Migrations
        </Button>
        <Button variant="outline" onClick={onRefresh}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh Status
        </Button>
        <Button variant="outline" onClick={handleCleanupData}>
          <Trash2 className="h-4 w-4 mr-2" />
          Cleanup Old Data
        </Button>
      </div>
    </div>
  )
}

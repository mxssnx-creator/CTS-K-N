"use client"

import { AlertCircle, Database, RefreshCw } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"

export function DatabaseInitAlert() {
  const [showAlert, setShowAlert] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const router = useRouter()

  useEffect(() => {
    // Delayed check to not block initial render
    const checkTables = async () => {
      try {
        if (typeof window === "undefined" || typeof localStorage === "undefined") {
          return
        }

        const isDismissed = localStorage.getItem("db-init-alert-dismissed")
        if (isDismissed) return

        // Try to access a critical API that requires tables
        const response = await fetch("/api/preset-types")
        if (!response.ok && response.status === 500) {
          setShowAlert(true)
        }
      } catch (error) {
        // Silently fail - not critical for preview
        console.debug("[v0] DatabaseInitAlert check skipped:", error)
      }
    }

    // Wait 2 seconds before checking
    const timer = setTimeout(checkTables, 2000)
    return () => clearTimeout(timer)
  }, [])

  const handleDismiss = () => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("db-init-alert-dismissed", "true")
    }
    setDismissed(true)
    setShowAlert(false)
  }

  const handleGoToSettings = () => {
    // Navigate to settings page - the install manager is in the "Overall/Install" tab
    router.push("/settings")
  }

  const handleQuickReinit = async () => {
    try {
      console.log("[v0] Starting quick database reinitialization...")
      const response = await fetch("/api/admin/reinit-db", { method: "POST" })
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      
      const data = await response.json()
      console.log("[v0] Reinit response:", data)
      
      if (data.success) {
        console.log("[v0] Database reinitialized successfully, reloading page...")
        setShowAlert(false)
        if (typeof localStorage !== "undefined") {
          localStorage.removeItem("db-init-alert-dismissed")
        }
        window.location.reload()
      } else {
        throw new Error(data.error || "Reinitialization failed")
      }
    } catch (error) {
      console.error("[v0] Failed to reinit database:", error)
      alert(`Database reinitialization failed: ${error instanceof Error ? error.message : "Unknown error"}. Please go to Database Settings and use the migration tools manually.`)
    }
  }

  if (!showAlert || dismissed) return null

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-2xl px-4">
      <Alert variant="destructive" className="shadow-lg">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle className="flex items-center justify-between">
          <span>Database Initialization Required</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={handleDismiss}
          >
            Dismiss
          </Button>
        </AlertTitle>
        <AlertDescription className="space-y-3">
          <p className="text-sm">
            Critical database tables are missing. The system cannot function properly without initializing the database.
          </p>
          <div className="flex gap-2">
            <Button onClick={handleGoToSettings} size="sm" variant="default">
              <Database className="h-3 w-3 mr-1.5" />
              Go to Settings
            </Button>
            <Button
              onClick={handleQuickReinit}
              size="sm"
              variant="secondary"
            >
              <RefreshCw className="h-3 w-3 mr-1.5" />
              Quick Reinit Now
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    </div>
  )
}

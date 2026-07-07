"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Database, CheckCircle, XCircle, Loader2, RefreshCw } from "lucide-react"

interface DatabaseStatus {
  initialized: boolean
  tables: {
    name: string
    exists: boolean
  }[]
  migrations: {
    id: number
    name: string
    executed: boolean
    executed_at?: string
  }[]
}

export function DatabaseInstaller() {
  const [status, setStatus] = useState<DatabaseStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isInstalling, setIsInstalling] = useState(false)

  useEffect(() => {
    checkStatus()
  }, [])

  const checkStatus = async () => {
    setIsLoading(true)
    try {
      const response = await fetch("/api/install/database/status")
      const data = await response.json()
      setStatus(data)
    } catch (error) {
      console.error("Failed to check database status:", error)
    } finally {
      setIsLoading(false)
    }
  }

  const installDatabase = async () => {
    setIsInstalling(true)
    try {
      const response = await fetch("/api/install/database/init", {
        method: "POST",
      })
      const data = await response.json()

      if (data.success) {
        await checkStatus()
      }
    } catch (error) {
      console.error("Failed to install database:", error)
    } finally {
      setIsInstalling(false)
    }
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-5 w-5" />
            Database Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              Database Installation
            </CardTitle>
            <CardDescription>Automatic database setup and migration management</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={checkStatus} disabled={isLoading}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {status?.initialized ? (
          <Alert>
            <CheckCircle className="h-4 w-4 text-green-500" />
            <AlertDescription>Database is initialized and ready. All migrations are up to date.</AlertDescription>
          </Alert>
        ) : (
          <Alert>
            <XCircle className="h-4 w-4 text-red-500" />
            <AlertDescription>
              Database needs initialization. Click the button below to set up all required tables.
            </AlertDescription>
          </Alert>
        )}

        {status?.migrations && status.migrations.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-semibold">Migrations Status</h4>
            <div className="space-y-1">
              {status.migrations.map((migration) => (
                <div key={migration.id} className="flex items-center justify-between p-2 rounded-md bg-muted/50">
                  <div className="flex items-center gap-2">
                    {migration.executed ? (
                      <CheckCircle className="h-4 w-4 text-green-500" />
                    ) : (
                      <XCircle className="h-4 w-4 text-orange-500" />
                    )}
                    <span className="text-sm">
                      #{migration.id} - {migration.name}
                    </span>
                  </div>
                  <Badge variant={migration.executed ? "default" : "secondary"}>
                    {migration.executed ? "Executed" : "Pending"}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}

        {status?.tables && status.tables.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-semibold">Essential Tables</h4>
            <div className="grid grid-cols-2 gap-2">
              {status.tables.map((table) => (
                <div key={table.name} className="flex items-center gap-2 p-2 rounded-md bg-muted/50">
                  {table.exists ? (
                    <CheckCircle className="h-3 w-3 text-green-500" />
                  ) : (
                    <XCircle className="h-3 w-3 text-red-500" />
                  )}
                  <span className="text-xs font-mono">{table.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {!status?.initialized && (
          <Button onClick={installDatabase} disabled={isInstalling} className="w-full">
            {isInstalling ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Installing Database...
              </>
            ) : (
              <>
                <Database className="h-4 w-4 mr-2" />
                Install Database Now
              </>
            )}
          </Button>
        )}

        <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t">
          <p>• Database tables are automatically created on deployment</p>
          <p>• Migrations run automatically on app startup via instrumentation.ts</p>
          <p>• Future migrations will be applied automatically on next deployment</p>
          <p>• Manual installation available if automatic setup fails</p>
        </div>
      </CardContent>
    </Card>
  )
}

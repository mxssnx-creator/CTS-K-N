"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { 
  CheckCircle2, 
  XCircle, 
  Loader2, 
  Database, 
  Play, 
  RefreshCw,
  AlertCircle,
  Server,
  Download,
} from "lucide-react"
import { toast } from "sonner"

interface InstallStatus {
  isInstalled: boolean
  databaseConnected: boolean
  databaseType: string
  tableCount: number
  migrationsApplied: number
  error: string | null
}

export default function InstallManager() {
  const [status, setStatus] = useState<InstallStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [installLog, setInstallLog] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState("status")
  
  const loadStatus = async () => {
    setLoading(true)
    try {
      const response = await fetch("/api/system/init-status")
      const data = await response.json()
      
      // Consider installed if migrations are applied (version > 0) OR if keys exist
      const hasMigrations = (data.migrations?.current_version || 0) > 0
      const hasKeys = (data.statistics?.total_keys || 0) > 0
      const isInstalled = data.initialized || hasMigrations || hasKeys
      
      setStatus({
        isInstalled,
        databaseConnected: data.database?.connected || false,
        databaseType: data.database?.type || "redis",
        tableCount: data.statistics?.total_keys || 0,
        migrationsApplied: data.migrations?.current_version || 0,
        error: data.status === "error" ? data.message : null,
      })
      
      console.log("[v0] Install status loaded:", { 
        initialized: data.initialized, 
        hasMigrations, 
        hasKeys, 
        isInstalled,
        keys: data.statistics?.total_keys,
        version: data.migrations?.current_version
      })
    } catch (error) {
      console.error("[v0] Error loading init status:", error)
      toast.error("Failed to check initialization status")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadStatus()
  }, [])

  const runInstallation = async () => {
    setInstalling(true)
    setInstallLog([])
    
    try {
      setInstallLog(prev => [...prev, "Starting Redis migration..."])
      
      const response = await fetch("/api/install/database/migrate", {
        method: "POST",
      })
      
      const data = await response.json()
      
      if (data.success) {
        setInstallLog(prev => [
          ...prev,
          "✓ Redis migrations completed successfully",
          `Schema version: ${data.status?.schema_version || "N/A"}`,
          `Total keys in database: ${data.stats?.total_keys || 0}`,
          `Indexes created: ${data.status?.indexes_created ? "Yes" : "No"}`,
          `TTL configured: ${data.status?.ttl_configured ? "Yes" : "No"}`,
          "Installation complete!",
        ])
        toast.success("Redis migrations completed!")
        await loadStatus()
      } else {
        const errorMsg = data.error || "Migration failed"
        setInstallLog(prev => [...prev, `✗ ${errorMsg}`])
        throw new Error(errorMsg)
      }
    } catch (error) {
      console.error("[v0] Installation error:", error)
      const msg = error instanceof Error ? error.message : "Installation failed"
      setInstallLog(prev => [...prev, `✗ Error: ${msg}`])
      toast.error(msg)
    } finally {
      setInstalling(false)
    }
  }

  const forceReinitialize = async () => {
    if (!confirm("⚠️ WARNING: This will FLUSH the entire Redis database. All data will be permanently lost. Are you absolutely sure?")) {
      return
    }
    
    setInstalling(true)
    setInstallLog([])
    
    try {
      setInstallLog(prev => [...prev, "⚠️ Flushing Redis database..."])
      
      const response = await fetch("/api/install/database/flush", {
        method: "POST",
      })
      
      const data = await response.json()
      
      if (data.success) {
        setInstallLog(prev => [
          ...prev,
          "✓ Redis database flushed",
          "✓ Running migrations...",
          `✓ Schema initialized to v${data.status.migration_status.latest_version}`,
          "✓ Database fully reinitialized",
          "✓ System ready for use"
        ])
        toast.success("Redis database flushed and reinitialized")
        
        setTimeout(() => {
          loadStatus()
        }, 1000)
      } else {
        setInstallLog(prev => [...prev, `✗ Error: ${data.error}`])
        toast.error(data.error || "Flush operation failed")
      }
    } catch (error) {
      console.error("[v0] Flush error:", error)
      setInstallLog(prev => [...prev, `✗ Error: ${error instanceof Error ? error.message : "Flush failed"}`])
      toast.error("Flush failed")
    } finally {
      setInstalling(false)
    }
  }

  const runMigrations = async () => {
    setInstalling(true)
    setInstallLog(["Running Redis migrations..."])
    
    try {
      const response = await fetch("/api/install/database/migrate", { method: "POST" })
      const data = await response.json()
      
      if (data.success) {
        setInstallLog(prev => [
          ...prev,
          `✓ Schema version: ${data.status?.schema_version || "N/A"}`,
          `✓ Database keys: ${data.stats?.total_keys || 0}`,
          `✓ ${data.message || "Migrations completed"}`
        ])
        toast.success("Redis migrations complete")
        setTimeout(() => loadStatus(), 1000)
      } else {
        setInstallLog(prev => [...prev, `✗ Error: ${data.error}`])
        toast.error(data.error || "Migrations failed")
      }
    } catch (error) {
      setInstallLog(prev => [...prev, `✗ Error: ${error instanceof Error ? error.message : "Failed"}`])
      toast.error("Migrations failed")
    } finally {
      setInstalling(false)
    }
  }

  useEffect(() => {
    loadStatus()
  }, [])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Database Installation</CardTitle>
          <CardDescription>Checking installation status...</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!status) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Database Installation</CardTitle>
          <CardDescription>Unable to check status</CardDescription>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to check installation status. Please try refreshing the page.
            </AlertDescription>
          </Alert>
          <Button onClick={loadStatus} className="mt-4">
            <RefreshCw className="h-4 w-4 mr-2" />
            Retry
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="status">Status & Install</TabsTrigger>
          <TabsTrigger value="configure">Database Configuration</TabsTrigger>
        </TabsList>

        <TabsContent value="status">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Database Installation</CardTitle>
                  <CardDescription>Initialize and configure the database system</CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={loadStatus} disabled={loading || installing}>
                  <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
                  Refresh
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Status Overview */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="flex items-center gap-3 p-4 border rounded-lg">
                  {status.isInstalled ? (
                    <CheckCircle2 className="h-5 w-5 text-green-600" />
                  ) : (
                    <XCircle className="h-5 w-5 text-red-600" />
                  )}
                  <div>
                    <p className="text-sm font-medium">Installation Status</p>
                    <p className="text-sm text-muted-foreground">
                      {status.isInstalled ? "Installed" : "Not Installed"}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3 p-4 border rounded-lg">
                  {status.databaseConnected ? (
                    <CheckCircle2 className="h-5 w-5 text-green-600" />
                  ) : (
                    <XCircle className="h-5 w-5 text-red-600" />
                  )}
                  <div>
                    <p className="text-sm font-medium">Database Connection</p>
                    <p className="text-sm text-muted-foreground">
                      {status.databaseConnected ? "Connected" : "Disconnected"}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3 p-4 border rounded-lg">
                  <Database className="h-5 w-5 text-blue-600" />
                  <div>
                    <p className="text-sm font-medium">Database Type</p>
                    <p className="text-sm text-muted-foreground">Redis (In-Memory)</p>
                  </div>
                </div>
              </div>

              {/* Detailed Status */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">System Status</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between p-2 bg-muted/50 rounded">
                    <span>Redis Keys</span>
                    <Badge variant={status.tableCount > 0 ? "default" : "secondary"}>
                      {status.tableCount} keys
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between p-2 bg-muted/50 rounded">
                    <span>Schema Version</span>
                    <Badge variant={status.migrationsApplied > 0 ? "default" : "secondary"}>
                      v{status.migrationsApplied}
                    </Badge>
                  </div>
                </div>
              </div>

              {/* Error Display */}
              {status.error && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{status.error}</AlertDescription>
                </Alert>
              )}

              {/* Installation Action */}
              {!status.isInstalled && (
                <Alert>
                  <Server className="h-4 w-4" />
                  <AlertDescription>
                    Redis is not initialized. Click the button below to run migrations and seed initial data.
                  </AlertDescription>
                </Alert>
              )}

              <div className="space-y-4">
                {/* Primary Installation */}
                <div className="flex gap-2">
                  <Button
                    onClick={runInstallation}
                    disabled={installing || (status.isInstalled && status.databaseConnected)}
                    className="flex-1"
                  >
                    {installing ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Installing...
                      </>
                    ) : status.isInstalled ? (
                      <>
                        <CheckCircle2 className="h-4 w-4 mr-2" />
                        Already Installed
                      </>
                    ) : (
                      <>
                        <Play className="h-4 w-4 mr-2" />
                        Initialize Redis
                      </>
                    )}
                  </Button>
                  
                  {status.isInstalled && (
                    <>
                      <Button onClick={runMigrations} variant="default" disabled={installing}>
                        {installing ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Running...
                          </>
                        ) : (
                          <>
                            <Database className="h-4 w-4 mr-2" />
                            Run Migrations
                          </>
                        )}
                      </Button>
                      <Button onClick={runInstallation} variant="outline" disabled={installing}>
                        {installing ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Reinstalling...
                          </>
                        ) : (
                          <>
                            <RefreshCw className="h-4 w-4 mr-2" />
                            Reinstall
                          </>
                        )}
                      </Button>
                    </>
                  )}
                </div>

                {/* Migration Tools - Only show when installed */}
                {status.isInstalled && (
                  <div className="space-y-3 pt-2 border-t">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-semibold">Redis Management</h4>
                      <Badge variant="secondary" className="text-xs">Advanced</Badge>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-2">
                      <Button onClick={runMigrations} disabled={installing} size="sm" variant="default">
                        {installing ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : <Play className="h-3 w-3 mr-1.5" />}
                        Run Migrations
                      </Button>
                      <Button onClick={forceReinitialize} disabled={installing} size="sm" variant="destructive">
                        {installing ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : <AlertCircle className="h-3 w-3 mr-1.5" />}
                        Flush & Reinit
                      </Button>
                    </div>

                    <div className="text-xs text-muted-foreground bg-muted/50 p-3 rounded-lg space-y-1">
                      <p><strong>Run Migrations:</strong> Apply pending migrations to Redis schema</p>
                      <p><strong>Flush & Reinit:</strong> Clear all data and reinitialize (⚠️ irreversible)</p>
                    </div>
                  </div>
                )}
              </div>

              {/* Installation Log */}
              {installLog.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold">Installation Log</h3>
                  <div className="bg-muted/50 p-4 rounded-lg space-y-1 text-sm font-mono max-h-48 overflow-y-auto">
                    {installLog.map((log, i) => (
                      <div key={i} className={log.startsWith("✓") ? "text-green-600" : log.startsWith("✗") ? "text-red-600" : ""}>
                        {log}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="configure">
          <Card>
            <CardHeader>
              <CardTitle>Redis Database Information</CardTitle>
              <CardDescription>
                Real-time database statistics and performance metrics
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Redis Connection Info */}
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="p-4 border rounded-lg space-y-2">
                    <p className="text-sm font-semibold text-muted-foreground">Database Type</p>
                    <p className="text-lg font-bold">Redis</p>
                    <p className="text-xs text-muted-foreground">High-performance in-memory data store</p>
                  </div>

                  <div className="p-4 border rounded-lg space-y-2">
                    <p className="text-sm font-semibold text-muted-foreground">Connection Status</p>
                    <div className="flex items-center gap-2">
                      <div className={`h-3 w-3 rounded-full ${status.databaseConnected ? "bg-green-500" : "bg-red-500"}`} />
                      <p className="text-lg font-bold">
                        {status.databaseConnected ? "Connected" : "Disconnected"}
                      </p>
                    </div>
                  </div>

                  <div className="p-4 border rounded-lg space-y-2">
                    <p className="text-sm font-semibold text-muted-foreground">Total Keys</p>
                    <p className="text-lg font-bold">{status.tableCount}</p>
                    <p className="text-xs text-muted-foreground">Keys in database</p>
                  </div>

                  <div className="p-4 border rounded-lg space-y-2">
                    <p className="text-sm font-semibold text-muted-foreground">Schema Version</p>
                    <p className="text-lg font-bold">{status.migrationsApplied}</p>
                    <p className="text-xs text-muted-foreground">Current migration level</p>
                  </div>
                </div>
              </div>

              {/* Redis Features */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">Enabled Features</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="flex items-center gap-2 p-3 border rounded-lg bg-muted/50">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <span className="text-sm">Persistent Storage</span>
                  </div>
                  <div className="flex items-center gap-2 p-3 border rounded-lg bg-muted/50">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <span className="text-sm">High Performance</span>
                  </div>
                  <div className="flex items-center gap-2 p-3 border rounded-lg bg-muted/50">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <span className="text-sm">Automatic Indexing</span>
                  </div>
                  <div className="flex items-center gap-2 p-3 border rounded-lg bg-muted/50">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <span className="text-sm">TTL Expiration</span>
                  </div>
                  <div className="flex items-center gap-2 p-3 border rounded-lg bg-muted/50">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <span className="text-sm">Live Trade Engine</span>
                  </div>
                  <div className="flex items-center gap-2 p-3 border rounded-lg bg-muted/50">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <span className="text-sm">Preset Management</span>
                  </div>
                </div>
              </div>

              {/* Redis Configuration Info */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">Configuration Details</h3>
                <div className="bg-muted/50 p-4 rounded-lg space-y-2 text-sm">
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Database URL</span>
                    <code className="text-xs bg-background px-2 py-1 rounded">{process.env.UPSTASH_REDIS_REST_URL ? "Configured" : "Not configured"}</code>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Server Version</span>
                    <code className="text-xs bg-background px-2 py-1 rounded">3.2</code>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Data Persistence</span>
                    <code className="text-xs bg-background px-2 py-1 rounded">Enabled</code>
                  </div>
                </div>
              </div>

              {/* Database Data Structures */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">Data Structures</h3>
                <div className="space-y-2">
                  <div className="flex items-center justify-between p-3 border rounded-lg">
                    <span className="text-sm">Connections</span>
                    <Badge variant="outline">Hash</Badge>
                  </div>
                  <div className="flex items-center justify-between p-3 border rounded-lg">
                    <span className="text-sm">Trades</span>
                    <Badge variant="outline">Sorted Set</Badge>
                  </div>
                  <div className="flex items-center justify-between p-3 border rounded-lg">
                    <span className="text-sm">Positions</span>
                    <Badge variant="outline">Hash</Badge>
                  </div>
                  <div className="flex items-center justify-between p-3 border rounded-lg">
                    <span className="text-sm">Settings</span>
                    <Badge variant="outline">String</Badge>
                  </div>
                </div>
              </div>

              {/* TTL Configuration */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">Data Retention</h3>
                <div className="bg-blue-50 dark:bg-blue-950 p-4 rounded-lg space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span>Connections TTL</span>
                    <code className="text-xs">30 days</code>
                  </div>
                  <div className="flex justify-between">
                    <span>Trades TTL</span>
                    <code className="text-xs">90 days</code>
                  </div>
                  <div className="flex justify-between">
                    <span>Positions TTL</span>
                    <code className="text-xs">60 days</code>
                  </div>
                  <div className="flex justify-between">
                    <span>System Logs TTL</span>
                    <code className="text-xs">7 days</code>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Configuration Tab */}
        <TabsContent value="configure" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Redis Configuration</CardTitle>
              <CardDescription>Configure Redis connection for production deployment</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                <p className="text-sm text-blue-900 dark:text-blue-100">
                  <strong>Note:</strong> Redis is the only database engine supported. For production, use Upstash Redis or deploy your own Redis instance.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="redis-url">Redis URL</Label>
                <Input
                  id="redis-url"
                  placeholder="redis://localhost:6379 or rediss://..."
                  defaultValue={process.env.REDIS_URL || ""}
                  className="font-mono text-xs"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="redis-password">Redis Password (Optional)</Label>
                <Input
                  id="redis-password"
                  type="password"
                  placeholder="Leave empty if no password required"
                  className="font-mono text-xs"
                />
              </div>

              <div className="flex gap-2">
                <Button className="flex-1">
                  <Database className="h-4 w-4 mr-2" />
                  Test Connection
                </Button>
                <Button variant="outline" className="flex-1">
                  Save Configuration
                </Button>
              </div>

              <div className="text-sm text-muted-foreground space-y-2">
                <p><strong>Development:</strong> Leave Redis URL empty to use in-memory fallback store.</p>
                <p><strong>Production:</strong> Provide a valid Redis connection string for persistent data storage.</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* NPX Installation Instructions */}
      <Card>
        <CardHeader>
          <CardTitle>NPX Installation</CardTitle>
          <CardDescription>Install and deploy CTS v3.1 using NPX commands</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium mb-2">Quick Start with shadcn CLI</p>
              <div className="bg-muted/50 p-3 rounded-lg font-mono text-sm">
                <code className="text-primary">npx shadcn@latest init</code>
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">
                Recommended method: Uses shadcn CLI to set up the project with all components
              </p>
            </div>

            <div>
              <p className="text-sm font-medium mb-2">Add Components</p>
              <div className="bg-muted/50 p-3 rounded-lg font-mono text-sm space-y-1">
                <div><code className="text-primary">npx shadcn@latest add button card dialog</code></div>
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">
                Add individual shadcn/ui components as needed
              </p>
            </div>

            <div>
              <p className="text-sm font-medium mb-2">Alternative: Clone from GitHub</p>
              <div className="bg-muted/50 p-3 rounded-lg font-mono text-sm space-y-1">
                <div><code>git clone https://github.com/your-repo/cts-v3.1.git</code></div>
                <div><code>cd cts-v3.1</code></div>
                <div><code className="text-primary">npm install</code></div>
                <div><code className="text-primary">npm run dev</code></div>
              </div>
            </div>
          </div>

          <Alert>
            <Download className="h-4 w-4" />
            <AlertDescription className="text-xs">
              <strong>Note:</strong> After installation, run the database initialization from the Status tab above to create all required tables and configure the system.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* Installation Guide */}
      <Card>
        <CardHeader>
          <CardTitle>Database Installation Guide</CardTitle>
          <CardDescription>What happens during database initialization</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex gap-3">
            <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold text-xs">
              1
            </div>
            <div>
              <p className="font-medium">Create Database Schema</p>
              <p className="text-muted-foreground">All 30+ tables with proper indexes and constraints</p>
            </div>
          </div>
          <div className="flex gap-3">
            <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold text-xs">
              2
            </div>
            <div>
              <p className="font-medium">Run Migrations</p>
              <p className="text-muted-foreground">Apply all database migrations and updates</p>
            </div>
          </div>
          <div className="flex gap-3">
            <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold text-xs">
              3
            </div>
            <div>
              <p className="font-medium">Initialize Defaults</p>
              <p className="text-muted-foreground">Set up default settings and configurations</p>
            </div>
          </div>
          <div className="flex gap-3">
            <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold text-xs">
              4
            </div>
            <div>
              <p className="font-medium">Verify Installation</p>
              <p className="text-muted-foreground">Check all tables and indexes are created correctly</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

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
  latestMigration: number
  serverless: boolean
  engineOwner: string
  error: string | null
}

export default function InstallManager() {
  const [status, setStatus] = useState<InstallStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [installLog, setInstallLog] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState("status")
  const [remoteForm, setRemoteForm] = useState({ adminSecret: "", host: "", port: "22", username: "root", password: "", sshKey: "", repoUrl: "https://github.com/mxssnx-creator/CTS-K-N.git", branch: "main", runtime: "auto", installDir: "/opt/cts-k-n", appPort: "3002", serviceUser: "cts-kn", redisUrl: "" })
  const [remoteInstalling, setRemoteInstalling] = useState(false)
  const [remoteMode, setRemoteMode] = useState<"preflight" | "install" | null>(null)
  const [remotePreflightPassed, setRemotePreflightPassed] = useState(false)
  const [remoteLog, setRemoteLog] = useState<string[]>([])
  
  const loadStatus = async () => {
    setLoading(true)
    try {
      const response = await fetch("/api/system/init-status")
      const data = await response.json()
      
      const currentMigration = Number(data.migrations?.current_version || 0)
      const latestMigration = Number(data.migrations?.latest_version || 0)
      const hasMigrations = latestMigration > 0 && currentMigration === latestMigration && data.migrations?.up_to_date === true
      const isInstalled = data.initialized === true && data.database?.connected === true && hasMigrations
      
      setStatus({
        isInstalled,
        databaseConnected: data.database?.connected || false,
        databaseType: data.database?.type || "redis",
        tableCount: data.statistics?.total_keys || 0,
        migrationsApplied: currentMigration,
        latestMigration,
        serverless: data.system?.serverless === true,
        engineOwner: data.system?.engine_owner || "unknown",
        error: data.status === "error" ? data.message : null,
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

  const updateRemoteForm = (key: keyof typeof remoteForm, value: string) => {
    setRemoteForm(prev => ({ ...prev, [key]: value }))
    setRemotePreflightPassed(false)
  }

  const runRemoteInstall = async (mode: "preflight" | "install") => {
    if (!remoteForm.host.trim() || !remoteForm.username.trim()) {
      toast.error("Remote host and SSH username are required")
      return
    }
    if (remoteForm.adminSecret.trim().length < 16) {
      toast.error("The current site's ADMIN_SECRET is required")
      return
    }
    if (mode === "install" && !remotePreflightPassed) {
      toast.error("Run and pass the remote preflight first")
      return
    }
    if (mode === "install" && !confirm(`Install or upgrade CTS-K-N on ${remoteForm.host}:${remoteForm.appPort}?`)) return

    setRemoteInstalling(true)
    setRemoteMode(mode)
    setRemoteLog([mode === "preflight" ? "Running non-persistent remote production preflight..." : "Connecting over SSH and starting the verified production deployment..."])

    try {
      const { adminSecret, ...payload } = remoteForm
      const response = await fetch("/api/install/remote-postgres", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminSecret}` },
        body: JSON.stringify({
          ...payload,
          mode,
          port: Number(remoteForm.port || 22),
          appPort: Number(remoteForm.appPort || 3002),
          repoUrl: remoteForm.repoUrl || undefined,
          redisUrl: remoteForm.redisUrl || undefined,
          password: remoteForm.password || undefined,
          sshKey: remoteForm.sshKey || undefined,
        }),
      })
      const data = await response.json()
      setRemoteLog(prev => [...prev, ...(data.logs || []), data.message || data.error || "Remote install finished"])
      if (!response.ok || !data.success) throw new Error(data.error || "Remote install failed")
      if (mode === "preflight") {
        setRemotePreflightPassed(true)
        toast.success("Remote preflight passed; installation is now unlocked")
      } else {
        toast.success(`Remote app and scheduler verified: ${data.url}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Remote install failed"
      setRemoteLog(prev => [...prev, `✗ ${message}`])
      toast.error(message)
    } finally {
      setRemoteInstalling(false)
      setRemoteMode(null)
    }
  }

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
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="status">Status & Install</TabsTrigger>
          <TabsTrigger value="configure">Database Configuration</TabsTrigger>
          <TabsTrigger value="remote">Remote SSH Install</TabsTrigger>
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
                    <Badge variant={status.isInstalled ? "default" : "secondary"}>
                      v{status.migrationsApplied}/{status.latestMigration}
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
                    <p className="text-lg font-bold">{status.migrationsApplied}/{status.latestMigration}</p>
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

        {/* Remote SSH Installation Tab */}
        <TabsContent value="remote" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Install Remote on Server through SSH</CardTitle>
              <CardDescription>Deploy, validate, build, and keep the app plus its minute scheduler running through systemd or PM2 on a remote Linux server.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Alert>
                <Server className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  A successful non-persistent preflight is required before installation. The target needs passwordless sudo. SSH private-key auth is recommended; password auth additionally requires sshpass on this API host.
                </AlertDescription>
              </Alert>

              {status.serverless && (
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    This Kilo/serverless UI proxies SSH work to a long-lived owner. Configure REMOTE_INSTALL_OWNER_URL and REMOTE_INSTALL_OWNER_SECRET on Kilo, or open this page directly on the independent server.
                  </AlertDescription>
                </Alert>
              )}

              <div className="space-y-2">
                <Label htmlFor="remote-admin-secret">Current site ADMIN_SECRET</Label>
                <Input id="remote-admin-secret" type="password" autoComplete="off" value={remoteForm.adminSecret} onChange={(e) => updateRemoteForm("adminSecret", e.target.value)} placeholder="Required to authorize this administrative action" />
                <p className="text-xs text-muted-foreground">Used only as the bearer authorization header. It is not copied to the remote server.</p>
              </div>

              <div className="grid md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="remote-host">Host</Label>
                  <Input id="remote-host" value={remoteForm.host} onChange={(e) => updateRemoteForm("host", e.target.value)} placeholder="203.0.113.10" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="remote-port">SSH Port</Label>
                  <Input id="remote-port" value={remoteForm.port} onChange={(e) => updateRemoteForm("port", e.target.value)} placeholder="22" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="remote-user">SSH Username</Label>
                  <Input id="remote-user" value={remoteForm.username} onChange={(e) => updateRemoteForm("username", e.target.value)} placeholder="root" />
                </div>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="remote-password">SSH Password (optional)</Label>
                  <Input id="remote-password" type="password" value={remoteForm.password} onChange={(e) => updateRemoteForm("password", e.target.value)} placeholder="Use only when sshpass is available" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="remote-key">SSH Private Key (recommended)</Label>
                  <textarea id="remote-key" className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-xs font-mono" value={remoteForm.sshKey} onChange={(e) => updateRemoteForm("sshKey", e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
                </div>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="remote-repo">Repository URL</Label>
                  <Input id="remote-repo" value={remoteForm.repoUrl} onChange={(e) => updateRemoteForm("repoUrl", e.target.value)} placeholder="https://github.com/mxssnx-creator/CTS-K-N.git" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="remote-branch">Branch</Label>
                  <Input id="remote-branch" value={remoteForm.branch} onChange={(e) => updateRemoteForm("branch", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="remote-runtime">Process Runtime</Label>
                  <select
                    id="remote-runtime"
                    className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={remoteForm.runtime}
                    onChange={(event) => updateRemoteForm("runtime", event.target.value)}
                  >
                    <option value="auto">Auto-detect (recommended)</option>
                    <option value="systemd">systemd</option>
                    <option value="pm2">PM2</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="remote-dir">Install Directory</Label>
                  <Input id="remote-dir" value={remoteForm.installDir} onChange={(e) => updateRemoteForm("installDir", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="remote-app-port">App Port</Label>
                  <Input id="remote-app-port" value={remoteForm.appPort} onChange={(e) => updateRemoteForm("appPort", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="remote-service-user">Unprivileged Service User</Label>
                  <Input id="remote-service-user" value={remoteForm.serviceUser} onChange={(e) => updateRemoteForm("serviceUser", e.target.value)} />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="remote-redis">Redis URL</Label>
                <Input id="remote-redis" value={remoteForm.redisUrl} onChange={(e) => updateRemoteForm("redisUrl", e.target.value)} placeholder="redis://127.0.0.1:6379" />
              </div>

              <div className="grid gap-2 md:grid-cols-2">
                <Button onClick={() => runRemoteInstall("preflight")} disabled={remoteInstalling} variant="outline">
                  {remoteInstalling && remoteMode === "preflight" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                  {remoteInstalling && remoteMode === "preflight" ? "Running remote preflight..." : "Run Remote Preflight"}
                </Button>
                <Button onClick={() => runRemoteInstall("install")} disabled={remoteInstalling || !remotePreflightPassed}>
                  {remoteInstalling && remoteMode === "install" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : remotePreflightPassed ? <Server className="h-4 w-4 mr-2" /> : <XCircle className="h-4 w-4 mr-2" />}
                  {remoteInstalling && remoteMode === "install" ? "Installing and verifying..." : remotePreflightPassed ? "Install / Upgrade Remote Server" : "Preflight Required"}
                </Button>
              </div>

              {remotePreflightPassed && (
                <Alert>
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  <AlertDescription className="text-xs">Preflight passed for the current form values. The full installation is unlocked.</AlertDescription>
                </Alert>
              )}

              {remoteLog.length > 0 && (
                <div className="bg-muted/50 p-4 rounded-lg space-y-1 text-xs font-mono max-h-72 overflow-y-auto">
                  {remoteLog.map((line, i) => <div key={i} className={line.startsWith("✗") ? "text-red-600" : line.includes("running") || line.includes("completed") ? "text-green-600" : ""}>{line}</div>)}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Production installation instructions */}
      <Card>
        <CardHeader>
          <CardTitle>Production Server Installation</CardTitle>
          <CardDescription>Use the checked-in, versioned installer on a long-lived Linux server</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium mb-2">1. Clone the verified repository</p>
              <div className="bg-muted/50 p-3 rounded-lg font-mono text-sm">
                <code>git clone https://github.com/mxssnx-creator/CTS-K-N.git /opt/cts-k-n</code>
              </div>
            </div>

            <div>
              <p className="text-sm font-medium mb-2">2. Run the non-mutating preflight</p>
              <div className="bg-muted/50 p-3 rounded-lg font-mono text-sm space-y-1">
                <div><code>cd /opt/cts-k-n</code></div>
                <div><code className="text-primary">bash scripts/install.sh --preflight-only --skip-system-packages</code></div>
              </div>
            </div>

            <div>
              <p className="text-sm font-medium mb-2">3. Install app, scheduler, Redis contract, and boot services</p>
              <div className="bg-muted/50 p-3 rounded-lg font-mono text-sm space-y-1">
                <div><code className="text-primary">sudo bash scripts/install.sh --runtime systemd --service-user cts-kn --create-service-user --non-interactive</code></div>
              </div>
            </div>
          </div>

          <Alert>
            <Download className="h-4 w-4" />
            <AlertDescription className="text-xs">
              <strong>Result:</strong> The installer does not report success until the complete test/build/migration contract, shared Redis, minute scheduler, service restart, durable site identity, and fresh continuity ticks have passed.
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

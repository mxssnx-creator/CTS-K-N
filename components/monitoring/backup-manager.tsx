"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Database, Play, Square, RefreshCw, Download, Loader2 } from "lucide-react"
import { toast } from "sonner"

interface BackupInfo {
  filename: string
  size: number
  sizeKB: string
  created: string
}

interface BackupStatus {
  running: boolean
  backupPath: string
  backupCount: number
}

export function BackupManager() {
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [backups, setBackups] = useState<BackupInfo[]>([])
  const [intervalHours, setIntervalHours] = useState(6)
  const [isLoading, setIsLoading] = useState(false)
  const [isBackingUp, setIsBackingUp] = useState(false)

  const loadStatus = async () => {
    setIsLoading(true)
    try {
      const response = await fetch("/api/backup/auto")
      if (response.ok) {
        const data = await response.json()
        setStatus(data.status)
        setBackups(data.backups || [])
      }
    } catch (error) {
      console.error("[v0] Failed to load backup status:", error)
    } finally {
      setIsLoading(false)
    }
  }

  const startAutoBackup = async () => {
    try {
      const response = await fetch("/api/backup/auto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", intervalHours }),
      })

      if (response.ok) {
        toast.success(`Auto-backup started (every ${intervalHours} hours)`)
        loadStatus()
      }
    } catch (error) {
      console.error("[v0] Failed to start auto-backup:", error)
      toast.error("Failed to start auto-backup")
    }
  }

  const stopAutoBackup = async () => {
    try {
      const response = await fetch("/api/backup/auto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      })

      if (response.ok) {
        toast.success("Auto-backup stopped")
        loadStatus()
      }
    } catch (error) {
      console.error("[v0] Failed to stop auto-backup:", error)
      toast.error("Failed to stop auto-backup")
    }
  }

  const performManualBackup = async () => {
    setIsBackingUp(true)
    try {
      const response = await fetch("/api/backup/auto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "backup" }),
      })

      const data = await response.json()

      if (data.success) {
        toast.success(`Backup created: ${data.filename}`)
        loadStatus()
      } else {
        throw new Error(data.error)
      }
    } catch (error) {
      console.error("[v0] Failed to create backup:", error)
      toast.error("Backup failed")
    } finally {
      setIsBackingUp(false)
    }
  }

  useEffect(() => {
    loadStatus()
  }, [])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="h-5 w-5" />
          Automatic Backup System
        </CardTitle>
        <CardDescription>
          {status?.running ? (
            <span className="text-green-600 font-semibold">Active - Running automatic backups</span>
          ) : (
            <span className="text-muted-foreground">Configure automatic database backups</span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Control Panel */}
        <div className="space-y-4">
          <div className="flex items-end gap-4">
            <div className="flex-1 space-y-2">
              <Label htmlFor="interval">Backup Interval (hours)</Label>
              <Input
                id="interval"
                type="number"
                value={intervalHours}
                onChange={(e) => setIntervalHours(Number(e.target.value))}
                min={1}
                max={24}
                disabled={status?.running}
              />
            </div>
            <div className="flex gap-2">
              {status?.running ? (
                <Button variant="destructive" onClick={stopAutoBackup}>
                  <Square className="h-4 w-4 mr-2" />
                  Stop Auto-Backup
                </Button>
              ) : (
                <Button onClick={startAutoBackup}>
                  <Play className="h-4 w-4 mr-2" />
                  Start Auto-Backup
                </Button>
              )}
              <Button
                variant="outline"
                onClick={performManualBackup}
                disabled={isBackingUp}
              >
                {isBackingUp ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Backing up...
                  </>
                ) : (
                  <>
                    <Database className="h-4 w-4 mr-2" />
                    Backup Now
                  </>
                )}
              </Button>
            </div>
          </div>

          {status && (
            <div className="grid grid-cols-3 gap-4 p-4 bg-muted rounded-lg">
              <div>
                <p className="text-xs text-muted-foreground">Status</p>
                <Badge variant={status.running ? "default" : "secondary"}>
                  {status.running ? "Running" : "Stopped"}
                </Badge>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Backup Count</p>
                <p className="text-sm font-semibold">{status.backupCount}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Backup Path</p>
                <p className="text-xs font-mono truncate">{status.backupPath}</p>
              </div>
            </div>
          )}
        </div>

        {/* Backup List */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">Recent Backups</h4>
            <Button variant="ghost" size="sm" onClick={loadStatus} disabled={isLoading}>
              <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            </Button>
          </div>

          {backups.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No backups available</p>
          ) : (
            <ScrollArea className="h-[200px]">
              <div className="space-y-2">
                {backups.map((backup) => (
                  <div
                    key={backup.filename}
                    className="flex items-center justify-between p-3 border rounded-lg"
                  >
                    <div className="flex-1">
                      <p className="text-sm font-mono">{backup.filename}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(backup.created).toLocaleString()} • {backup.sizeKB} KB
                      </p>
                    </div>
                    <Button variant="ghost" size="sm">
                      <Download className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

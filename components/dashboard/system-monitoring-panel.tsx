"use client"

import { useState, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Activity } from "lucide-react"

interface CompactMonitor {
  engineCycles: number
  activePositions: number
  cpu: number
  memory: number
  redisKeys: number
  lastUpdate: string
}

const DEFAULT_MONITOR: CompactMonitor = {
  engineCycles: 0,
  activePositions: 0,
  cpu: 0,
  memory: 0,
  redisKeys: 0,
  lastUpdate: "loading…",
}

export function SystemMonitoringPanel() {
  const [data, setData] = useState<CompactMonitor>(DEFAULT_MONITOR)
  const [status, setStatus] = useState<"loading" | "live" | "error">("loading")

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 45000) // Increased from 8s to 45s
    return () => clearInterval(interval)
  }, [])

  const loadData = async () => {
    try {
      const res = await fetch("/api/system/monitoring", { cache: "no-store" })
      if (res.ok) {
        const mon = await res.json()
        setData({
          // Primary: indication cycles (live hash); fallback: strategy cycles
          engineCycles: mon.engines?.indications?.cycleCount || mon.engines?.strategies?.cycleCount || 0,
          activePositions: mon.database?.positions1h || 0,
          cpu: mon.cpu || 0,
          memory: mon.memory || 0,
          redisKeys: mon.database?.keys || 0,
          lastUpdate: new Date().toLocaleTimeString(),
        })
        setStatus("live")
      } else {
        setStatus("error")
      }
    } catch (err) {
      console.error("[Monitor] Error:", err)
      setStatus("error")
    }
  }

  return (
    <Card className="border-primary/10 bg-card/50">
      <CardContent className="p-3">
        <div className="flex items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-0.5">
            <Activity className="w-3 h-3 text-green-500" />
            <span className="text-muted-foreground">Engine</span>
            <span className="font-bold text-blue-600">{data.engineCycles}</span>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">Pos</span>
            <span className="font-bold text-purple-600">{data.activePositions}</span>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">CPU</span>
            <span className={`font-bold ${data.cpu > 80 ? "text-red-600" : data.cpu > 60 ? "text-orange-600" : "text-green-600"}`}>
              {data.cpu}%
            </span>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">Mem</span>
            <span className={`font-bold ${data.memory > 80 ? "text-red-600" : data.memory > 60 ? "text-orange-600" : "text-green-600"}`}>
              {data.memory}%
            </span>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">Redis</span>
            <span className="font-bold text-slate-600">{data.redisKeys}</span>
          </div>

          <Badge variant="outline" className="text-xs h-5">
            {status === "live" ? data.lastUpdate : status === "loading" ? "loading…" : "monitoring unavailable"}
          </Badge>
        </div>
      </CardContent>
    </Card>
  )
}

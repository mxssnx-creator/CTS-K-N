"use client"

import { useState, useEffect, useMemo } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Settings, Zap, Database, Network, Activity, TrendingUp, Wifi, WifiOff } from "lucide-react"
import { useDashboardEvents } from "@/lib/dashboard-events"

interface SystemStats {
  tradeEngines: {
    globalStatus: string
    mainStatus: string
    mainCount?: number
    mainTotal?: number
    mainEnabled?: boolean  // Whether Main Engine is enabled (from main connections)
    liveTradeStatus?: string  // Independent Live Trade status
    liveTradeCount?: number
    liveTradeEnabled?: boolean
    presetStatus: string
    presetCount?: number
    presetTotal?: number
    presetEnabled?: boolean
    totalEnabled: number
  }
  database: {
    status: string
    requestsPerSecond: number
    totalKeys?: number
  }
  exchangeConnections: {
    total: number
    enabled: number
    working: number
    status: string
  }
  activeConnections: {
    total: number
    active: number
    liveTrade: number
    presetTrade: number
  }
  liveTrades: {
    lastHour: number
    topConnections: Array<{ name: string; count: number }>
  }
}

interface PerConnectionInfo {
  id: string
  name: string
  exchange: string
  isEnabled: boolean
  isLiveTrade: boolean
  isPresetTrade: boolean
  phase: string
  progress: number
}

export function SystemOverview() {
  const [perConnectionList, setPerConnectionList] = useState<PerConnectionInfo[]>([])
  const [stats, setStats] = useState<SystemStats>({
    tradeEngines: {
      globalStatus: "idle",
      mainStatus: "idle",
      presetStatus: "idle",
      totalEnabled: 0,
    },
    database: {
      status: "loading",
      requestsPerSecond: 0,
    },
    exchangeConnections: {
      total: 0,
      enabled: 0,
      working: 0,
      status: "loading",
    },
    activeConnections: {
      total: 0,
      active: 0,
      liveTrade: 0,
      presetTrade: 0,
    },
    liveTrades: {
      lastHour: 0,
      topConnections: [],
    },
  })
  const [eventRefreshKey, setEventRefreshKey] = useState(0)
  const dashboardEventHandlers = useMemo(() => ({
    "connection.updated": () => setEventRefreshKey((key) => key + 1),
    "settings.recoordinated": () => setEventRefreshKey((key) => key + 1),
    "engine.stage.changed": () => setEventRefreshKey((key) => key + 1),
    "monitoring.updated": () => setEventRefreshKey((key) => key + 1),
  }), [])
  useDashboardEvents("*", dashboardEventHandlers)


  const toNumber = (value: unknown, fallback = 0): number => {
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string") {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : fallback
    }
    return fallback
  }

  const normalizeSystemStats = (raw: any): SystemStats => ({
    tradeEngines: {
      globalStatus: String(raw?.tradeEngines?.globalStatus || "idle"),
      mainStatus: String(raw?.tradeEngines?.mainStatus || "idle"),
      mainCount: toNumber(raw?.tradeEngines?.mainCount, 0),
      mainTotal: toNumber(raw?.tradeEngines?.mainTotal, 0),
      mainEnabled: raw?.tradeEngines?.mainEnabled === true || raw?.tradeEngines?.mainEnabled === "true",
      liveTradeStatus: String(raw?.tradeEngines?.liveTradeStatus || "idle"),
      liveTradeCount: toNumber(raw?.tradeEngines?.liveTradeCount, 0),
      liveTradeEnabled: raw?.tradeEngines?.liveTradeEnabled === true || raw?.tradeEngines?.liveTradeEnabled === "true",
      presetStatus: String(raw?.tradeEngines?.presetStatus || "idle"),
      presetCount: toNumber(raw?.tradeEngines?.presetCount, 0),
      presetTotal: toNumber(raw?.tradeEngines?.presetTotal, 0),
      presetEnabled: raw?.tradeEngines?.presetEnabled === true || raw?.tradeEngines?.presetEnabled === "true",
      totalEnabled: toNumber(raw?.tradeEngines?.totalEnabled, 0),
    },
    database: {
      status: String(raw?.database?.status || "loading"),
      requestsPerSecond: toNumber(raw?.database?.requestsPerSecond, 0),
      totalKeys: toNumber(raw?.database?.totalKeys, 0),
    },
    exchangeConnections: {
      total: toNumber(raw?.exchangeConnections?.total, 0),
      enabled: toNumber(raw?.exchangeConnections?.enabled, 0),
      working: toNumber(raw?.exchangeConnections?.working, 0),
      status: String(raw?.exchangeConnections?.status || "loading"),
    },
    activeConnections: {
      total: toNumber(raw?.activeConnections?.total, 0),
      active: toNumber(raw?.activeConnections?.active, 0),
      liveTrade: toNumber(raw?.activeConnections?.liveTrade, 0),
      presetTrade: toNumber(raw?.activeConnections?.presetTrade, 0),
    },
    liveTrades: {
      lastHour: toNumber(raw?.liveTrades?.lastHour, 0),
      topConnections: Array.isArray(raw?.liveTrades?.topConnections) ? raw.liveTrades.topConnections : [],
    },
  })


  useEffect(() => {
    const loadPerConnectionInfo = async () => {
      try {
        const res = await fetch("/api/settings/connections?t=" + Date.now(), {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
        })
        if (!res.ok) return
        const data = await res.json()
        const allConns = Array.isArray(data) ? data : (data?.connections || [])
        const toB = (v: unknown) => v === true || v === "1" || v === "true"
        const activeConns: PerConnectionInfo[] = allConns
          .filter((c: any) => toB(c.is_active_inserted) || toB(c.is_dashboard_inserted) || toB(c.is_enabled_dashboard))
          .map((c: any) => ({
            id: c.id,
            name: c.name || c.id,
            exchange: c.exchange || "",
            isEnabled: toB(c.is_enabled_dashboard),
            isLiveTrade: toB(c.is_live_trade),
            isPresetTrade: toB(c.is_preset_trade),
            phase: "idle",
            progress: 0,
          }))
        setPerConnectionList(activeConns)
      } catch { /* non-critical */ }
    }

    const loadStats = async () => {
      try {
        const response = await fetch("/api/main/system-stats-v3", {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" },
        })
        if (response.ok) {
          const data = await response.json()
          setStats(normalizeSystemStats(data))
        }
      } catch {
        // silently ignore stats load errors
      }
    }

    loadStats()
    loadPerConnectionInfo()
    // Listen for connection and live trade toggle events and refresh immediately
    const handleConnectionToggled = () => { loadStats(); loadPerConnectionInfo() }
    const handleLiveTradeToggled = () => { loadStats(); loadPerConnectionInfo() }

    if (typeof window !== 'undefined') {
      window.addEventListener('connection-toggled', handleConnectionToggled)
      window.addEventListener('live-trade-toggled', handleLiveTradeToggled)
      window.addEventListener('connection-settings-updated', handleConnectionToggled)
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('connection-toggled', handleConnectionToggled)
        window.removeEventListener('live-trade-toggled', handleLiveTradeToggled)
        window.removeEventListener('connection-settings-updated', handleConnectionToggled)
      }
    }
  }, [eventRefreshKey])

  const getStatusColor = (status: string) => {
    switch (status) {
      case "running":
      case "healthy":
      case "working":
        return "bg-green-100 text-green-900 border-green-200"
      case "paused":
        return "bg-amber-100 text-amber-900 border-amber-200"
      case "idle":
      case "stopped":
        return "bg-gray-100 text-gray-600 border-gray-200"
      case "failed":
      case "error":
      case "down":
        return "bg-red-100 text-red-900 border-red-200"
      case "loading":
        return "bg-blue-50 text-blue-600 border-blue-200"
      case "partial":
      case "waiting":
      case "ready":
        return "bg-yellow-100 text-yellow-800 border-yellow-200"
      default:
        return "bg-blue-100 text-blue-900 border-blue-200"
    }
  }

  const getBorderColor = (status: string) => {
    switch (status) {
      case "running":
      case "healthy":
      case "working":
        return "border-l-green-500"
      case "paused":
        return "border-l-amber-500"
      case "idle":
      case "stopped":
        return "border-l-gray-400"
      case "failed":
      case "error":
      case "down":
        return "border-l-red-500"
      case "loading":
        return "border-l-blue-400"
      case "partial":
      case "waiting":
      case "ready":
        return "border-l-yellow-500"
      default:
        return "border-l-blue-500"
    }
  }

  return (
    <Card className="mb-6">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-4">
          <Settings className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-bold">Smart Overview</h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
          {/* Trade Engines */}
          <div className={`p-3 rounded-lg border-l-4 ${getBorderColor(stats.tradeEngines.globalStatus)} bg-muted/30`}>
            <div className="flex items-center gap-2 mb-2">
              <Zap className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs font-semibold text-muted-foreground">Trade Engines</span>
            </div>
            {stats.activeConnections.total === 0 && (
              <div className="mb-2 p-2 bg-yellow-50 rounded text-[10px] text-yellow-700 border border-yellow-200">
                💡 Add connections to Active to enable Main/Preset
              </div>
            )}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground" title="Actual running state of trade engine">Global</span>
                <Badge 
                  className={`text-[10px] h-5 ${getStatusColor(stats.tradeEngines.globalStatus)}`}
                  title={`Actual state: ${stats.tradeEngines.globalStatus}`}
                >
                  {stats.tradeEngines.globalStatus}
                </Badge>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground" title="Main Engine: enabled when Main Connections toggle is ON">Main Engine</span>
                <div className="flex items-center gap-2">
                  {(stats.tradeEngines.mainCount !== undefined && stats.tradeEngines.mainTotal !== undefined) && (
                    <span className="text-[10px] text-muted-foreground">
                      {stats.tradeEngines.mainCount}/{stats.tradeEngines.mainTotal}
                    </span>
                  )}
                  <Badge 
                    className={`text-[10px] h-5 ${getStatusColor(stats.tradeEngines.mainStatus)}`}
                    title={`Main Trade Engine: processes indications, strategies, pseudo positions | ${stats.tradeEngines.mainEnabled ? 'Enabled' : 'Disabled'}`}
                  >
                    {stats.tradeEngines.mainStatus}
                  </Badge>
                </div>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground" title="Live Trade: independent - mirrors real exchange positions">Live Trade</span>
                <div className="flex items-center gap-2">
                  {stats.tradeEngines.liveTradeCount !== undefined && (
                    <span className="text-[10px] text-muted-foreground">
                      {stats.tradeEngines.liveTradeCount}
                    </span>
                  )}
                  <Badge 
                    className={`text-[10px] h-5 ${getStatusColor(stats.tradeEngines.liveTradeStatus || 'stopped')}`}
                    title={`Live Trade: independent - mirrors real exchange positions | ${stats.tradeEngines.liveTradeEnabled ? 'Enabled' : 'Disabled'}`}
                  >
                    {stats.tradeEngines.liveTradeStatus}
                  </Badge>
                </div>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground" title="Preset: independent - runs preset strategies">Preset</span>
                <div className="flex items-center gap-2">
                  {(stats.tradeEngines.presetCount !== undefined && stats.tradeEngines.presetTotal !== undefined) && (
                    <span className="text-[10px] text-muted-foreground">
                      {stats.tradeEngines.presetCount}/{stats.tradeEngines.presetTotal}
                    </span>
                  )}
                  <Badge 
                    className={`text-[10px] h-5 ${getStatusColor(stats.tradeEngines.presetStatus)}`}
                    title={`Preset: independent - runs preset strategies | ${stats.tradeEngines.presetEnabled ? 'Enabled' : 'Disabled'}`}
                  >
                    {stats.tradeEngines.presetStatus}
                  </Badge>
                </div>
              </div>
              <div className="pt-1 border-t mt-2">
                <div className="text-2xl font-bold">{stats.tradeEngines.totalEnabled}</div>
                <div className="text-[10px] text-muted-foreground">Enabled</div>
              </div>
            </div>
          </div>

          {/* Database */}
          <div className={`p-3 rounded-lg border-l-4 ${getBorderColor(stats.database.status)} bg-muted/30`}>
            <div className="flex items-center gap-2 mb-2">
              <Database className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs font-semibold text-muted-foreground">Database</span>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Status</span>
                <Badge className={`text-[10px] h-5 ${getStatusColor(stats.database.status)}`}>
                  {stats.database.status}
                </Badge>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Req/sec</span>
                <span className="font-semibold">{stats.database.requestsPerSecond}</span>
              </div>
              <div className="pt-1 border-t">
                <div className="text-2xl font-bold">{stats.database.totalKeys ?? 0}</div>
                <div className="text-[10px] text-muted-foreground">DB Keys</div>
              </div>
            </div>
          </div>

          {/* Base Connections */}
          <div className={`p-3 rounded-lg border-l-4 ${getBorderColor(stats.exchangeConnections.status)} bg-muted/30`}>
            <div className="flex items-center gap-2 mb-2">
              <Network className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs font-semibold text-muted-foreground">Base Connections</span>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Base</span>
                <span className="font-semibold">{stats.exchangeConnections.total}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground" title="Connections with enabled status">Enabled</span>
                <span className={`font-semibold ${stats.exchangeConnections.enabled > 0 ? "text-green-600" : "text-muted-foreground"}`}>
                  {stats.exchangeConnections.enabled}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground" title="Connections where API test passed">Working</span>
                <span className={`font-semibold ${stats.exchangeConnections.working > 0 ? "text-blue-600" : "text-muted-foreground"}`}>
                  {stats.exchangeConnections.working}
                </span>
              </div>
              <div className="pt-1 border-t mt-2">
                <Badge className={`text-[10px] h-5 w-full justify-center ${getStatusColor(stats.exchangeConnections.status)}`}>
                  {stats.exchangeConnections.status}
                </Badge>
              </div>
            </div>
          </div>

          {/* Main Connections — per-connection breakdown */}
          <div className={`p-3 rounded-lg border-l-4 ${stats.activeConnections.active > 0 ? "border-l-green-500" : stats.activeConnections.total > 0 ? "border-l-blue-400" : "border-l-gray-400"} bg-muted/30`}>
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-muted-foreground" />
                <span className="text-xs font-semibold text-muted-foreground">Main Connections</span>
              </div>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {stats.activeConnections.active}/{stats.activeConnections.total} enabled
              </span>
            </div>
            {perConnectionList.length === 0 ? (
              <p className="text-[10px] text-muted-foreground italic">No active connections</p>
            ) : (
              <div className="space-y-1.5">
                {perConnectionList.map((conn) => (
                  <div key={conn.id} className="flex items-center justify-between gap-1">
                    <div className="flex items-center gap-1 min-w-0">
                      {conn.isEnabled ? (
                        <Wifi className="h-3 w-3 text-green-500 shrink-0" />
                      ) : (
                        <WifiOff className="h-3 w-3 text-muted-foreground shrink-0" />
                      )}
                      <span className="text-[11px] font-medium truncate" title={conn.name}>
                        {conn.name}
                      </span>
                      <span className="text-[10px] text-muted-foreground shrink-0 capitalize">
                        ({conn.exchange})
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {conn.isEnabled && (
                        <Badge className="text-[9px] h-4 px-1 bg-green-100 text-green-800 border-green-200">On</Badge>
                      )}
                      {conn.isLiveTrade && (
                        <Badge className="text-[9px] h-4 px-1 bg-blue-100 text-blue-800 border-blue-200">Live</Badge>
                      )}
                      {conn.isPresetTrade && (
                        <Badge className="text-[9px] h-4 px-1 bg-purple-100 text-purple-800 border-purple-200">Preset</Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Live Trades */}
          <div className="p-3 rounded-lg border-l-4 border-l-cyan-500 bg-muted/30">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs font-semibold text-muted-foreground">Live Trades (1h)</span>
            </div>
            <div className="space-y-2">
              <div className="pt-1">
                <div className="text-2xl font-bold">{stats.liveTrades.lastHour}</div>
                <div className="text-[10px] text-muted-foreground">Total Trades</div>
              </div>
              {(stats.liveTrades?.topConnections && Array.isArray(stats.liveTrades.topConnections) && stats.liveTrades.topConnections.length > 0) ? (
                <div className="pt-2 border-t space-y-1">
                  <div className="text-[10px] text-muted-foreground mb-1">Top Contributors:</div>
                  {stats.liveTrades.topConnections.slice(0, 3).map((conn: any, idx: number) => (
                    <div key={idx} className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground truncate">{conn?.name || `Connection ${idx}`}</span>
                      <span className="font-semibold">{conn?.count || 0}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

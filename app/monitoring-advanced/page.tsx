'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Activity, BarChart3, TrendingUp, Zap, Server, AlertCircle, CheckCircle } from 'lucide-react'
import { useExchange } from '@/lib/exchange-context'

interface BroadcasterStats {
  totalConnections: number
  totalClients: number
  connectionStats: Record<string, number>
  historySize: number
}

interface ProcessingMetrics {
  current: any
  summary: string
  timestamp: string
}

interface SystemHealth {
  status: 'healthy' | 'degraded' | 'unhealthy'
  broadcaster: {
    active: boolean
    totalConnections: number
    totalClients: number
  }
  sse: {
    enabled: boolean
    protocol: string
    endpoint: string
    heartbeat: string
  }
}

export default function MonitoringAdvancedPage() {
  const { selectedConnectionId } = useExchange()
  const [broadcasterStats, setBroadcasterStats] = useState<BroadcasterStats | null>(null)
  const [processingMetrics, setProcessingMetrics] = useState<ProcessingMetrics | null>(null)
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true)

        // Fetch broadcaster stats
        try {
          const statsRes = await fetch('/api/broadcast/stats')
          if (statsRes.ok) {
            const data = await statsRes.json()
            setBroadcasterStats(data.data)
          }
        } catch (error) {
          console.error('Failed to fetch broadcaster stats:', error)
        }

        // Fetch processing metrics
        if (selectedConnectionId && selectedConnectionId !== 'demo-mode') {
          try {
            const metricsRes = await fetch(`/api/metrics/processing?connectionId=${encodeURIComponent(selectedConnectionId)}`)
            if (metricsRes.ok) {
              const data = await metricsRes.json()
              setProcessingMetrics(data.data)
            }
          } catch (error) {
            console.error('Failed to fetch processing metrics:', error)
          }
        }

        // Fetch system health
        try {
          const healthRes = await fetch('/api/broadcast/health')
          if (healthRes.ok) {
            const data = await healthRes.json()
            setSystemHealth(data.data)
          }
        } catch (error) {
          console.error('Failed to fetch system health:', error)
        }
      } finally {
        setLoading(false)
      }
    }

    fetchData()
    const interval = setInterval(fetchData, 5000)

    return () => clearInterval(interval)
  }, [selectedConnectionId])

  if (loading) {
    return (
      <div className="p-6">
        <h1 className="text-3xl font-bold mb-4">Advanced Monitoring</h1>
        <Card className="bg-white border-border">
          <CardContent className="p-6 text-muted-foreground">Loading monitoring data...</CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold mb-1">Advanced Monitoring Dashboard</h1>
        <p className="text-muted-foreground">Real-time system health and performance metrics</p>
      </div>

      {/* System Status Overview */}
      {systemHealth && (
        <Card className="bg-gradient-to-br from-slate-900 to-slate-800 border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-slate-600 flex items-center gap-2">
              <Server className="w-4 h-4" />
              System Health
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Overall Status</span>
              <Badge
                className={`${
                  systemHealth.status === 'healthy'
                    ? 'bg-green-900 text-green-200'
                    : systemHealth.status === 'degraded'
                      ? 'bg-yellow-900 text-yellow-200'
                      : 'bg-red-900 text-red-200'
                }`}
              >
                {systemHealth.status.toUpperCase()}
              </Badge>
            </div>

            <div className="grid grid-cols-3 gap-4 pt-2">
              <div>
                <div className="text-xs text-muted-foreground mb-1">SSE Status</div>
                <div className="flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-green-400" />
                  <span className="text-sm text-slate-600">{systemHealth.sse.enabled ? 'Enabled' : 'Disabled'}</span>
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Broadcaster</div>
                <div className="flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-green-400" />
                  <span className="text-sm text-slate-600">{systemHealth.broadcaster.active ? 'Active' : 'Inactive'}</span>
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Protocol</div>
                <span className="text-sm text-slate-600">{systemHealth.sse.protocol}</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 pt-3 border-t border-border">
              <div>
                <div className="text-xs text-muted-foreground mb-1">Active Connections</div>
                <div className="text-2xl font-bold text-blue-400">{systemHealth.broadcaster.totalConnections}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Connected Clients</div>
                <div className="text-2xl font-bold text-green-400">{systemHealth.broadcaster.totalClients}</div>
              </div>
            </div>

            <div className="text-xs text-muted-foreground pt-2">
              Heartbeat interval: {systemHealth.sse.heartbeat}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Broadcaster Statistics */}
      {broadcasterStats && (
        <Card className="bg-gradient-to-br from-slate-900 to-slate-800 border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-slate-600 flex items-center gap-2">
              <Activity className="w-4 h-4" />
              Broadcaster Statistics
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-slate-100/50 p-3 rounded">
                <div className="text-xs text-muted-foreground mb-1">Total Connections</div>
                <div className="text-2xl font-bold text-blue-400">{broadcasterStats.totalConnections}</div>
              </div>
              <div className="bg-slate-100/50 p-3 rounded">
                <div className="text-xs text-muted-foreground mb-1">Total Clients</div>
                <div className="text-2xl font-bold text-green-400">{broadcasterStats.totalClients}</div>
              </div>
              <div className="bg-slate-100/50 p-3 rounded">
                <div className="text-xs text-muted-foreground mb-1">Message History</div>
                <div className="text-2xl font-bold text-purple-400">{broadcasterStats.historySize}</div>
              </div>
              <div className="bg-slate-100/50 p-3 rounded">
                <div className="text-xs text-muted-foreground mb-1">Avg Clients/Conn</div>
                <div className="text-2xl font-bold text-yellow-400">
                  {(broadcasterStats.totalClients / Math.max(broadcasterStats.totalConnections, 1)).toFixed(1)}
                </div>
              </div>
            </div>

            {Object.entries(broadcasterStats.connectionStats).length > 0 && (
              <div className="pt-3 border-t border-border">
                <div className="text-xs text-muted-foreground mb-2 font-medium">Connections</div>
                <div className="space-y-1">
                  {Object.entries(broadcasterStats.connectionStats).map(([conn, clients]) => (
                    <div key={conn} className="flex justify-between text-xs">
                      <span className="text-slate-600">{conn}</span>
                      <Badge variant="outline" className="bg-slate-100 text-slate-700">
                        {clients} clients
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Processing Metrics */}
      {processingMetrics && (
        <Tabs defaultValue="phases" className="space-y-4">
          <TabsList className="bg-slate-50 border-border">
            <TabsTrigger value="phases">Phases</TabsTrigger>
            <TabsTrigger value="metrics">Metrics</TabsTrigger>
            <TabsTrigger value="evaluations">Evaluations</TabsTrigger>
          </TabsList>

          <TabsContent value="phases">
            <Card className="bg-gradient-to-br from-slate-900 to-slate-800 border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-slate-600">Processing Phases</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {['prehistoric', 'realtime', 'indication', 'strategy'].map((phase) => {
                  const phaseData = processingMetrics.current?.phases?.[phase as keyof typeof processingMetrics.current.phases]
                  if (!phaseData) return null

                  return (
                    <div key={phase} className="bg-slate-100/30 p-3 rounded space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-slate-700 capitalize">{phase}</span>
                        <Badge
                          className={`${
                            phaseData.status === 'completed'
                              ? 'bg-green-900 text-green-200'
                              : phaseData.status === 'running'
                                ? 'bg-blue-900 text-blue-200'
                                : phaseData.status === 'error'
                                  ? 'bg-red-900 text-red-200'
                                  : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {phaseData.status}
                        </Badge>
                      </div>

                      <div className="w-full bg-slate-100 rounded h-2 overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-blue-500 to-purple-500"
                          style={{ width: `${Math.min(phaseData.progress, 100)}%` }}
                        />
                      </div>

                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>
                          {phaseData.itemsProcessed} / {phaseData.itemsTotal}
                        </span>
                        <span>{Math.round(phaseData.progress)}%</span>
                      </div>

                      <div className="text-xs text-muted-foreground">
                        Cycles: {phaseData.cycleCount} | Duration: {(phaseData.duration / 1000).toFixed(1)}s
                      </div>
                    </div>
                  )
                })}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="metrics">
            <Card className="bg-gradient-to-br from-slate-900 to-slate-800 border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-slate-600">Performance Metrics</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  <div className="bg-slate-100/50 p-3 rounded">
                    <div className="text-xs text-muted-foreground mb-1">Avg Cycle Duration</div>
                    <div className="text-xl font-bold text-blue-400">
                      {processingMetrics.current?.performanceMetrics?.avgCycleDuration?.toFixed(0) || 0}ms
                    </div>
                  </div>
                  <div className="bg-slate-100/50 p-3 rounded">
                    <div className="text-xs text-muted-foreground mb-1">Total Processing Time</div>
                    <div className="text-xl font-bold text-green-400">
                      {((processingMetrics.current?.performanceMetrics?.totalProcessingTime || 0) / 1000).toFixed(1)}s
                    </div>
                  </div>
                  <div className="bg-slate-100/50 p-3 rounded">
                    <div className="text-xs text-muted-foreground mb-1">Active Positions</div>
                    <div className="text-xl font-bold text-yellow-400">
                      {processingMetrics.current?.pseudoPositions?.currentActive || 0}
                    </div>
                  </div>
                </div>

                <div className="pt-3 border-t border-border grid grid-cols-2 gap-4 text-xs">
                  <div>
                    <span className="text-muted-foreground">Positions Created:</span>
                    <div className="text-slate-700 font-medium">
                      {processingMetrics.current?.pseudoPositions?.totalCreated || 0}
                    </div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Positions Evaluated:</span>
                    <div className="text-slate-700 font-medium">
                      {processingMetrics.current?.pseudoPositions?.totalEvaluated || 0}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="evaluations">
            <Card className="bg-gradient-to-br from-slate-900 to-slate-800 border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-slate-600">Evaluation Counts</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {Object.entries(processingMetrics.current?.evaluationCounts || {})
                    .filter(([_, count]) => (count as number) > 0)
                    .map(([type, count]) => (
                      <div key={type} className="flex justify-between items-center p-2 bg-slate-100/30 rounded">
                        <span className="text-sm text-slate-600 capitalize">{type}</span>
                        <Badge variant="outline" className="bg-slate-100 text-slate-700">
                          {count as number}
                        </Badge>
                      </div>
                    ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}

      {/* Last Updated */}
      <div className="text-xs text-muted-foreground text-center">
        Last updated: {new Date().toLocaleTimeString()}
      </div>
    </div>
  )
}

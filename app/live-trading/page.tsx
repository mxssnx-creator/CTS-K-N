"use client"

export const dynamic = "force-dynamic"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Activity,
  AlertTriangle,
  DatabaseZap,
  Loader2,
  RefreshCw,
  ServerCog,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { LiveOverviewCompact } from "@/components/live-trading/live-overview-compact"
import { LivePositionTable } from "@/components/live-trading/live-position-table"
import { TradeHistoryPanel } from "@/components/live-trading/trade-history-panel"
import type {
  LiveAccountSummary,
  LivePositionResponse,
  LivePositionView,
  LiveSummaryResponse,
  ProtectionUpdate,
  TradeHistoryResponse,
} from "@/components/live-trading/live-trading-types"
import type { TradeHistoryRow } from "@/lib/trade-history"
import { useExchange } from "@/lib/exchange-context"
import { usePositionUpdates } from "@/lib/use-websocket"
import { toast } from "@/lib/simple-toast"

const OPEN_STATUSES = new Set([
  "open",
  "filled",
  "partially_filled",
  "placed",
  "pending",
  "pending_fill",
  "placed_unconfirmed",
  "closing",
  "closing_partial",
  "simulated",
])

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const isMutation = Boolean(init?.method && init.method.toUpperCase() !== "GET")
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
    headers: { "Cache-Control": "no-cache", ...(init?.headers || {}) },
    signal: init?.signal ?? AbortSignal.timeout(isMutation ? 30_000 : 15_000),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(body?.error || body?.message || `${response.status} ${response.statusText}`)
  }
  return body as T
}

function filterOpenPositions(positions: LivePositionView[]): LivePositionView[] {
  return positions.filter((position) => OPEN_STATUSES.has(String(position.status || "open").toLowerCase()))
}

export default function LiveTradingPage() {
  const { selectedConnectionId, selectedConnection, isLoading: connectionsLoading } = useExchange()
  const [positions, setPositions] = useState<LivePositionView[]>([])
  const [historyRows, setHistoryRows] = useState<TradeHistoryRow[]>([])
  const [historyResponse, setHistoryResponse] = useState<TradeHistoryResponse | null>(null)
  const [positionResponse, setPositionResponse] = useState<LivePositionResponse | null>(null)
  const [account, setAccount] = useState<LiveAccountSummary | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const generationRef = useRef(0)
  const busyRef = useRef<string | null>(null)
  const positionRefreshTimerRef = useRef<number | null>(null)
  const loadRef = useRef<(options?: { silent?: boolean; forceHistory?: boolean; positionsOnly?: boolean }) => Promise<void>>(async () => undefined)

  const loadDashboard = useCallback(async (options?: {
    silent?: boolean
    forceHistory?: boolean
    positionsOnly?: boolean
  }) => {
    const connectionId = selectedConnectionId
    const generation = ++generationRef.current
    if (!connectionId) {
      setPositions([])
      setHistoryRows([])
      setHistoryResponse(null)
      setPositionResponse(null)
      setAccount(null)
      setLoadError(null)
      setIsLoading(false)
      setIsRefreshing(false)
      return
    }

    if (!options?.silent) {
      if (lastUpdated === null) setIsLoading(true)
      else setIsRefreshing(true)
    }

    const encoded = encodeURIComponent(connectionId)
    const tasks: Array<Promise<{ kind: "positions" | "history" | "summary"; value: unknown }>> = [
      fetchJson<LivePositionResponse>(`/api/trading/live-positions?connection_id=${encoded}&closedLimit=1`)
        .then((value) => ({ kind: "positions" as const, value })),
    ]
    if (!options?.positionsOnly) {
      tasks.push(
        fetchJson<TradeHistoryResponse>(`/api/trading/trade-history?connection_id=${encoded}&limit=500${options?.forceHistory ? "&force=1" : ""}`)
          .then((value) => ({ kind: "history" as const, value })),
        fetchJson<LiveSummaryResponse>(`/api/exchange/live-summary?connection_id=${encoded}`)
          .then((value) => ({ kind: "summary" as const, value })),
      )
    }

    const results = await Promise.allSettled(tasks)
    if (generation !== generationRef.current) return

    const errors: string[] = []
    for (const result of results) {
      if (result.status === "rejected") {
        errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason))
        continue
      }
      if (result.value.kind === "positions") {
        const value = result.value.value as LivePositionResponse
        setPositionResponse(value)
        setPositions(filterOpenPositions(Array.isArray(value.positions) ? value.positions : []))
      } else if (result.value.kind === "history") {
        const value = result.value.value as TradeHistoryResponse
        if (value.success === false) errors.push("Trade history returned an error")
        else {
          setHistoryResponse(value)
          setHistoryRows(Array.isArray(value.rows) ? value.rows : [])
        }
      } else {
        const value = result.value.value as LiveSummaryResponse
        const selected = Array.isArray(value.connections)
          ? value.connections.find((entry) => String(entry.connectionId) === connectionId) || null
          : null
        setAccount(selected)
      }
    }

    setLoadError(errors.length > 0 ? [...new Set(errors)].join(" · ") : null)
    if (results.some((result) => result.status === "fulfilled")) setLastUpdated(Date.now())
    setIsLoading(false)
    setIsRefreshing(false)
  }, [lastUpdated, selectedConnectionId])

  useEffect(() => {
    loadRef.current = loadDashboard
  }, [loadDashboard])

  useEffect(() => {
    generationRef.current++
    setPositions([])
    setHistoryRows([])
    setHistoryResponse(null)
    setPositionResponse(null)
    setAccount(null)
    setLastUpdated(null)
    setLoadError(null)
    setIsRefreshing(false)
    setIsLoading(Boolean(selectedConnectionId))
    void loadRef.current()
  }, [selectedConnectionId])

  useEffect(() => {
    if (!selectedConnectionId) return
    const interval = window.setInterval(() => {
      void loadRef.current({ silent: true })
    }, 10_000)
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void loadRef.current({ silent: true })
    }
    window.addEventListener("focus", refreshVisible)
    document.addEventListener("visibilitychange", refreshVisible)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener("focus", refreshVisible)
      document.removeEventListener("visibilitychange", refreshVisible)
    }
  }, [selectedConnectionId])

  const handlePositionUpdate = useCallback(() => {
    if (positionRefreshTimerRef.current !== null) return
    positionRefreshTimerRef.current = window.setTimeout(() => {
      positionRefreshTimerRef.current = null
      void loadRef.current({ silent: true, positionsOnly: true })
    }, 250)
  }, [])
  usePositionUpdates(selectedConnectionId || "", handlePositionUpdate)

  useEffect(() => () => {
    if (positionRefreshTimerRef.current !== null) {
      window.clearTimeout(positionRefreshTimerRef.current)
      positionRefreshTimerRef.current = null
    }
  }, [selectedConnectionId])

  const closePosition = useCallback(async (position: LivePositionView) => {
    if (!selectedConnectionId || busyRef.current) return
    busyRef.current = position.id
    setBusyId(position.id)
    try {
      const body = await fetchJson<{ success: boolean; state?: string; message?: string }>(
        `/api/trading/live-positions/${encodeURIComponent(position.id)}?connectionId=${encodeURIComponent(selectedConnectionId)}`,
        { method: "DELETE" },
      )
      if (!body.success) throw new Error(body.message || "Position close was not accepted")
      if (body.state === "closing" || body.state === "closing_partial") {
        toast.info(body.message || "Close accepted; exchange reconciliation continues")
      } else {
        toast.success(body.message || "Position closed")
      }
      await loadDashboard({ silent: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to close position"
      toast.error(message)
      throw error
    } finally {
      busyRef.current = null
      setBusyId(null)
    }
  }, [loadDashboard, selectedConnectionId])

  const updateProtection = useCallback(async (position: LivePositionView, update: ProtectionUpdate) => {
    if (!selectedConnectionId || busyRef.current) return
    busyRef.current = position.id
    setBusyId(position.id)
    try {
      const body = await fetchJson<{ success: boolean; state?: string; message?: string }>(
        `/api/trading/live-positions/${encodeURIComponent(position.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionId: selectedConnectionId, ...update }),
        },
      )
      if (!body.success) throw new Error(body.message || "Protection update was not accepted")
      if (body.state === "queued") toast.info(body.message || "Protection queued for reconciliation")
      else toast.success(body.message || "Protection updated")
      await loadDashboard({ silent: true, positionsOnly: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update protection"
      toast.error(message)
      throw error
    } finally {
      busyRef.current = null
      setBusyId(null)
    }
  }, [loadDashboard, selectedConnectionId])

  const restoreProtection = useCallback(async (position: LivePositionView) => {
    if (!selectedConnectionId || busyRef.current) return
    busyRef.current = position.id
    setBusyId(position.id)
    try {
      const body = await fetchJson<{ success: boolean; state?: string; message?: string }>(
        `/api/trading/live-positions/${encodeURIComponent(position.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionId: selectedConnectionId, action: "restore_strategy" }),
        },
      )
      if (!body.success) throw new Error(body.message || "Strategy protection was not restored")
      toast.success(body.message || "Strategy protection restored")
      await loadDashboard({ silent: true, positionsOnly: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to restore strategy protection"
      toast.error(message)
      throw error
    } finally {
      busyRef.current = null
      setBusyId(null)
    }
  }, [loadDashboard, selectedConnectionId])

  const integrity = positionResponse?.dataIntegrity
  const liveReady = integrity?.liveTradeEnabled === true
  const liveRequestedButBlocked = integrity?.liveTradeRequested === true && !liveReady

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Live Trading"
        description="Exchange positions, protection controls and execution history"
        showExchangeSelector
      >
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          disabled={!selectedConnectionId || isRefreshing}
          onClick={() => void loadDashboard({ forceHistory: true })}
        >
          {isRefreshing ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 size-3.5" />}
          Refresh
        </Button>
      </PageHeader>

      <main className="space-y-2.5 p-3 sm:p-4">
        {!selectedConnectionId ? (
          <Card className="border-dashed">
            <CardContent className="flex min-h-48 flex-col items-center justify-center gap-2 text-center">
              {connectionsLoading ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : <ServerCog className="size-6 text-muted-foreground" />}
              <div className="text-sm font-medium">Select an active connection</div>
              <p className="max-w-md text-xs text-muted-foreground">The Live Trading page never substitutes mock positions for an unselected production connection.</p>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2.5 py-1.5 text-[10px] ${liveReady ? "border-emerald-500/30 bg-emerald-500/5" : liveRequestedButBlocked ? "border-rose-500/30 bg-rose-500/5" : "bg-muted/20"}`}>
              {liveReady ? <ShieldCheck className="size-3.5 text-emerald-500" /> : liveRequestedButBlocked ? <ShieldAlert className="size-3.5 text-rose-500" /> : <Activity className="size-3.5 text-muted-foreground" />}
              <span className="font-semibold">{selectedConnection?.name || selectedConnectionId}</span>
              <Badge variant="outline" className="h-4 px-1 text-[8px] uppercase">{integrity?.liveExecutionMode || (liveReady ? "live" : "inactive")}</Badge>
              <span className="text-muted-foreground">{integrity?.message || "Canonical Redis position state is active."}</span>
              <span className="ml-auto flex items-center gap-1 text-muted-foreground">
                <DatabaseZap className="size-3" />
                {lastUpdated ? `Updated ${new Date(lastUpdated).toLocaleTimeString()}` : "Loading canonical state"}
              </span>
            </div>

            {loadError ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[10px] text-amber-800 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span><strong>Partial refresh:</strong> {loadError}. Existing data remains visible and the next event/poll retries automatically.</span>
              </div>
            ) : null}

            {isLoading ? (
              <div className="grid min-h-64 place-items-center rounded-md border bg-card">
                <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading live exchange state…</div>
              </div>
            ) : (
              <>
                <LiveOverviewCompact account={account} positions={positions} analytics={historyResponse?.analytics || null} />
                <LivePositionTable
                  positions={positions}
                  busyId={busyId}
                  onClose={closePosition}
                  onUpdateProtection={updateProtection}
                  onRestoreProtection={restoreProtection}
                />
                <TradeHistoryPanel rows={historyRows} response={historyResponse} />
              </>
            )}
          </>
        )}
      </main>
    </div>
  )
}

"use client"

import { useState, useMemo, useCallback, useEffect, useRef } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  History,
  ArrowUp,
  ArrowDown,
  TrendingUp,
  TrendingDown,
  Filter,
  RotateCw,
} from "lucide-react"
import type { TradeHistoryRow as TradeHistoryRowType } from "@/lib/trade-history"

export type TradeHistoryRow = TradeHistoryRowType

interface TradeHistoryTableProps {
  trades: TradeHistoryRow[]
  /** Hard payload/render cap; the API and UI never retain more than 500. */
  limit?: number
  /** Constant DOM window used by the virtual scroller. */
  visibleWindow?: number
  onRefresh?: () => void | Promise<void>
}

type SortField =
  | "closedAt"
  | "realizedPnl"
  | "pnlPct"
  | "symbol"
  | "holdMinutes"
  | "volumeUsd"
  | "entryPrice"
  | "exitPrice"
  | "fees"
  | "direction"
type SortDir = "asc" | "desc"

const ROW_HEIGHT = 44
const DEFAULT_WINDOW = 50
const MAX_RECORDS = 500
const GRID_COLUMNS = "140px 100px 70px 110px 110px 100px 80px 100px 80px 80px"

function finite(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function money(value: number, digits = 2): string {
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`
}

export function TradeHistoryTable({
  trades,
  limit = MAX_RECORDS,
  visibleWindow = DEFAULT_WINDOW,
  onRefresh,
}: TradeHistoryTableProps) {
  const hardLimit = Math.max(1, Math.min(MAX_RECORDS, Math.floor(limit) || MAX_RECORDS))
  const windowSize = Math.max(1, Math.min(DEFAULT_WINDOW, Math.floor(visibleWindow) || DEFAULT_WINDOW))
  const [sortField, setSortField] = useState<SortField>("closedAt")
  const [sortDir, setSortDir] = useState<SortDir>("desc")
  const [search, setSearch] = useState("")
  const [directionFilter, setDirectionFilter] = useState<"all" | "long" | "short">("all")
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [windowStart, setWindowStart] = useState(0)
  const viewportRef = useRef<HTMLDivElement | null>(null)

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir((direction) => (direction === "asc" ? "desc" : "asc"))
    else {
      setSortField(field)
      setSortDir(field === "symbol" || field === "direction" ? "asc" : "desc")
    }
  }

  const handleRefresh = useCallback(async () => {
    if (!onRefresh || isRefreshing) return
    setIsRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setIsRefreshing(false)
    }
  }, [isRefreshing, onRefresh])

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUp className="ml-1 inline h-3 w-3 opacity-25" />
    return sortDir === "asc"
      ? <ArrowUp className="ml-1 inline h-3 w-3" />
      : <ArrowDown className="ml-1 inline h-3 w-3" />
  }

  // Dedupe before applying the 500-row bound. Exchange close-order id is the
  // strongest identity; local id is the fallback. Keep the newest copy.
  const cappedTrades = useMemo(() => {
    const byId = new Map<string, TradeHistoryRow>()
    const anonymous: TradeHistoryRow[] = []
    for (const trade of trades) {
      if (!trade || !trade.symbol) continue
      const key = trade.closeOrderId
        ? `close:${trade.closeOrderId}`
        : trade.id
          ? `id:${trade.id}`
          : ""
      if (!key) {
        anonymous.push(trade)
        continue
      }
      const existing = byId.get(key)
      if (!existing || finite(trade.closedAt) >= finite(existing.closedAt)) byId.set(key, trade)
    }
    return [...byId.values(), ...anonymous]
      .sort((a, b) => finite(b.closedAt) - finite(a.closedAt))
      .slice(0, hardLimit)
  }, [hardLimit, trades])

  const filtered = useMemo(() => {
    let list = [...cappedTrades]
    if (directionFilter !== "all") list = list.filter((trade) => trade.direction === directionFilter)
    const query = search.trim().toUpperCase()
    if (query) {
      list = list.filter((trade) =>
        trade.symbol.toUpperCase().includes(query) ||
        trade.id.toUpperCase().includes(query) ||
        String(trade.orderId || "").toUpperCase().includes(query) ||
        String(trade.closeOrderId || "").toUpperCase().includes(query),
      )
    }

    list.sort((a, b) => {
      let comparison = 0
      if (sortField === "symbol" || sortField === "direction") {
        comparison = String(a[sortField]).localeCompare(String(b[sortField]))
      } else {
        comparison = finite(a[sortField]) - finite(b[sortField])
      }
      return sortDir === "asc" ? comparison : -comparison
    })
    return list
  }, [cappedTrades, directionFilter, search, sortDir, sortField])

  const summary = useMemo(() => {
    let wins = 0
    let losses = 0
    let flat = 0
    let netPnl = 0
    let fees = 0
    let volume = 0
    for (const trade of cappedTrades) {
      const pnl = finite(trade.realizedPnl)
      if (pnl > 0) wins++
      else if (pnl < 0) losses++
      else flat++
      netPnl += pnl
      fees += Math.abs(finite(trade.fees))
      volume += finite(trade.volumeUsd)
    }
    const decided = wins + losses
    return {
      wins,
      losses,
      flat,
      netPnl,
      fees,
      volume,
      winRate: decided > 0 ? (wins / decided) * 100 : 0,
    }
  }, [cappedTrades])

  useEffect(() => {
    setWindowStart(0)
    if (viewportRef.current) viewportRef.current.scrollTop = 0
  }, [directionFilter, search, sortDir, sortField, cappedTrades.length])

  const maximumStart = Math.max(0, filtered.length - windowSize)
  const safeWindowStart = Math.min(windowStart, maximumStart)
  const visibleTrades = filtered.slice(safeWindowStart, safeWindowStart + windowSize)
  const topSpacer = safeWindowStart * ROW_HEIGHT
  const bottomSpacer = Math.max(0, (filtered.length - safeWindowStart - visibleTrades.length) * ROW_HEIGHT)

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const next = Math.min(
      Math.max(0, filtered.length - windowSize),
      Math.max(0, Math.floor(event.currentTarget.scrollTop / ROW_HEIGHT)),
    )
    setWindowStart((previous) => previous === next ? previous : next)
  }, [filtered.length, windowSize])

  const fmtTime = (timestamp: number) => timestamp > 0
    ? new Date(timestamp).toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—"

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <CardHeader className="space-y-3 border-b pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm font-semibold">Trade History</CardTitle>
            <Badge variant="outline" className="h-5 text-[10px] font-normal">
              {cappedTrades.length}/{MAX_RECORDS}
            </Badge>
            <Badge variant="secondary" className="h-5 text-[9px] font-normal">
              {windowSize}-row window
            </Badge>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={handleRefresh}
            disabled={!onRefresh || isRefreshing}
            aria-label="Refresh exchange trade history"
          >
            <RotateCw className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <div className="rounded-md border bg-muted/20 px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Won</div>
            <div className="text-sm font-semibold tabular-nums text-emerald-600">{summary.wins}</div>
          </div>
          <div className="rounded-md border bg-muted/20 px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Lost</div>
            <div className="text-sm font-semibold tabular-nums text-rose-600">{summary.losses}</div>
          </div>
          <div className="rounded-md border bg-muted/20 px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Win rate</div>
            <div className="text-sm font-semibold tabular-nums">{summary.winRate.toFixed(1)}%</div>
          </div>
          <div className="rounded-md border bg-muted/20 px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Net PnL</div>
            <div className={`text-sm font-semibold tabular-nums ${summary.netPnl >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
              {summary.netPnl >= 0 ? "+" : ""}{money(summary.netPnl)}
            </div>
          </div>
          <div className="rounded-md border bg-muted/20 px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Fees</div>
            <div className="text-sm font-semibold tabular-nums">{money(summary.fees)}</div>
          </div>
          <div className="rounded-md border bg-muted/20 px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Volume</div>
            <div className="text-sm font-semibold tabular-nums">{money(summary.volume, 0)}</div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
            <Input
              placeholder="Symbol or order ID…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-7 pl-7 text-xs"
            />
            <Filter className="absolute left-2 top-1.5 h-3 w-3 text-muted-foreground" />
          </div>
          <div className="flex gap-1">
            {(["all", "long", "short"] as const).map((direction) => (
              <Button
                key={direction}
                size="sm"
                variant={directionFilter === direction ? "default" : "outline"}
                className="h-7 text-[10px] font-medium"
                onClick={() => setDirectionFilter(direction)}
              >
                {direction === "all" ? "All" : direction.toUpperCase()}
              </Button>
            ))}
          </div>
          <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
            {filtered.length === 0
              ? "0 records"
              : `${safeWindowStart + 1}–${safeWindowStart + visibleTrades.length} of ${filtered.length}`}
            {summary.flat > 0 ? ` · ${summary.flat} flat` : ""}
          </span>
        </div>
      </CardHeader>

      <CardContent className="flex-1 overflow-hidden p-0">
        {filtered.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center text-muted-foreground">
            <History className="mb-2 h-6 w-6 opacity-30" />
            <p className="text-xs">No closed exchange trades yet</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[1000px]">
              <div
                className="grid h-9 items-center border-b bg-muted/30 px-3 text-[10px] font-medium text-muted-foreground"
                style={{ gridTemplateColumns: GRID_COLUMNS }}
              >
                <button className="text-left hover:text-foreground" onClick={() => handleSort("closedAt")}>Closed <SortIcon field="closedAt" /></button>
                <button className="text-left hover:text-foreground" onClick={() => handleSort("symbol")}>Symbol <SortIcon field="symbol" /></button>
                <button className="text-left hover:text-foreground" onClick={() => handleSort("direction")}>Side <SortIcon field="direction" /></button>
                <button className="text-right hover:text-foreground" onClick={() => handleSort("entryPrice")}>Entry <SortIcon field="entryPrice" /></button>
                <button className="text-right hover:text-foreground" onClick={() => handleSort("exitPrice")}>Exit <SortIcon field="exitPrice" /></button>
                <button className="text-right hover:text-foreground" onClick={() => handleSort("volumeUsd")}>Volume <SortIcon field="volumeUsd" /></button>
                <button className="text-right hover:text-foreground" onClick={() => handleSort("fees")}>Fee <SortIcon field="fees" /></button>
                <button className="text-right hover:text-foreground" onClick={() => handleSort("realizedPnl")}>Net PnL <SortIcon field="realizedPnl" /></button>
                <button className="text-right hover:text-foreground" onClick={() => handleSort("pnlPct")}>PnL % <SortIcon field="pnlPct" /></button>
                <span className="text-right">Source</span>
              </div>

              <div
                ref={viewportRef}
                className="h-[560px] overflow-y-auto overscroll-contain"
                onScroll={handleScroll}
              >
                <div style={{ height: topSpacer }} aria-hidden="true" />
                {visibleTrades.map((trade, index) => {
                  const pnl = finite(trade.realizedPnl)
                  const isWin = pnl > 0
                  const isLoss = pnl < 0
                  return (
                    <div
                      key={`${trade.closeOrderId || trade.id || "trade"}:${safeWindowStart + index}`}
                      className="grid h-11 items-center border-b border-border/40 px-3 text-[10px] transition-colors hover:bg-muted/40"
                      style={{ gridTemplateColumns: GRID_COLUMNS }}
                      title={`ID: ${trade.id}${trade.closeOrderId ? ` · Close order: ${trade.closeOrderId}` : ""}`}
                    >
                      <div className="whitespace-nowrap text-muted-foreground">{fmtTime(finite(trade.closedAt))}</div>
                      <div className="truncate font-semibold">{trade.symbol}</div>
                      <div>
                        <Badge variant={trade.direction === "long" ? "default" : "secondary"} className="h-4 px-1.5 text-[9px]">
                          {trade.direction === "long"
                            ? <TrendingUp className="mr-0.5 h-2.5 w-2.5" />
                            : <TrendingDown className="mr-0.5 h-2.5 w-2.5" />}
                          {trade.direction === "long" ? "L" : "S"}
                        </Badge>
                      </div>
                      <div className="text-right font-mono text-muted-foreground">{trade.entryPrice > 0 ? money(trade.entryPrice, trade.entryPrice < 10 ? 4 : 2) : "—"}</div>
                      <div className="text-right font-mono text-muted-foreground">{trade.exitPrice > 0 ? money(trade.exitPrice, trade.exitPrice < 10 ? 4 : 2) : "—"}</div>
                      <div className="text-right font-mono">{money(finite(trade.volumeUsd), 2)}</div>
                      <div className="text-right font-mono text-amber-600">{money(Math.abs(finite(trade.fees)), 4)}</div>
                      <div className={`text-right font-mono font-semibold ${isWin ? "text-emerald-600" : isLoss ? "text-rose-600" : "text-muted-foreground"}`}>
                        {pnl > 0 ? "+" : ""}{money(pnl, 2)}
                      </div>
                      <div className={`text-right font-mono ${isWin ? "text-emerald-600" : isLoss ? "text-rose-600" : "text-muted-foreground"}`}>
                        {finite(trade.pnlPct) > 0 ? "+" : ""}{finite(trade.pnlPct).toFixed(2)}%
                      </div>
                      <div className="text-right">
                        <Badge variant={trade.source === "exchange" ? "default" : "outline"} className="h-4 px-1 text-[8px] uppercase">
                          {trade.source === "exchange" ? "BingX" : "Local"}
                        </Badge>
                      </div>
                    </div>
                  )
                })}
                <div style={{ height: bottomSpacer }} aria-hidden="true" />
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

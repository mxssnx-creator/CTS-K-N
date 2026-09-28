"use client"

import { useEffect, useState } from "react"
import { FlaskConical } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { PositionBookStats } from "@/lib/position-book-stats"

type PositionView = Record<string, any>

export interface SimulatedBookListing {
  stats: PositionBookStats
  open: PositionView[]
  closed: PositionView[]
}

function money(value: number | null | undefined): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return "$0.00"
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`
}

function tone(value: number): string {
  return value > 0 ? "text-green-600" : value < 0 ? "text-red-600" : ""
}

export function formatProfitFactor(book: Pick<PositionBookStats, "profitFactor" | "profitFactorUnbounded">): string {
  if (book.profitFactor !== null && Number.isFinite(book.profitFactor)) return book.profitFactor.toFixed(2)
  return book.profitFactorUnbounded ? "∞ (no losses)" : "—"
}

function Metric({ label, value, className, testId }: { label: string; value: string | number; className?: string; testId?: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-base font-semibold ${className || ""}`} data-testid={testId}>{value}</div>
    </div>
  )
}

/** Metric grid for one independent simulated (paper) book. */
export function SimulatedBookMetrics({ book, testIdPrefix = "sim" }: { book: PositionBookStats; testIdPrefix?: string }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-6">
      <Metric label="Open" value={book.open} testId={`${testIdPrefix}-open`} />
      <Metric label="Closed" value={book.closed} testId={`${testIdPrefix}-closed`} />
      <Metric label="W / L / BE" value={`${book.wins} / ${book.losses} / ${book.breakEven}`} testId={`${testIdPrefix}-wlbe`} />
      <Metric label="Win rate" value={`${book.winRate.toFixed(1)}%`} testId={`${testIdPrefix}-winrate`} />
      <Metric label="Profit factor" value={formatProfitFactor(book)} testId={`${testIdPrefix}-pf`} />
      <Metric label="Max drawdown" value={money(-book.maxDrawdown)} className={book.maxDrawdown > 0 ? "text-red-600" : ""} testId={`${testIdPrefix}-dd`} />
      <Metric label="Net PnL (after fees)" value={money(book.netPnl)} className={tone(book.netPnl)} testId={`${testIdPrefix}-net`} />
      <Metric label="Gross PnL" value={money(book.grossPnl)} className={tone(book.grossPnl)} testId={`${testIdPrefix}-gross`} />
      <Metric label="Fees" value={money(book.fees)} testId={`${testIdPrefix}-fees`} />
      <Metric label="Unrealized" value={money(book.unrealizedPnl)} className={tone(book.unrealizedPnl)} testId={`${testIdPrefix}-unrealized`} />
      <Metric label="Avg win / loss" value={`${money(book.avgWin)} / ${money(book.avgLoss)}`} />
      <Metric label="Open notional" value={money(book.openNotionalUsd)} testId={`${testIdPrefix}-notional`} />
    </div>
  )
}

function PositionRows({ rows, kind, testId }: { rows: PositionView[]; kind: "open" | "closed"; testId: string }) {
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">No {kind} simulated positions.</p>
  return (
    <div className="max-h-64 overflow-auto rounded border" data-testid={testId}>
      <table className="w-full text-xs">
        <thead className="bg-muted/50 text-left">
          <tr>
            <th className="p-1.5">Symbol</th>
            <th className="p-1.5">Side</th>
            <th className="p-1.5">Status</th>
            <th className="p-1.5 text-right">Entry</th>
            <th className="p-1.5 text-right">{kind === "open" ? "Unrealized" : "Realized"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 200).map((row, index) => {
            const pnl = Number(kind === "open" ? row.unrealizedPnL : row.realizedPnL) || 0
            return (
              <tr key={String(row.id ?? index)} className="border-t" data-testid={`${testId}-row`}>
                <td className="p-1.5 font-medium">{String(row.symbol || "—")}</td>
                <td className="p-1.5">{String(row.direction || row.side || "—")}</td>
                <td className="p-1.5">{String(row.status || "—")}</td>
                <td className="p-1.5 text-right">{Number(row.entryPrice || row.averageExecutionPrice || 0).toPrecision(6)}</td>
                <td className={`p-1.5 text-right ${tone(pnl)}`}>{money(pnl)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {rows.length > 200 && <p className="p-1.5 text-xs text-muted-foreground">Showing 200 of {rows.length}.</p>}
    </div>
  )
}

function BucketTable({ title, buckets }: { title: string; buckets: PositionBookStats["bySymbol"] }) {
  const entries = Object.entries(buckets || {}).sort((a, b) => b[1].netPnl - a[1].netPnl)
  if (entries.length === 0) return null
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">{title}</div>
      <div className="max-h-48 overflow-auto rounded border">
        <table className="w-full text-xs">
          <tbody>
            {entries.map(([key, b]) => (
              <tr key={key} className="border-t first:border-t-0">
                <td className="p-1.5 font-medium">{key}</td>
                <td className="p-1.5">{b.open} open / {b.closed} closed</td>
                <td className="p-1.5">{b.wins}W / {b.losses}L</td>
                <td className={`p-1.5 text-right ${tone(b.netPnl)}`}>{money(b.netPnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * Clearly labelled simulated section. Simulated figures are never mixed into
 * the exchange/real cards; this panel is the only place they are shown.
 */
export function SimulatedBookCard({
  book,
  open,
  closed,
  title = "Simulated positions",
  description = "Paper / simulated-connector book — independent of real exchange figures",
  showBreakdown = true,
  testIdPrefix = "sim",
}: {
  book: PositionBookStats | null | undefined
  open?: PositionView[]
  closed?: PositionView[]
  title?: string
  description?: string
  showBreakdown?: boolean
  testIdPrefix?: string
}) {
  return (
    <Card className="border-dashed border-violet-400/60" data-testid={`${testIdPrefix}-card`}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <FlaskConical className="h-4 w-4 text-violet-500" />
          {title}
          <Badge variant="outline" className="border-violet-400 text-violet-600">Simulated</Badge>
        </CardTitle>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {book ? <SimulatedBookMetrics book={book} testIdPrefix={testIdPrefix} /> : (
          <p className="text-xs text-muted-foreground">No simulated statistics available.</p>
        )}
        {showBreakdown && book && (
          <div className="grid gap-3 md:grid-cols-3">
            <BucketTable title="By symbol" buckets={book.bySymbol} />
            <BucketTable title="By strategy family" buckets={book.byStrategy} />
            <BucketTable title="By close hour (UTC)" buckets={book.byHour} />
          </div>
        )}
        {open && (
          <div className="space-y-1">
            <div className="text-xs font-medium">Open simulated ({open.length})</div>
            <PositionRows rows={open} kind="open" testId={`${testIdPrefix}-open-list`} />
          </div>
        )}
        {closed && (
          <div className="space-y-1">
            <div className="text-xs font-medium">Closed simulated ({closed.length})</div>
            <PositionRows rows={closed} kind="closed" testId={`${testIdPrefix}-closed-list`} />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** Self-loading simulated book for one connection (stats + lists from one response). */
export function useSimulatedBook(connectionId: string | null | undefined, refreshMs = 5000): SimulatedBookListing | null {
  const [listing, setListing] = useState<SimulatedBookListing | null>(null)
  useEffect(() => {
    if (!connectionId) {
      setListing(null)
      return
    }
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch(
          `/api/trading/live-positions?connectionId=${encodeURIComponent(connectionId)}&source=simulated`,
          { cache: "no-store" },
        )
        if (!response.ok) return
        const payload = await response.json()
        if (!cancelled && payload?.simulatedBook?.stats) setListing(payload.simulatedBook)
      } catch {
        // keep last good listing
      }
    }
    void load()
    const timer = setInterval(load, refreshMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [connectionId, refreshMs])
  return listing
}

export function ConnectionSimulatedBook({ connectionId, testIdPrefix = "sim" }: { connectionId: string; testIdPrefix?: string }) {
  const listing = useSimulatedBook(connectionId)
  return (
    <SimulatedBookCard
      book={listing?.stats}
      open={listing?.open ?? []}
      closed={listing?.closed ?? []}
      testIdPrefix={testIdPrefix}
    />
  )
}

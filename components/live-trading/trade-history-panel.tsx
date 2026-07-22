"use client"

import { useEffect, useMemo, useState } from "react"
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FilterX,
  History,
  Search,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { TradeHistoryRow } from "@/lib/trade-history"
import type { TradeHistoryResponse } from "@/components/live-trading/live-trading-types"
import {
  finite,
  formatHoldMinutes,
  formatMoney,
  formatPercent,
  formatPrice,
  formatQuantity,
  formatTimestamp,
} from "@/components/live-trading/live-trading-format"

type HistorySide = "all" | "long" | "short"
type HistoryResult = "all" | "win" | "loss" | "flat"
type HistorySource = "all" | "exchange" | "local"
type HistoryRange = "all" | "4h" | "24h" | "48h" | "5d" | "7d"
type HistorySort = "newest" | "pnl" | "volume" | "hold"

interface TradeHistoryPanelProps {
  rows: TradeHistoryRow[]
  response: TradeHistoryResponse | null
}

function SelectFilter({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <label className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-muted-foreground">
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-7 rounded-md border bg-background px-1.5 text-[10px] normal-case tracking-normal text-foreground outline-none"
      >
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  )
}

function timestamp(value: unknown): number {
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1000 : numeric
  const parsed = Date.parse(String(value || ""))
  return Number.isFinite(parsed) ? parsed : 0
}

export function TradeHistoryPanel({ rows, response }: TradeHistoryPanelProps) {
  const [query, setQuery] = useState("")
  const [side, setSide] = useState<HistorySide>("all")
  const [result, setResult] = useState<HistoryResult>("all")
  const [source, setSource] = useState<HistorySource>("all")
  const [range, setRange] = useState<HistoryRange>("all")
  const [variant, setVariant] = useState("all")
  const [sort, setSort] = useState<HistorySort>("newest")
  const [page, setPage] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const pageSize = 50

  const variants = useMemo(() => [
    "all",
    ...Array.from(new Set(rows.map((row) => String(row.setVariant || "").trim()).filter(Boolean))).sort(),
  ], [rows])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const now = Date.now()
    const rangeMs: Partial<Record<HistoryRange, number>> = {
      "4h": 4 * 60 * 60 * 1000,
      "24h": 24 * 60 * 60 * 1000,
      "48h": 48 * 60 * 60 * 1000,
      "5d": 5 * 24 * 60 * 60 * 1000,
      "7d": 7 * 24 * 60 * 60 * 1000,
    }

    const resultRows = rows.filter((row) => {
      if (side !== "all" && row.direction !== side) return false
      if (result === "win" && row.realizedPnl <= 0) return false
      if (result === "loss" && row.realizedPnl >= 0) return false
      if (result === "flat" && row.realizedPnl !== 0) return false
      if (source !== "all" && row.source !== source) return false
      if (variant !== "all" && String(row.setVariant || "") !== variant) return false
      if (range !== "all" && timestamp(row.closedAt) < now - (rangeMs[range] || 0)) return false
      if (!needle) return true
      return [
        row.symbol,
        row.id,
        row.orderId,
        row.closeOrderId,
        row.positionId,
        row.setKey,
        row.parentSetKey,
        row.setVariant,
        row.indicationType,
        row.closeReason,
      ].some((value) => String(value || "").toLowerCase().includes(needle))
    })

    resultRows.sort((left, right) => {
      if (sort === "pnl") return finite(right.realizedPnl) - finite(left.realizedPnl)
      if (sort === "volume") return finite(right.volumeUsd) - finite(left.volumeUsd)
      if (sort === "hold") return finite(right.holdMinutes) - finite(left.holdMinutes)
      return timestamp(right.closedAt) - timestamp(left.closedAt)
    })
    return resultRows
  }, [query, range, result, rows, side, sort, source, variant])

  useEffect(() => {
    setPage(0)
  }, [query, range, result, side, sort, source, variant])

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const boundedPage = Math.min(page, pageCount - 1)
  const visibleRows = filtered.slice(boundedPage * pageSize, (boundedPage + 1) * pageSize)
  const filteredSummary = useMemo(() => {
    let wins = 0
    let losses = 0
    let flat = 0
    let netPnl = 0
    let fees = 0
    for (const row of filtered) {
      if (row.realizedPnl > 0) wins++
      else if (row.realizedPnl < 0) losses++
      else flat++
      netPnl += finite(row.realizedPnl)
      fees += Math.abs(finite(row.fees))
    }
    return { wins, losses, flat, netPnl, fees }
  }, [filtered])

  const clearFilters = () => {
    setQuery("")
    setSide("all")
    setResult("all")
    setSource("all")
    setRange("all")
    setVariant("all")
    setSort("newest")
  }

  return (
    <Card className="border-border/70 shadow-sm">
      <CardHeader className="space-y-2 p-3 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-1.5 text-sm"><History className="size-3.5 text-primary" /> Trade history</CardTitle>
            <p className="mt-0.5 text-[10px] text-muted-foreground">Up to 500 exchange/local closes · 50 rows per page · full execution lineage</p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant="outline" className="h-5 px-1.5 text-[9px]">{filtered.length} shown</Badge>
            <Badge variant="outline" className="h-5 border-emerald-500/30 px-1.5 text-[9px]">{filteredSummary.wins}W</Badge>
            <Badge variant="outline" className="h-5 border-rose-500/30 px-1.5 text-[9px]">{filteredSummary.losses}L</Badge>
            <Badge variant="outline" className={`h-5 px-1.5 text-[9px] ${filteredSummary.netPnl >= 0 ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400" : "border-rose-500/30 text-rose-600 dark:text-rose-400"}`}>
              {formatMoney(filteredSummary.netPnl)} net
            </Badge>
            {response?.source?.stale ? <Badge variant="outline" className="h-5 border-amber-500/30 px-1.5 text-[9px]">Cached exchange snapshot</Badge> : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/20 p-1.5">
          <div className="relative min-w-[180px] flex-1 sm:max-w-[300px]">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Symbol, order, set, reason…" className="h-7 pl-7 text-xs" />
          </div>
          <SelectFilter label="Time range" value={range} onChange={(value) => setRange(value as HistoryRange)} options={[
            { value: "all", label: "All time" },
            { value: "4h", label: "Last 4h" },
            { value: "24h", label: "Last 24h" },
            { value: "48h", label: "Last 48h" },
            { value: "5d", label: "Last 5d" },
            { value: "7d", label: "Last 7d" },
          ]} />
          <SelectFilter label="Direction" value={side} onChange={(value) => setSide(value as HistorySide)} options={[
            { value: "all", label: "All sides" }, { value: "long", label: "Long" }, { value: "short", label: "Short" },
          ]} />
          <SelectFilter label="Result" value={result} onChange={(value) => setResult(value as HistoryResult)} options={[
            { value: "all", label: "All results" }, { value: "win", label: "Wins" }, { value: "loss", label: "Losses" }, { value: "flat", label: "Flat" },
          ]} />
          <SelectFilter label="Source" value={source} onChange={(value) => setSource(value as HistorySource)} options={[
            { value: "all", label: "All sources" }, { value: "exchange", label: "Exchange" }, { value: "local", label: "Local" },
          ]} />
          <SelectFilter label="Strategy variant" value={variant} onChange={setVariant} options={variants.map((value) => ({ value, label: value === "all" ? "All variants" : value }))} />
          <SelectFilter label="Sort" value={sort} onChange={(value) => setSort(value as HistorySort)} options={[
            { value: "newest", label: "Newest" }, { value: "pnl", label: "PnL" }, { value: "volume", label: "Volume" }, { value: "hold", label: "Hold time" },
          ]} />
          <Button variant="ghost" size="sm" onClick={clearFilters} className="h-7 px-2 text-[10px]"><FilterX className="mr-1 size-3" /> Reset</Button>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        <div className="max-h-[760px] overflow-auto border-y">
          <Table className="min-w-[1220px] text-xs">
            <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur">
              <TableRow>
                <TableHead className="h-8 w-7 pl-3" />
                <TableHead className="h-8 text-[10px]">Closed</TableHead>
                <TableHead className="h-8 text-[10px]">Symbol / Side</TableHead>
                <TableHead className="h-8 text-[10px]">Entry → Exit</TableHead>
                <TableHead className="h-8 text-[10px]">Quantity / Notional</TableHead>
                <TableHead className="h-8 text-[10px]">Net PnL / Return</TableHead>
                <TableHead className="h-8 text-[10px]">Fees / Hold</TableHead>
                <TableHead className="h-8 text-[10px]">Strategy</TableHead>
                <TableHead className="h-8 pr-3 text-[10px]">Source / Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.map((row) => {
                const expanded = expandedId === row.id
                return (
                  <FragmentRow
                    key={`${row.id}:${row.closeOrderId || ""}`}
                    row={row}
                    expanded={expanded}
                    onToggle={() => setExpandedId(expanded ? null : row.id)}
                  />
                )
              })}
              {visibleRows.length === 0 ? (
                <TableRow><TableCell colSpan={9} className="h-28 text-center text-xs text-muted-foreground">No closed orders match the selected filters.</TableCell></TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[10px] text-muted-foreground">
          <div>
            Rows {filtered.length === 0 ? 0 : boundedPage * pageSize + 1}–{Math.min((boundedPage + 1) * pageSize, filtered.length)} of {filtered.length}
            {response?.paging ? ` · API ${response.paging.returned}/${response.paging.maximum}` : ""}
            {response?.source ? ` · ${response.source.exchange} exchange + ${response.source.local} local` : ""}
          </div>
          <div className="flex items-center gap-1">
            <span className="mr-1">Page {boundedPage + 1} / {pageCount}</span>
            <Button variant="outline" size="icon" className="size-7" disabled={boundedPage <= 0} onClick={() => setPage((value) => Math.max(0, value - 1))}><ChevronLeft className="size-3" /></Button>
            <Button variant="outline" size="icon" className="size-7" disabled={boundedPage >= pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}><ChevronRight className="size-3" /></Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function FragmentRow({ row, expanded, onToggle }: { row: TradeHistoryRow; expanded: boolean; onToggle: () => void }) {
  const pnl = finite(row.realizedPnl)
  return (
    <>
      <TableRow className="cursor-pointer" onClick={onToggle}>
        <TableCell className="py-1.5 pl-3 pr-0">
          <Button variant="ghost" size="icon" className="size-5" aria-label={expanded ? "Hide trade details" : "Show trade details"}>
            {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </Button>
        </TableCell>
        <TableCell className="py-1.5 font-mono text-[10px] tabular-nums">{formatTimestamp(row.closedAt)}</TableCell>
        <TableCell className="py-1.5">
          <div className="font-semibold">{row.symbol}</div>
          <div className={`text-[9px] uppercase ${row.direction === "long" ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>{row.direction}</div>
        </TableCell>
        <TableCell className="py-1.5 font-mono text-[10px] tabular-nums">{formatPrice(row.entryPrice)} <span className="text-muted-foreground">→</span> {formatPrice(row.exitPrice)}</TableCell>
        <TableCell className="py-1.5">
          <div className="font-mono text-[10px]">{formatQuantity(row.quantity)}</div>
          <div className="text-[9px] text-muted-foreground">{formatMoney(row.volumeUsd)}</div>
        </TableCell>
        <TableCell className="py-1.5">
          <div className={`font-semibold tabular-nums ${pnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>{formatMoney(pnl)}</div>
          <div className={`text-[9px] ${pnl >= 0 ? "text-emerald-600/80 dark:text-emerald-400/80" : "text-rose-600/80 dark:text-rose-400/80"}`}>{formatPercent(row.pnlPct)}</div>
        </TableCell>
        <TableCell className="py-1.5">
          <div className="text-[10px]">{formatMoney(row.fees)}</div>
          <div className="text-[9px] text-muted-foreground">{formatHoldMinutes(row.holdMinutes)}</div>
        </TableCell>
        <TableCell className="py-1.5">
          <div className="text-[10px] font-medium capitalize">{row.setVariant || "default"}</div>
          <div className="max-w-[180px] truncate text-[9px] text-muted-foreground" title={row.indicationType || row.setKey || ""}>{row.indicationType || row.setKey || "—"}</div>
        </TableCell>
        <TableCell className="py-1.5 pr-3">
          <Badge variant="outline" className={`h-4 px-1 text-[8px] ${row.source === "exchange" ? "border-emerald-500/30" : ""}`}>{row.source}</Badge>
          <div className="mt-0.5 max-w-[220px] truncate text-[9px] text-muted-foreground" title={row.closeReason || ""}>{row.closeReason || "—"}</div>
        </TableCell>
      </TableRow>
      {expanded ? (
        <TableRow className="bg-muted/20 hover:bg-muted/20">
          <TableCell colSpan={9} className="px-10 py-2">
            <div className="grid gap-2 text-[10px] sm:grid-cols-2 lg:grid-cols-4">
              <DetailGroup label="Execution" values={[
                ["Order", row.orderId], ["Close order", row.closeOrderId], ["Position", row.positionId], ["Source", row.source],
              ]} />
              <DetailGroup label="Strategy lineage" values={[
                ["Set", row.setKey], ["Parent", row.parentSetKey], ["Variant", row.setVariant], ["Indication", row.indicationType],
              ]} />
              <DetailGroup label="Protection at close · Risk settings" values={[
                ["Stop loss", formatPrice(row.stopLossPrice)], ["Take profit", formatPrice(row.takeProfitPrice)], ["Trailing", row.trailingActive ? `Yes · ${formatPrice(row.trailingStopPrice)}` : "No"], ["Reason", row.closeReason],
              ]} />
              <DetailGroup label="Sizing · Position detail" values={[
                ["Leverage", row.leverage ? `${row.leverage}x` : "—"], ["Margin", row.marginType], ["Block count", row.blockCount], ["DCA step", row.dcaStep],
              ]} />
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  )
}

function DetailGroup({ label, values }: { label: string; values: Array<[string, unknown]> }) {
  return (
    <div className="rounded-md border bg-background/70 p-2">
      <div className="mb-1 font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <dl className="space-y-0.5">
        {values.map(([name, value]) => (
          <div key={name} className="grid grid-cols-[76px_1fr] gap-1">
            <dt className="text-muted-foreground">{name}</dt>
            <dd className="truncate font-mono" title={String(value || "")}>{value === undefined || value === null || value === "" ? "—" : String(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

"use client"

import { useMemo, useState } from "react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { BacktestBook, BacktestHeatmap, BacktestResult, BacktestTrade } from "@/lib/connection-backtest-settings"

// ───────────────────────────── formatting ─────────────────────────────
export const fmtPct = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(value) ? "–" : `${value > 0 ? "+" : ""}${value.toFixed(digits)} %`
/** PF; null with wins means nothing was lost (∞), without trades "–". */
export const fmtPf = (value: number | null | undefined, wins = 0) =>
  value === null || value === undefined ? (wins > 0 ? "∞" : "–") : value.toFixed(2)
export const toneOf = (value: number | null | undefined) =>
  value === null || value === undefined || value === 0 ? "" : value > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
const pfTone = (book: Pick<BacktestBook, "profitFactor" | "wins" | "trades">) =>
  book.trades === 0 ? "" : toneOf((book.profitFactor ?? (book.wins > 0 ? 2 : 0)) - 1)
const time = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
const hourLabel = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })
const RANGE_LABEL: Record<string, string> = { micro: "Micro (< 2×)", minimum: "Minimum (2–3×)", short: "Short (3–6×)", general: "General (6–12×)", long: "Long (> 12×)" }
const PROFIT = "rgb(16 185 129)" // emerald-500
const LOSS = "rgb(244 63 94)" // rose-500

function Kpi({ label, value, tone = "", hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5" title={hint}>
      <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 whitespace-nowrap text-base font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  )
}

function ChartCard({ title, children, height = 220, subtitle }: { title: string; children: React.ReactNode; height?: number; subtitle?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div className="text-xs font-medium">{title}</div>
        {subtitle && <div className="text-[10px] text-muted-foreground">{subtitle}</div>}
      </div>
      <div style={{ height }}>{children}</div>
    </div>
  )
}

const tooltipStyle = {
  contentStyle: { background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12, color: "hsl(var(--popover-foreground))" },
  labelStyle: { color: "hsl(var(--muted-foreground))" },
  itemStyle: { color: "hsl(var(--popover-foreground))" },
  cursor: { fill: "hsl(var(--muted))", fillOpacity: 0.35 },
}

function BookTable({ title, rows, labelOf = (key) => key }: { title: string; rows: BacktestBook[]; labelOf?: (key: string) => string }) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="border-b px-3 py-2 text-xs font-medium">{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap text-xs tabular-nums">
          <thead className="text-muted-foreground">
            <tr>{["", "Trades", "Win rate", "PF", "Net (sum %)", "Avg / trade"].map((h, i) => <th key={i} className="px-3 py-1.5 text-right font-normal first:text-left">{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t">
                <td className="px-3 py-1.5 text-left">{labelOf(row.key)}</td>
                <td className="px-3 py-1.5 text-right">{row.trades}</td>
                <td className="px-3 py-1.5 text-right">{row.winRate === null ? "–" : `${(row.winRate * 100).toFixed(0)} %`}</td>
                <td className={`px-3 py-1.5 text-right ${pfTone(row)}`}>{fmtPf(row.profitFactor, row.wins)}</td>
                <td className={`px-3 py-1.5 text-right ${toneOf(row.netPct)}`}>{row.trades ? fmtPct(row.netPct) : "–"}</td>
                <td className={`px-3 py-1.5 text-right ${toneOf(row.avgNetPct)}`}>{fmtPct(row.avgNetPct, 3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Rows × hours grid; colour intensity = |net| relative to the largest cell; grey = no closes. */
function Heatmap({ map, labelOf = (row: string) => row }: { map: BacktestHeatmap; labelOf?: (row: string) => string }) {
  const [hover, setHover] = useState<{ row: number; col: number } | null>(null)
  const [asTable, setAsTable] = useState(false)
  const maxAbs = useMemo(() => Math.max(1e-9, ...map.cells.flat().map((cell) => Math.abs(cell.netPct))), [map])
  const step = map.cols.length > 40 ? 6 : map.cols.length > 20 ? 3 : 1
  const totals = map.rows.map((_, r) => map.cells[r].reduce((sum, cell) => ({ trades: sum.trades + cell.trades, netPct: sum.netPct + cell.netPct }), { trades: 0, netPct: 0 }))
  const active = hover ? { row: map.rows[hover.row], at: map.cols[hover.col], ...map.cells[hover.row][hover.col] } : null
  if (map.rows.length === 0) return <p className="py-8 text-center text-xs text-muted-foreground">No closed trades to map.</p>
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-2" aria-label="Heatmap legend">
          <span>loss</span>
          <span className="h-2.5 w-24 rounded-sm" style={{ background: `linear-gradient(90deg, ${LOSS}, hsl(var(--muted)), ${PROFIT})` }} />
          <span>profit</span>
          <span className="ml-2 inline-block h-2.5 w-2.5 rounded-sm bg-muted" /> <span>no closes</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="tabular-nums min-h-[1rem]" aria-live="polite">
            {active ? `${labelOf(active.row)} · ${hourLabel(active.at)} · ${active.trades} trades · ${fmtPct(active.netPct)}` : "Hover a cell"}
          </span>
          <button type="button" className="rounded border px-2 py-0.5 hover:bg-muted" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>
            {asTable ? "Grid view" : "Table view"}
          </button>
        </div>
      </div>
      {asTable ? (
        <div className="max-h-[50vh] overflow-auto rounded border">
          <table className="w-full text-[11px] tabular-nums">
            <thead className="sticky top-0 bg-background text-muted-foreground">
              <tr><th className="px-2 py-1 text-left font-normal">Row</th><th className="px-2 py-1 text-right font-normal">Trades</th><th className="px-2 py-1 text-right font-normal">Net</th>{map.cols.map((col) => <th key={col} className="px-2 py-1 text-right font-normal">{hourLabel(col)}</th>)}</tr>
            </thead>
            <tbody>
              {map.rows.map((row, r) => (
                <tr key={row} className="border-t">
                  <td className="px-2 py-1">{labelOf(row)}</td>
                  <td className="px-2 py-1 text-right">{totals[r].trades}</td>
                  <td className={`px-2 py-1 text-right ${toneOf(totals[r].netPct)}`}>{fmtPct(totals[r].netPct)}</td>
                  {map.cells[r].map((cell, c) => <td key={c} className={`px-2 py-1 text-right ${toneOf(cell.netPct)}`}>{cell.trades ? cell.netPct.toFixed(2) : ""}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="inline-grid min-w-full gap-[2px]" style={{ gridTemplateColumns: `minmax(84px, max-content) repeat(${map.cols.length}, minmax(10px, 1fr)) 72px` }} onMouseLeave={() => setHover(null)}>
            <div />
            {map.cols.map((col, c) => (
              <div key={col} className="text-center text-[9px] text-muted-foreground tabular-nums">{c % step === 0 ? hourLabel(col).slice(0, 2) : ""}</div>
            ))}
            <div className="text-right text-[9px] text-muted-foreground">net</div>
            {map.rows.map((row, r) => (
              <div key={row} className="contents">
                <div className="truncate pr-2 text-[11px]">{labelOf(row)}</div>
                {map.cells[r].map((cell, c) => {
                  const intensity = Math.min(1, Math.abs(cell.netPct) / maxAbs)
                  const background = cell.trades === 0
                    ? "hsl(var(--muted))"
                    : `color-mix(in srgb, ${cell.netPct >= 0 ? PROFIT : LOSS} ${Math.round(25 + intensity * 75)}%, hsl(var(--muted)))`
                  const selected = hover?.row === r && hover?.col === c
                  return (
                    <div key={c}
                      role="gridcell"
                      aria-label={`${labelOf(row)} ${hourLabel(map.cols[c])}: ${cell.trades} trades, ${fmtPct(cell.netPct)}`}
                      onMouseEnter={() => setHover({ row: r, col: c })}
                      className={`h-5 rounded-[3px] ${selected ? "ring-2 ring-foreground" : ""}`}
                      style={{ background }} />
                  )
                })}
                <div className={`text-right text-[11px] tabular-nums ${toneOf(totals[r].netPct)}`}>{fmtPct(totals[r].netPct, 1)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

type SortKey = "exitTime" | "symbol" | "type" | "netPct" | "grossPct"

function TradesTable({ trades }: { trades: BacktestTrade[] }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "exitTime", desc: true })
  const rows = useMemo(() => [...trades].sort((a, b) => {
    const left = a[sort.key], right = b[sort.key]
    const order = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right))
    return sort.desc ? -order : order
  }), [trades, sort])
  const header = (key: SortKey | null, label: string) => (
    <th className="px-2 py-1.5 text-right font-normal first:text-left">
      {key ? (
        <button type="button" className="hover:text-foreground" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }))}>
          {label}{sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
        </button>
      ) : label}
    </th>
  )
  return (
    <div className="max-h-[60vh] overflow-auto rounded-lg border">
      <table className="w-full text-xs tabular-nums">
        <thead className="sticky top-0 bg-background text-muted-foreground">
          <tr>{header("exitTime", "Closed")}{header("symbol", "Symbol")}{header("type", "Type")}{header(null, "Side")}{header(null, "Entry → Exit")}{header(null, "TP / SL")}{header(null, "Reason")}{header("grossPct", "Gross")}{header("netPct", "Net")}</tr>
        </thead>
        <tbody>
          {rows.map((trade, i) => (
            <tr key={`${trade.symbol}-${trade.entryTime}-${trade.type}-${trade.rule}-${i}`} className="border-t">
              <td className="px-2 py-1 text-left">{time(trade.exitTime)}</td>
              <td className="px-2 py-1 text-right">{trade.symbol}</td>
              <td className="px-2 py-1 text-right">{trade.type}<span className="text-muted-foreground">·{trade.rule}</span></td>
              <td className="px-2 py-1 text-right">{trade.direction}</td>
              <td className="px-2 py-1 text-right">{trade.entryPrice.toPrecision(6)} → {trade.exitPrice.toPrecision(6)}</td>
              <td className="px-2 py-1 text-right">{trade.takeProfitPct.toFixed(2)} / {trade.stopLossPct.toFixed(2)} %</td>
              <td className="px-2 py-1 text-right">{trade.reason.replace(/_/g, " ")}{trade.exitLeg === "maker" ? " (maker)" : ""}</td>
              <td className={`px-2 py-1 text-right ${toneOf(trade.grossPct)}`}>{fmtPct(trade.grossPct, 3)}</td>
              <td className={`px-2 py-1 text-right ${toneOf(trade.netPct)}`}>{fmtPct(trade.netPct, 3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  result: BacktestResult
}

export function ConnectionBacktestDialog({ open, onOpenChange, result }: Props) {
  const s = result.summary
  const [heatmapRows, setHeatmapRows] = useState<"symbol" | "type">("symbol")
  const hourly = result.byHour.map((hour) => ({ ...hour, label: hourLabel(hour.startAt) }))
  const equity = result.equity.map((point) => ({ ...point, label: time(point.t) }))
  const symbols = result.bySymbol.filter((row) => row.trades > 0)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl sm:max-w-6xl h-[90dvh] flex flex-col p-0 gap-0" data-testid="connection-backtest-dialog">
        <DialogHeader className="border-b px-5 py-3">
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
            Backtest statistics
            <Badge variant="secondary" className="text-[10px]">{result.hours} h</Badge>
            <Badge variant="secondary" className="text-[10px]">{result.mode === "gated" ? "Base-gated" : "all signals"}</Badge>
            <Badge variant="secondary" className="text-[10px]">{result.execution === "maker" ? "maker (post-only)" : "market (taker)"}</Badge>
          </DialogTitle>
          <DialogDescription className="text-xs">
            {result.connectionId} · {time(result.window.fromMs)} → {time(result.window.toMs)} · {result.bySymbol.length} symbols ·
            computed {time(result.generatedAt)} in {(result.durationMs / 1000).toFixed(1)} s. Net figures are summed per-trade
            percentages after fees ({result.costs.makerPct.toFixed(2)} % maker, {result.costs.takerPct.toFixed(2)} % taker incl. slippage per leg).
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-5 mt-3 w-fit">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="breakdown">Breakdown</TabsTrigger>
            <TabsTrigger value="heatmap">Heatmap</TabsTrigger>
            <TabsTrigger value="trades">Trades</TabsTrigger>
          </TabsList>
          <ScrollArea className="min-h-0 flex-1">
            <div className="px-5 py-4">
              <TabsContent value="overview" className="mt-0 space-y-4">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
                  <Kpi label="Trades" value={String(s.trades)} />
                  <Kpi label="Profit factor" value={fmtPf(s.profitFactor, s.wins)} tone={pfTone(s)} />
                  <Kpi label="Net Σ %" value={fmtPct(s.netPct)} tone={toneOf(s.netPct)} />
                  <Kpi label="Win rate" value={s.winRate === null ? "–" : `${(s.winRate * 100).toFixed(1)} %`} />
                  <Kpi label="Max drawdown" value={fmtPct(-s.maxDrawdownPct)} tone={s.maxDrawdownPct > 0 ? toneOf(-1) : ""} />
                  <Kpi label="Positive hours" value={`${s.profitableHours}/${s.activeHours}`} />
                  <Kpi label="Avg hold" value={s.avgHoldMinutes === null ? "–" : `${s.avgHoldMinutes.toFixed(0)} min`} />
                  <Kpi label={result.execution === "maker" ? "Fill rate" : "Fees Σ %"} value={result.execution === "maker" ? (s.fillRate === null ? "–" : `${(s.fillRate * 100).toFixed(0)} %`) : fmtPct(-s.feesPct)}
                    hint={result.execution === "maker" ? "Post-only entries filled by a trade-through within 3 minutes" : "Total round-trip fees and slippage"} />
                </div>
                {result.notes.length > 0 && (
                  <ul className="list-disc rounded-lg border border-amber-500/30 bg-amber-500/5 py-2 pl-7 pr-3 text-[11px] text-muted-foreground">
                    {result.notes.map((note) => <li key={note}>{note}</li>)}
                  </ul>
                )}
                {result.funnel && (
                  <div className="rounded-lg border bg-card p-3" data-testid="connection-backtest-funnel">
                    <div className="mb-2 text-xs font-medium">Base gate funnel</div>
                    <div className="space-y-1.5">
                      {result.funnel.map((step) => {
                        const max = Math.max(1, result.funnel![0].count)
                        return (
                          <div key={step.stage} className="grid grid-cols-[minmax(160px,220px)_1fr_64px] items-center gap-2 text-[11px]">
                            <span className="text-muted-foreground">{step.stage}</span>
                            <div className="h-3 rounded-sm bg-muted"><div className="h-3 rounded-sm" style={{ width: `${(step.count / max) * 100}%`, background: "hsl(var(--chart-2))" }} /></div>
                            <span className="text-right tabular-nums">{step.count}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
                <div className="grid gap-3 lg:grid-cols-2">
                  <ChartCard title="Equity" subtitle="cumulative net, sum of trade %">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={equity} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={hourLabel} tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => Number(v).toFixed(0)} />
                        <Tooltip {...tooltipStyle} labelFormatter={(v) => time(Number(v))} formatter={(v: any) => [fmtPct(Number(v)), "Equity"]} />
                        <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 3" />
                        <Line type="monotone" dataKey="equityPct" stroke="hsl(var(--chart-2))" strokeWidth={2} dot={false} isAnimationActive={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </ChartCard>
                  <ChartCard title="Drawdown" subtitle="distance below the equity peak">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={equity} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={hourLabel} tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => Number(v).toFixed(0)} />
                        <Tooltip {...tooltipStyle} labelFormatter={(v) => time(Number(v))} formatter={(v: any) => [fmtPct(Number(v)), "Drawdown"]} />
                        <Area type="stepAfter" dataKey="drawdownPct" stroke={LOSS} fill={LOSS} fillOpacity={0.18} strokeWidth={1.5} isAnimationActive={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </ChartCard>
                </div>
                <ChartCard title="Net per hour" subtitle={`${s.profitableHours} of ${s.activeHours} active hours positive`} height={200}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={hourly} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 10 }} domain={[(min: number) => Math.min(0, min), (max: number) => Math.max(0, max)]} tickFormatter={(v) => Number(v).toFixed(0)} />
                      <Tooltip {...tooltipStyle} formatter={(v: any, name: any, item: any) => [`${fmtPct(Number(v))} · ${item?.payload?.trades ?? 0} trades`, "Net"]} />
                      <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" />
                      <Bar dataKey="netPct" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                        {hourly.map((hour) => <Cell key={hour.hour} fill={hour.netPct >= 0 ? PROFIT : LOSS} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>
                <BookTable title="Range classes (take profit in PositionCost multiples)" rows={result.byRangeClass} labelOf={(key) => RANGE_LABEL[key] || key} />
              </TabsContent>

              <TabsContent value="breakdown" className="mt-0 space-y-4">
                <ChartCard title="Net per symbol" height={Math.max(160, symbols.length * 22)}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={symbols} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 10 }} domain={[(min: number) => Math.min(0, min), (max: number) => Math.max(0, max)]} tickFormatter={(v) => Number(v).toFixed(0)} />
                      <YAxis type="category" dataKey="key" width={84} tick={{ fontSize: 10 }} />
                      <Tooltip {...tooltipStyle} formatter={(v: any, _n: any, item: any) => [`${fmtPct(Number(v))} · PF ${fmtPf(item?.payload?.profitFactor, item?.payload?.wins)} · ${item?.payload?.trades} trades`, "Net"]} />
                      <ReferenceLine x={0} stroke="hsl(var(--muted-foreground))" />
                      <Bar dataKey="netPct" radius={[0, 3, 3, 0]} isAnimationActive={false}>
                        {symbols.map((row) => <Cell key={row.key} fill={row.netPct >= 0 ? PROFIT : LOSS} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>
                <div className="grid gap-3 lg:grid-cols-2">
                  <BookTable title="Indication types" rows={result.byType} />
                  <BookTable title="Direction" rows={result.byDirection} />
                  <BookTable title="Exit reasons" rows={result.byReason} labelOf={(key) => key.replace(/_/g, " ")} />
                  <BookTable title="Range classes" rows={result.byRangeClass} labelOf={(key) => RANGE_LABEL[key] || key} />
                </div>
                <BookTable title="Symbols" rows={result.bySymbol} />
                <div className="rounded-lg border bg-card p-3 text-[11px] text-muted-foreground">
                  Data: {result.data.map((d) => `${d.symbol} ${d.bars}/${d.expectedBars} bars, ${d.signals} signals${d.error ? ` (${d.error})` : ""}`).join(" · ")}
                </div>
              </TabsContent>

              <TabsContent value="heatmap" className="mt-0 space-y-3">
                <div className="flex items-center gap-1 rounded-md border p-1 w-fit" role="radiogroup" aria-label="Heatmap rows">
                  {([["symbol", "Symbol × hour"], ["type", "Type × hour"]] as const).map(([value, label]) => (
                    <button key={value} type="button" role="radio" aria-checked={heatmapRows === value}
                      onClick={() => setHeatmapRows(value)}
                      className={`rounded px-2 py-1 text-xs ${heatmapRows === value ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>{label}</button>
                  ))}
                </div>
                <div className="rounded-lg border bg-card p-3" data-testid="connection-backtest-heatmap">
                  <Heatmap map={heatmapRows === "symbol" ? result.heatmapSymbolHour : result.heatmapTypeHour} />
                </div>
                <p className="text-[11px] text-muted-foreground">Each cell sums the net of the trades that closed in that hour; colour intensity is relative to the largest cell.</p>
              </TabsContent>

              <TabsContent value="trades" className="mt-0 space-y-2">
                <p className="text-[11px] text-muted-foreground">Latest {result.trades.length} of {s.trades} trades. Click a header to sort.</p>
                <TradesTable trades={result.trades} />
              </TabsContent>
            </div>
          </ScrollArea>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

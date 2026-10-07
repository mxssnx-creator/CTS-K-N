"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { BarChart3, Loader2, Play, Square } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Slider } from "@/components/ui/slider"
import { BACKTEST_HOURS, type BacktestExecution, type BacktestMode, type BacktestResult } from "@/lib/connection-backtest"
import { ConnectionBacktestDialog, fmtPct, fmtPf, toneOf } from "./connection-backtest-dialog"

interface JobStatus {
  jobId: string
  status: "running" | "completed" | "failed" | "cancelled"
  startedAt: number
  finishedAt?: number
  done: number
  total: number
  currentSymbol?: string
  error?: string
  request: { hours: number; mode: BacktestMode; execution: BacktestExecution; symbols?: string[] }
}

interface Props {
  connectionId: string
  exchange?: string
  /** The dialog's current symbol selection; the server resolves the connection's basket when empty. */
  symbols?: string[]
}

const POLL_MS = 1_500
const ERROR_TEXT: Record<string, string> = {
  no_symbols: "This connection has no symbols selected.",
  backtest_busy: "A backtest for this connection is already running.",
  connection_not_found: "Connection not found.",
  backtest_unavailable_in_forced_simulation: "Backtests need real market data; this server runs a forced simulation.",
  interrupted: "The backtest was interrupted (server restart). Run it again.",
}
const errorText = (error?: string) =>
  !error ? "" : ERROR_TEXT[error] || (error.startsWith("unsupported_exchange:") ? `No market-data connector for ${error.split(":")[1]}.` : error)

function windowLabel(hours: number, now = Date.now()) {
  const to = new Date(Math.floor(now / 60_000) * 60_000)
  const from = new Date(to.getTime() - hours * 3_600_000)
  const fmt = (date: Date) => date.toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
  return `${fmt(from)} → ${fmt(to)}`
}

export function ConnectionBacktestSection({ connectionId, exchange, symbols = [] }: Props) {
  const [hours, setHours] = useState<number>(BACKTEST_HOURS.default)
  const [mode, setMode] = useState<BacktestMode>("signals")
  const [execution, setExecution] = useState<BacktestExecution>("market")
  const [job, setJob] = useState<JobStatus | null>(null)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [error, setError] = useState<string>("")
  const [starting, setStarting] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlight = useRef(false)
  const url = `/api/connections/${encodeURIComponent(connectionId)}/backtest`

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const response = await fetch(url, { cache: "no-store" })
      const json = await response.json().catch(() => null)
      if (!response.ok || !json?.success) return
      setJob(json.job ?? null)
      setResult(json.result ?? null)
      if (json.job?.status === "failed") setError(errorText(json.job.error))
    } finally {
      inFlight.current = false
    }
  }, [url])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (job?.status !== "running") return
    timer.current = setTimeout(() => { void refresh() }, POLL_MS)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [job, refresh])

  const run = async () => {
    setError("")
    setStarting(true)
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hours, mode, execution, ...(symbols.length > 0 && { symbols }) }),
      })
      const json = await response.json().catch(() => null)
      if (!response.ok || !json?.success) setError(errorText(json?.error) || `HTTP ${response.status}`)
      else setJob(json.job)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }
  const cancel = async () => {
    await fetch(url, { method: "DELETE" }).catch(() => undefined)
    void refresh()
  }

  const running = job?.status === "running"
  const progress = running && job.total > 0 ? Math.round((job.done / job.total) * 100) : 0
  const s = result?.summary

  return (
    <Card data-testid="connection-backtest-section">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm flex items-center gap-2"><BarChart3 className="h-4 w-4" />Backtest</CardTitle>
            <CardDescription className="text-xs">
              Replays the last hours of this connection{exchange ? ` (${exchange})` : ""} on the exchange&apos;s real
              one-minute bars with the engine&apos;s own entries, TP/SL and fees. Read-only: no order is ever placed,
              and the engine&apos;s statistics are not changed.
            </CardDescription>
          </div>
          {result && (
            <Badge variant="secondary" className="text-[10px] shrink-0">
              last: {result.hours} h · {result.execution}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Date range (last hours)</Label>
            <span className="text-xs tabular-nums text-muted-foreground">{hours} h</span>
          </div>
          <Slider
            aria-label="Backtest range hours"
            min={BACKTEST_HOURS.min}
            max={BACKTEST_HOURS.max}
            step={BACKTEST_HOURS.step}
            value={[hours]}
            onValueChange={([value]) => setHours(value)}
            disabled={running}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>{windowLabel(hours)}</span>
            <span>{BACKTEST_HOURS.min}–{BACKTEST_HOURS.max} h, steps of {BACKTEST_HOURS.step}; default {BACKTEST_HOURS.default}</span>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Mode</Label>
            <div className="grid grid-cols-2 gap-1 rounded-md border p-1" role="radiogroup" aria-label="Backtest mode">
              {([["signals", "All signals"], ["gated", "Base-gated"]] as const).map(([value, label]) => (
                <button key={value} type="button" role="radio" aria-checked={mode === value} disabled={running}
                  onClick={() => setMode(value)}
                  className={`rounded px-2 py-1 text-xs transition-colors ${mode === value ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Execution</Label>
            <div className="grid grid-cols-2 gap-1 rounded-md border p-1" role="radiogroup" aria-label="Backtest execution">
              {([["market", "Market (taker)"], ["maker", "Maker (post-only)"]] as const).map(([value, label]) => (
                <button key={value} type="button" role="radio" aria-checked={execution === value} disabled={running}
                  onClick={() => setExecution(value)}
                  className={`rounded px-2 py-1 text-xs transition-colors ${execution === value ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {mode === "signals"
            ? "Signals: every indication row of the engine on its own, entered at the decision close; exits on real bar highs/lows (a bar touching both levels counts as a stop)."
            : "Base-gated: a row trades only when the engine's Base gate admits it at that moment (≥ 5 measured closes in its symbol × type × direction bucket and min(row PF, PositionCost ratio) ≥ 1.10). The full Base → Main → Real → Live pipeline cannot run as a backtest (prehistoric range capped at 50 h; it would share the live engine's process and locks)."}
          {" "}
          {execution === "maker"
            ? "Maker: post-only entry filled only when price trades through it within 3 min; TP rests as a maker order; stops are taker."
            : "Market: taker entry and exits, 0.05 % fee + 0.03 % slippage per leg."}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button size="sm" variant="outline" onClick={cancel} aria-label="Cancel backtest"><Square className="mr-1.5 h-3.5 w-3.5" />Cancel</Button>
          ) : (
            <Button size="sm" onClick={run} disabled={starting} aria-label="Run backtest">
              {starting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}Run backtest
            </Button>
          )}
          <Button size="sm" variant="secondary" disabled={!result} onClick={() => setDetailsOpen(true)} aria-label="Open detailed backtest statistics">
            <BarChart3 className="mr-1.5 h-3.5 w-3.5" />Detailed statistics
          </Button>
          {job?.status === "cancelled" && <span className="text-xs text-muted-foreground">Cancelled.</span>}
        </div>

        {running && (
          <div className="space-y-1">
            <Progress value={progress} aria-label="Backtest progress" />
            <p className="text-[11px] text-muted-foreground tabular-nums">
              {job.done}/{job.total} symbols{job.currentSymbol ? ` · ${job.currentSymbol}` : ""} · {Math.round((Date.now() - job.startedAt) / 1000)} s
            </p>
          </div>
        )}
        {error && <p className="text-xs text-rose-600 dark:text-rose-400" role="alert">{error}</p>}

        {s && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" data-testid="connection-backtest-kpis">
            {[
              ["Trades", String(s.trades), ""],
              ["Profit factor", fmtPf(s.profitFactor, s.wins), toneOf((s.profitFactor ?? (s.wins > 0 ? 2 : 0)) - 1)],
              ["Net (sum %)", fmtPct(s.netPct), toneOf(s.netPct)],
              ["Max drawdown", fmtPct(-s.maxDrawdownPct), s.maxDrawdownPct > 0 ? toneOf(-1) : ""],
              ["Positive hours", `${s.profitableHours}/${s.activeHours}`, ""],
            ].map(([label, value, tone]) => (
              <div key={label} className="rounded-md border px-2.5 py-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
                <div className={`text-sm font-semibold tabular-nums ${tone}`}>{value}</div>
              </div>
            ))}
          </div>
        )}
        {result && result.notes.length > 0 && (
          <ul className="list-disc pl-4 text-[11px] text-muted-foreground">{result.notes.map((note) => <li key={note}>{note}</li>)}</ul>
        )}
      </CardContent>
      {result && <ConnectionBacktestDialog open={detailsOpen} onOpenChange={setDetailsOpen} result={result} />}
    </Card>
  )
}

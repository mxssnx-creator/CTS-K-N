"use client"

/**
 * EngineProgressionTestDialog
 *
 * A detailed, self-driving E2E test for the trading engine. When opened it
 * automatically runs the full progression sequence:
 *
 *   Boot phases (fast — seconds):
 *     P1  GET   /api/health                              — dev server up
 *     P2  GET   /api/trade-engine/quick-start/ready     — preflight
 *     P3  POST  /api/trade-engine/quick-start (enable)  — 1 auto-picked symbol
 *     P4  GET   /api/trade-engine/progression           — wait for engine
 *
 *   Prehistoric calc verification (waits for historic.isComplete):
 *     P5  GET   /api/connections/progression/{id}/stats — assert symbols,
 *               candles, indicators calc'd, cycles > 0
 *
 *   5-minute live observation (streams `/stats` every 5 s, captures deltas):
 *     P6  — Realtime processing & live trade execution
 *           records indication / strategy / realtime cycle rates, orders
 *           placed / filled, positions opened / closed, fillRate, winRate,
 *           cumulative PnL. Shows a live countdown + streaming metric cards
 *           + delta-per-minute rates inside the dialog.
 *
 *   Teardown:
 *     P7  POST  /api/trade-engine/quick-start (disable) — clean teardown
 *
 * Concluding "Results" panel surfaces every captured metric grouped by
 * category so the operator can eyeball correctness end-to-end without
 * opening a terminal. Cancelling (closing the dialog) stops the observation
 * loop cleanly.
 *
 * Exports:
 *   <EngineProgressionTestDialog />        — the dialog itself (self-opening form)
 *   <EngineProgressionTestButton />        — a convenience button that opens the dialog
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Clock,
  FlaskConical,
  Loader2,
  Play,
  RefreshCw,
  TimerReset,
  TrendingUp,
  XCircle,
  Database,
  Gauge,
  Target,
} from "lucide-react"

// ─── types ──────────────────────────────────────────────────────────────────

type StepStatus = "pending" | "running" | "pass" | "warn" | "fail"

interface TestStep {
  id: string
  label: string
  description: string
  status: StepStatus
  durationMs?: number
  summary?: string
  error?: string
}

interface TestLog {
  id: number
  ts: number
  level: "info" | "ok" | "warn" | "err"
  msg: string
}

interface OverallReport {
  startedAt: number
  finishedAt?: number
  passed: number
  warned: number
  failed: number
  status: "idle" | "running" | "pass" | "partial" | "fail"
}

/** Shape of the values we pull from `/api/connections/progression/{id}/stats`. */
interface StatsSample {
  ts: number
  historic: {
    symbolsProcessed: number
    symbolsTotal: number
    candlesLoaded: number
    indicatorsCalculated: number
    cyclesCompleted: number
    isComplete: boolean
    progressPercent: number
    framesProcessed: number
  }
  realtime: {
    indicationCycles: number
    strategyCycles: number
    realtimeCycles: number
    indicationsTotal: number
    strategiesTotal: number
    positionsOpen: number
    avgCycleTimeMs: number
    successRate: number
    setsBase: number
    setsMain: number
    setsReal: number
    positionsOpened: number
    positionsClosed: number
    ordersPlaced: number
    ordersFilled: number
  }
  live: {
    ordersPlaced: number
    ordersFilled: number
    ordersFailed: number
    ordersRejected: number
    positionsCreated: number
    positionsClosed: number
    positionsOpen: number
    wins: number
    /** Cumulative leveraged notional (qty × price). Kept for back-compat. */
    volumeUsdTotal: number
    /** Cumulative used balance (margin = notional / leverage). The
     *  canonical "USDT" figure shown to operators. */
    marginUsdTotal: number
    fillRate: number
    winRate: number
    totalPnl: number
    avgPnl: number
    avgHoldMinutes: number
    profitFactor: number
  }
  phase: string
  engineRunning: boolean
}

// ─── constants ──────────────────────────────────────────────────────────────

const STEP_TIMEOUT_MS              = 25_000
const PROGRESSION_POLL_TIMEOUT_MS  = 30_000
const PROGRESSION_POLL_INTERVAL_MS = 2_000
const PREHISTORIC_WAIT_TIMEOUT_MS  = 90_000   // prehistoric should finish within 90s for 1 symbol
const PREHISTORIC_POLL_INTERVAL_MS = 3_000
const OBSERVATION_WINDOW_MS        = 5 * 60_000 // 5 minutes
const OBSERVATION_POLL_INTERVAL_MS = 5_000

const INITIAL_STEPS: Omit<TestStep, "status">[] = [
  { id: "P1", label: "Server Health",              description: "GET /api/health — verify dev server is responding." },
  { id: "P2", label: "QuickStart Preflight",       description: "GET /api/trade-engine/quick-start/ready — preconditions OK." },
  { id: "P3", label: "QuickStart Enable (1 sym)",  description: "POST /api/trade-engine/quick-start — enable with a single auto-picked top-volatile symbol." },
  { id: "P4", label: "Engine Progression",         description: "GET /api/trade-engine/progression — poll until the engine reports running." },
  { id: "P5", label: "Prehistoric Calculations",   description: "Wait for historic.isComplete & verify symbols / candles / indicators / cycles." },
  { id: "P6", label: "5-min Realtime + Live Trade", description: "Stream /stats every 5s for 5min — capture cycle rates, position churn, live PnL." },
  { id: "P7", label: "QuickStart Disable",         description: "POST /api/trade-engine/quick-start — clean teardown." },
]

// ─── helpers ────────────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    p.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}

async function jsonFetch(
  url: string,
  init?: RequestInit,
  timeoutMs = STEP_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await withTimeout(fetch(url, { cache: "no-store", ...init }), timeoutMs)
  let body: any = null
  try { body = await res.json() } catch { /* non-json */ }
  return { ok: res.ok, status: res.status, body }
}

function fmtMs(ms?: number): string {
  if (ms == null) return ""
  if (ms < 1_000)   return `${ms}ms`
  if (ms < 60_000)  return `${(ms / 1_000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1_000)
  return `${m}m${s.toString().padStart(2, "0")}s`
}

function fmtNum(n: number | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—"
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return digits > 0 ? n.toFixed(digits) : n.toString()
}

function fmtPct(n: number | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return `${n.toFixed(digits)}%`
}

function fmtUsd(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  const sign = n < 0 ? "-" : ""
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000)     return `${sign}$${(abs / 1_000).toFixed(2)}K`
  if (abs >= 1)         return `${sign}$${abs.toFixed(2)}`
  // Sub-dollar values (e.g. high-leverage margins like $0.04) need
  // extra precision — without this, fmtUsd rendered "$0.00" and the
  // operator couldn't tell zero from a few cents committed.
  if (abs > 0)          return `${sign}$${abs.toFixed(4)}`
  return "$0.00"
}

/** Normalise the `/stats` endpoint response into our sample shape. */
function parseStatsSample(body: any): StatsSample | null {
  if (!body || !body.success) return null
  const h  = body.historic       || {}
  const rt = body.realtime       || {}
  const le = body.liveExecution  || {}
  const sd = body.strategyDetail?.live || {}
  const md = body.metadata       || {}
  return {
    ts: Date.now(),
    historic: {
      symbolsProcessed:     Number(h.symbolsProcessed)     || 0,
      symbolsTotal:         Number(h.symbolsTotal)         || 0,
      candlesLoaded:        Number(h.candlesLoaded)        || 0,
      indicatorsCalculated: Number(h.indicatorsCalculated) || 0,
      cyclesCompleted:      Number(h.cyclesCompleted)      || 0,
      isComplete:           Boolean(h.isComplete),
      progressPercent:      Number(h.progressPercent)      || 0,
      framesProcessed:      Number(h.framesProcessed)      || 0,
    },
    realtime: {
      indicationCycles:  Number(rt.indicationCycles)  || 0,
      strategyCycles:    Number(rt.strategyCycles)    || 0,
      realtimeCycles:    Number(rt.realtimeCycles)    || 0,
      indicationsTotal:  Number(rt.indicationsTotal)  || 0,
      strategiesTotal:   Number(rt.strategiesTotal)   || 0,
      positionsOpen:     Number(rt.positionsOpen)     || 0,
      avgCycleTimeMs:    Number(rt.avgCycleTimeMs)    || 0,
      successRate:       Number(rt.successRate)       || 0,
      setsBase:          Number(rt.setsCreated?.base) || 0,
      setsMain:          Number(rt.setsCreated?.main) || 0,
      setsReal:          Number(rt.setsCreated?.real) || 0,
      positionsOpened:   Number(rt.positions?.opened) || 0,
      positionsClosed:   Number(rt.positions?.closed) || 0,
      ordersPlaced:      Number(rt.positions?.ordersPlaced) || 0,
      ordersFilled:      Number(rt.positions?.ordersFilled) || 0,
    },
    live: {
      ordersPlaced:     Number(le.ordersPlaced)     || 0,
      ordersFilled:     Number(le.ordersFilled)     || 0,
      ordersFailed:     Number(le.ordersFailed)     || 0,
      ordersRejected:   Number(le.ordersRejected)   || 0,
      positionsCreated: Number(le.positionsCreated) || 0,
      positionsClosed:  Number(le.positionsClosed)  || 0,
      positionsOpen:    Number(le.positionsOpen)    || 0,
      wins:             Number(le.wins)             || 0,
      volumeUsdTotal:   Number(le.volumeUsdTotal)   || 0,
      marginUsdTotal:   Number(le.marginUsdTotal)   || 0,
      fillRate:         Number(le.fillRate)         || 0,
      winRate:          Number(le.winRate)          || 0,
      totalPnl:         Number(sd.totalPnl)         || 0,
      avgPnl:           Number(sd.avgPnl)           || 0,
      avgHoldMinutes:   Number(sd.avgDrawdownTime)  || 0,
      profitFactor:     Number(sd.avgProfitFactor)  || 0,
    },
    phase: String(md.phase || ""),
    engineRunning: Boolean(md.engineRunning),
  }
}

// ─── Dialog ─────────────────────────────────────────────────────────────────

interface DialogProps {
  /** Render the provided trigger instead of the default icon button. */
  trigger?: React.ReactNode
  /** When true the test auto-starts as soon as the dialog opens. Default true. */
  autoRun?: boolean
}

export function EngineProgressionTestDialog({ trigger, autoRun = true }: DialogProps) {
  const [open, setOpen] = useState(false)
  const [steps, setSteps] = useState<TestStep[]>(
    () => INITIAL_STEPS.map((s) => ({ ...s, status: "pending" as const })),
  )
  const [logs, setLogs] = useState<TestLog[]>([])
  const [report, setReport] = useState<OverallReport>({
    startedAt: 0, passed: 0, warned: 0, failed: 0, status: "idle",
  })
  const [running, setRunning] = useState(false)

  // Observation-window live state
  const [observing, setObserving] = useState(false)
  const [obsStartedAt, setObsStartedAt] = useState<number | null>(null)
  const [obsRemainingMs, setObsRemainingMs] = useState<number>(OBSERVATION_WINDOW_MS)
  const [currentSample, setCurrentSample] = useState<StatsSample | null>(null)
  const [baselineSample, setBaselineSample] = useState<StatsSample | null>(null)
  const [finalSample, setFinalSample] = useState<StatsSample | null>(null)
  const [prehistoricSample, setPrehistoricSample] = useState<StatsSample | null>(null)
  const [connectionId, setConnectionId] = useState<string | null>(null)

  const logIdRef = useRef(0)
  const cancelledRef = useRef(false)
  const hasAutoRunRef = useRef(false)
  const logsEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [logs.length])

  // ── primitives ────────────────────────────────────────────────────────
  const pushLog = useCallback((level: TestLog["level"], msg: string) => {
    setLogs((prev) => [...prev, { id: logIdRef.current++, ts: Date.now(), level, msg }])
  }, [])

  const patchStep = useCallback((index: number, patch: Partial<TestStep>) => {
    setSteps((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], ...patch }
      return next
    })
  }, [])

  const resetAll = useCallback(() => {
    setSteps(INITIAL_STEPS.map((s) => ({ ...s, status: "pending" })))
    setLogs([])
    setReport({ startedAt: 0, passed: 0, warned: 0, failed: 0, status: "idle" })
    setCurrentSample(null)
    setBaselineSample(null)
    setFinalSample(null)
    setPrehistoricSample(null)
    setConnectionId(null)
    setObserving(false)
    setObsStartedAt(null)
    setObsRemainingMs(OBSERVATION_WINDOW_MS)
    logIdRef.current = 0
    cancelledRef.current = false
  }, [])

  // ── runner ────────────────────────────────────────────────────────────
  const runTest = useCallback(async () => {
    if (running) return
    resetAll()
    setRunning(true)
    const startedAt = Date.now()
    setReport({ startedAt, passed: 0, warned: 0, failed: 0, status: "running" })
    pushLog("info", "Starting extended engine progression test (boot → prehistoric → 5-min observation → disable)")

    let capturedConnId: string | null = null

    const markStep = (index: number, status: StepStatus, patch: Partial<TestStep>) => {
      patchStep(index, { ...patch, status })
      setReport((r) => ({
        ...r,
        passed: r.passed + (status === "pass" ? 1 : 0),
        warned: r.warned + (status === "warn" ? 1 : 0),
        failed: r.failed + (status === "fail" ? 1 : 0),
      }))
    }

    const run = async (
      index: number,
      fn: () => Promise<{ status: "pass" | "warn" | "fail"; summary?: string; error?: string }>,
    ): Promise<"pass" | "warn" | "fail"> => {
      if (cancelledRef.current) return "fail"
      const started = Date.now()
      patchStep(index, { status: "running" })
      const stepId = INITIAL_STEPS[index].id
      pushLog("info", `${stepId} ${INITIAL_STEPS[index].label} — running…`)
      try {
        const result = await fn()
        const durationMs = Date.now() - started
        markStep(index, result.status, { durationMs, summary: result.summary, error: result.error })
        pushLog(
          result.status === "pass" ? "ok" : result.status === "warn" ? "warn" : "err",
          `${stepId} ${result.status.toUpperCase()} in ${fmtMs(durationMs)}${result.summary ? ` — ${result.summary}` : ""}`,
        )
        return result.status
      } catch (err) {
        const durationMs = Date.now() - started
        const message = err instanceof Error ? err.message : String(err)
        markStep(index, "fail", { durationMs, error: message })
        pushLog("err", `${stepId} FAIL in ${fmtMs(durationMs)} — ${message}`)
        return "fail"
      }
    }

    // ── P1: health ───────────────────────────────────────────────────
    const p1 = await run(0, async () => {
      const r = await jsonFetch("/api/health")
      if (!r.ok) return { status: "fail", error: `HTTP ${r.status}` }
      return { status: "pass", summary: `OK (HTTP ${r.status})` }
    })
    if (p1 === "fail" || cancelledRef.current) return finish()

    // ── P2: preflight ────────────────────────────────────────────────
    await run(1, async () => {
      const r = await jsonFetch("/api/trade-engine/quick-start/ready")
      if (!r.ok) return { status: "warn", summary: `HTTP ${r.status}` }
      const ready = Boolean(r.body?.ready)
      return {
        status: ready ? "pass" : "warn",
        summary: ready ? "Preconditions OK" : `Not ready: ${r.body?.reason || "unknown"}`,
      }
    })
    if (cancelledRef.current) return finish()

    // ── P3: enable with 1 symbol ─────────────────────────────────────
    const p3 = await run(2, async () => {
      // Use `symbolCount` (an explicit number) instead of the legacy
      // `symbols: 1` ambiguity. The route accepted only string arrays
      // for `symbols` and crashed with "symbols.join is not a function"
      // when it received a number, which is why P3 failed every run.
      // The route now also normalizes both shapes defensively, but the
      // client should still send the right one.
      const r = await jsonFetch(
        "/api/trade-engine/quick-start",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "enable", symbolCount: 1 }),
        },
      )
      if (!r.ok || !r.body?.success) {
        return { status: "fail", error: r.body?.error || `HTTP ${r.status}` }
      }
      // Response shape: { connection: { id, symbols[] } } or legacy flat { connectionId, symbols }
      const connId = r.body?.connection?.id || r.body?.connectionId || null
      const symbols = Array.isArray(r.body?.connection?.symbols)
        ? r.body.connection.symbols
        : Array.isArray(r.body?.symbols) ? r.body.symbols : []
      capturedConnId = connId
      setConnectionId(connId)
      const symText = symbols.length > 0 ? symbols.slice(0, 3).join(", ") : "no symbols"
      return {
        status: symbols.length === 1 ? "pass" : "warn",
        summary: `${connId || "—"} · ${symbols.length} symbol(s): ${symText}`,
      }
    })
    if (p3 === "fail" || cancelledRef.current) return finish()

    // ── P4: poll progression ─────────────────────────────────────────
    await run(3, async () => {
      const pollStart = Date.now()
      let running = false
      let lastBody: any = null
      while (Date.now() - pollStart < PROGRESSION_POLL_TIMEOUT_MS) {
        if (cancelledRef.current) throw new Error("cancelled")
        const r = await jsonFetch("/api/trade-engine/progression")
        lastBody = r.body
        if (r.ok && r.body?.success && (r.body.runningEngines || 0) > 0) {
          running = true
          break
        }
        await new Promise((res) => setTimeout(res, PROGRESSION_POLL_INTERVAL_MS))
      }
      if (!running) {
        return {
          status: "warn",
          summary: `no running engines after ${(PROGRESSION_POLL_TIMEOUT_MS / 1000).toFixed(0)}s`,
        }
      }
      const conns = (lastBody?.connections || []) as any[]
      const active = conns.find((c) => c.isEngineRunning) || conns[0]
      return {
        status: "pass",
        summary: `running (${active?.connectionId || capturedConnId || "—"} · ${active?.engineState || "active"})`,
      }
    })
    if (cancelledRef.current) return finish()

    // ── P5: prehistoric calc verification ────────────────────────────
    await run(4, async () => {
      if (!capturedConnId) return { status: "fail", error: "no connectionId from P3" }
      const pollStart = Date.now()
      let lastSample: StatsSample | null = null
      while (Date.now() - pollStart < PREHISTORIC_WAIT_TIMEOUT_MS) {
        if (cancelledRef.current) throw new Error("cancelled")
        const r = await jsonFetch(`/api/connections/progression/${capturedConnId}/stats`)
        const sample = parseStatsSample(r.body)
        if (sample) {
          lastSample = sample
          setPrehistoricSample(sample)
          setCurrentSample(sample)
          if (sample.historic.isComplete) break
        }
        await new Promise((res) => setTimeout(res, PREHISTORIC_POLL_INTERVAL_MS))
      }
      if (!lastSample) return { status: "fail", error: "stats endpoint returned no samples" }

      const h = lastSample.historic
      const issues: string[] = []
      if (!h.isComplete)               issues.push("not complete")
      if (h.symbolsProcessed <= 0)     issues.push("no symbols processed")
      if (h.candlesLoaded <= 0)        issues.push("no candles loaded")
      if (h.indicatorsCalculated <= 0) issues.push("no indicators calculated")
      if (h.cyclesCompleted <= 0)      issues.push("no cycles")

      const summary =
        `syms ${h.symbolsProcessed}/${h.symbolsTotal} · ` +
        `candles ${fmtNum(h.candlesLoaded)} · ` +
        `indicators ${fmtNum(h.indicatorsCalculated)} · ` +
        `cycles ${h.cyclesCompleted} · ` +
        `frames ${fmtNum(h.framesProcessed)}`

      if (issues.length === 0) return { status: "pass", summary }
      if (h.symbolsProcessed > 0 && h.candlesLoaded > 0) {
        return { status: "warn", summary: `${summary} · ${issues.join(", ")}` }
      }
      return { status: "fail", summary, error: issues.join(", ") }
    })
    if (cancelledRef.current) return finish()

    // ── P6: 5-minute observation window ──────────────────────────────
    await run(5, async () => {
      if (!capturedConnId) return { status: "fail", error: "no connectionId from P3" }

      // Capture baseline first
      const baseRes = await jsonFetch(`/api/connections/progression/${capturedConnId}/stats`)
      const baseline = parseStatsSample(baseRes.body)
      if (!baseline) return { status: "fail", error: "baseline /stats returned no sample" }
      setBaselineSample(baseline)
      setCurrentSample(baseline)

      // Start the live observation UI
      const obsStart = Date.now()
      setObserving(true)
      setObsStartedAt(obsStart)
      setObsRemainingMs(OBSERVATION_WINDOW_MS)
      pushLog(
        "info",
        `Observation window started (${(OBSERVATION_WINDOW_MS / 60_000).toFixed(0)} min, polling every ${(OBSERVATION_POLL_INTERVAL_MS / 1000).toFixed(0)}s)`,
      )

      let last: StatsSample = baseline
      while (Date.now() - obsStart < OBSERVATION_WINDOW_MS) {
        if (cancelledRef.current) break
        // Sleep first so we honour the poll interval and don't blast the server
        await new Promise((res) => setTimeout(res, OBSERVATION_POLL_INTERVAL_MS))
        setObsRemainingMs(Math.max(0, OBSERVATION_WINDOW_MS - (Date.now() - obsStart)))

        try {
          const r = await jsonFetch(`/api/connections/progression/${capturedConnId}/stats`, undefined, 10_000)
          const sample = parseStatsSample(r.body)
          if (!sample) continue
          setCurrentSample(sample)
          last = sample
        } catch (err) {
          pushLog("warn", `stats poll failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      setObsRemainingMs(0)
      setObserving(false)
      setFinalSample(last)

      const rtDelta    = last.realtime.indicationCycles - baseline.realtime.indicationCycles
      const strDelta   = last.realtime.strategyCycles   - baseline.realtime.strategyCycles
      const rtcDelta   = last.realtime.realtimeCycles   - baseline.realtime.realtimeCycles
      const posOpened  = last.realtime.positionsOpened  - baseline.realtime.positionsOpened
      const posClosed  = last.realtime.positionsClosed  - baseline.realtime.positionsClosed
      const liveOrdersPlaced = last.live.ordersPlaced    - baseline.live.ordersPlaced
      const liveOrdersFilled = last.live.ordersFilled    - baseline.live.ordersFilled
      const liveClosed       = last.live.positionsClosed - baseline.live.positionsClosed

      const summary =
        `ind Δ${rtDelta} · strat Δ${strDelta} · rt Δ${rtcDelta} · ` +
        `pos ±${posOpened}/-${posClosed} · orders ${liveOrdersFilled}/${liveOrdersPlaced} fill · ` +
        `live closed ${liveClosed}`

      const issues: string[] = []
      if (rtDelta  <= 0) issues.push("no indication cycle progression")
      if (strDelta <= 0) issues.push("no strategy cycle progression")
      if (!last.engineRunning) issues.push("engine stopped")

      if (issues.length === 0) return { status: "pass", summary }
      if (rtDelta > 0 || strDelta > 0) return { status: "warn", summary: `${summary} · ${issues.join(", ")}` }
      return { status: "fail", summary, error: issues.join(", ") }
    })
    if (cancelledRef.current) return finish()

    // ── P7: disable ──────────────────────────────────────────────────
    await run(6, async () => {
      const r = await jsonFetch(
        "/api/trade-engine/quick-start",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "disable", connectionId: capturedConnId || undefined }),
        },
      )
      if (!r.ok) return { status: "warn", summary: `HTTP ${r.status}` }
      return { status: "pass", summary: r.body?.message || "disabled" }
    })

    finish()

    function finish() {
      setObserving(false)
      setReport((prev) => {
        const finishedAt = Date.now()
        const failedGate = prev.failed > 0
        const warnGate   = prev.warned > 0
        return {
          ...prev,
          finishedAt,
          status: failedGate
            ? prev.passed > 0 ? "partial" : "fail"
            : warnGate     ? "partial" : "pass",
        }
      })
      setRunning(false)
      pushLog("info", "Test complete")
    }
  }, [patchStep, pushLog, resetAll, running])

  // ── auto-run on open ──────────────────────────────────────────────────
  useEffect(() => {
    if (open && autoRun && !hasAutoRunRef.current && !running) {
      hasAutoRunRef.current = true
      runTest()
    }
    if (!open) {
      hasAutoRunRef.current = false
    }
  }, [open, autoRun, running, runTest])

  // ── derived UI state ──────────────────────────────────────────────────
  const completedCount = useMemo(
    () => steps.filter((s) => s.status !== "pending" && s.status !== "running").length,
    [steps],
  )
  const progressPct = Math.round((completedCount / steps.length) * 100)

  const deltas = useMemo(() => {
    if (!baselineSample || !currentSample) return null
    return {
      indications: currentSample.realtime.indicationCycles - baselineSample.realtime.indicationCycles,
      strategies:  currentSample.realtime.strategyCycles   - baselineSample.realtime.strategyCycles,
      realtime:    currentSample.realtime.realtimeCycles   - baselineSample.realtime.realtimeCycles,
      positionsOpened:  currentSample.realtime.positionsOpened - baselineSample.realtime.positionsOpened,
      positionsClosed:  currentSample.realtime.positionsClosed - baselineSample.realtime.positionsClosed,
      liveOrdersPlaced: currentSample.live.ordersPlaced       - baselineSample.live.ordersPlaced,
      liveOrdersFilled: currentSample.live.ordersFilled       - baselineSample.live.ordersFilled,
      livePnlDelta:     currentSample.live.totalPnl           - baselineSample.live.totalPnl,
    }
  }, [baselineSample, currentSample])

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next && running) {
      cancelledRef.current = true
      setRunning(false)
      setObserving(false)
      pushLog("warn", "Test cancelled (dialog closed)")
    }
    setOpen(next)
  }, [running, pushLog])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px] px-2">
            <FlaskConical className="w-3 h-3" />
            Test
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="max-w-4xl max-h-[92vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <FlaskConical className="w-4 h-4" />
            Engine Progression · Prehistoric + 5-min Live Observation
          </DialogTitle>
          <DialogDescription className="text-xs">
            Quick-starts one symbol, verifies prehistoric calculations, streams realtime &amp; live-trade
            metrics for 5 minutes, then tears down cleanly. All captured data is shown in the Results
            panel at the bottom.
          </DialogDescription>
        </DialogHeader>

        {/* Progress bar + report badges */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <ReportBadge report={report} />
              {report.status !== "idle" && (
                <>
                  <Badge variant="outline" className="text-[10px] font-mono">
                    pass {report.passed} · warn {report.warned} · fail {report.failed}
                  </Badge>
                  {report.finishedAt && (
                    <Badge variant="outline" className="text-[10px] font-mono">
                      total {fmtMs(report.finishedAt - report.startedAt)}
                    </Badge>
                  )}
                  {connectionId && (
                    <Badge variant="outline" className="text-[10px] font-mono">
                      {connectionId}
                    </Badge>
                  )}
                </>
              )}
            </div>
            <span className="text-xs text-muted-foreground tabular-nums">{progressPct}%</span>
          </div>
          <Progress value={progressPct} className="h-1.5" />
        </div>

        <Separator />

        <ScrollArea className="flex-1 min-h-0 pr-3">
          <div className="space-y-3">
            {/* Steps */}
            <div className="space-y-2">
              {steps.map((step) => (
                <StepRow key={step.id} step={step} />
              ))}
            </div>

            {/* Live observation panel — mounted during P6 */}
            {observing && (
              <ObservationPanel
                startedAt={obsStartedAt!}
                remainingMs={obsRemainingMs}
                totalMs={OBSERVATION_WINDOW_MS}
                baseline={baselineSample}
                current={currentSample}
                deltas={deltas}
              />
            )}

            {/* Results panel — shown after observation completes */}
            {finalSample && !observing && (
              <ResultsPanel
                prehistoric={prehistoricSample}
                baseline={baselineSample}
                final={finalSample}
                deltas={deltas}
                observationMs={OBSERVATION_WINDOW_MS}
              />
            )}

            {/* Live log tail */}
            {logs.length > 0 && (
              <Card className="p-3 bg-muted/40 border-muted">
                <div className="flex items-center gap-2 text-[11px] font-semibold text-muted-foreground mb-1.5">
                  <Activity className="w-3 h-3" />
                  Live Log
                </div>
                <div className="font-mono text-[10.5px] leading-relaxed space-y-0.5 max-h-48 overflow-auto">
                  {logs.map((l) => (
                    <div
                      key={l.id}
                      className={
                        l.level === "ok"   ? "text-emerald-600 dark:text-emerald-400"
                      : l.level === "warn" ? "text-amber-600  dark:text-amber-400"
                      : l.level === "err"  ? "text-red-600    dark:text-red-400"
                                           : "text-foreground/70"
                      }
                    >
                      <span className="text-muted-foreground mr-1.5 tabular-nums">
                        {new Date(l.ts).toLocaleTimeString(undefined, { hour12: false })}
                      </span>
                      {l.msg}
                    </div>
                  ))}
                  <div ref={logsEndRef} />
                </div>
              </Card>
            )}
          </div>
        </ScrollArea>

        <Separator />

        {/* Controls */}
        <div className="flex items-center justify-between gap-2 pt-1 flex-wrap">
          <p className="text-[11px] text-muted-foreground">
            Boot → prehistoric → 5-min observation → disable. Close the dialog anytime to cancel.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm" variant="outline"
              onClick={resetAll}
              disabled={running}
              className="h-7 text-xs px-2 gap-1"
            >
              <RefreshCw className="w-3 h-3" />
              Reset
            </Button>
            <Button
              size="sm"
              onClick={runTest}
              disabled={running}
              className="h-7 text-xs px-3 gap-1"
            >
              {running
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <Play className="w-3 h-3" />
              }
              {running ? "Running…" : report.status === "idle" ? "Run Test" : "Re-run"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Convenience trigger ────────────────────────────────────────────────────

interface ButtonProps {
  variant?: "sm" | "header"
  className?: string
}

export function EngineProgressionTestButton({ variant = "sm", className }: ButtonProps) {
  const trigger =
    variant === "header" ? (
      <Button
        size="sm" variant="outline"
        className={`h-8 gap-1.5 text-xs px-2.5 border-primary/30 bg-primary/5 hover:bg-primary/10 text-primary ${className ?? ""}`}
      >
        <FlaskConical className="w-3.5 h-3.5" />
        Run Engine Test
      </Button>
    ) : (
      <Button
        size="sm" variant="outline"
        className={`h-7 gap-1 text-[11px] px-2 ${className ?? ""}`}
      >
        <FlaskConical className="w-3 h-3" />
        Engine Test
      </Button>
    )

  return <EngineProgressionTestDialog trigger={trigger} />
}

// ─── Step row / badges / icons ──────────────────────────────────────────────

function StepRow({ step }: { step: TestStep }) {
  const tone =
    step.status === "pass"    ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/40 dark:bg-emerald-950/10"
  : step.status === "warn"    ? "border-amber-200   bg-amber-50/60   dark:border-amber-900/40   dark:bg-amber-950/10"
  : step.status === "fail"    ? "border-red-200     bg-red-50/50     dark:border-red-900/40     dark:bg-red-950/10"
  : step.status === "running" ? "border-primary/40  bg-primary/5"
                              : ""

  return (
    <Card className={`p-3 border transition-colors ${tone}`}>
      <div className="flex items-start gap-3">
        <StatusIcon status={step.status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[10px] font-mono font-semibold text-muted-foreground">{step.id}</span>
              <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
              <span className="text-xs font-medium truncate">{step.label}</span>
            </div>
            {step.durationMs != null && (
              <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{fmtMs(step.durationMs)}</span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{step.description}</p>
          {step.summary && (
            <p className="text-[11px] font-mono mt-1.5 text-foreground/80 break-words">{step.summary}</p>
          )}
          {step.error && (
            <p className="text-[11px] font-mono mt-1.5 text-red-600 dark:text-red-400 break-all">{step.error}</p>
          )}
        </div>
      </div>
    </Card>
  )
}

function StatusIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case "running": return <Loader2 className="w-4 h-4 animate-spin text-primary shrink-0 mt-0.5" />
    case "pass":    return <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
    case "warn":    return <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
    case "fail":    return <XCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
    default:        return <Clock className="w-4 h-4 text-muted-foreground/50 shrink-0 mt-0.5" />
  }
}

function ReportBadge({ report }: { report: OverallReport }) {
  const base = "text-[10px] font-semibold px-1.5"
  switch (report.status) {
    case "running": return <Badge className={`${base} bg-primary text-primary-foreground`}>RUNNING</Badge>
    case "pass":    return <Badge className={`${base} bg-emerald-600 text-white hover:bg-emerald-600`}>PASS</Badge>
    case "partial": return <Badge className={`${base} bg-amber-500  text-white hover:bg-amber-500`}>PARTIAL</Badge>
    case "fail":    return <Badge className={`${base} bg-red-600    text-white hover:bg-red-600`}>FAIL</Badge>
    default:        return <Badge variant="outline" className={base}>IDLE</Badge>
  }
}

// ─── Observation panel (visible during the 5-min window) ───────────────────

function ObservationPanel({
  startedAt, remainingMs, totalMs, baseline, current, deltas,
}: {
  startedAt: number
  remainingMs: number
  totalMs: number
  baseline: StatsSample | null
  current: StatsSample | null
  deltas: {
    indications: number; strategies: number; realtime: number
    positionsOpened: number; positionsClosed: number
    liveOrdersPlaced: number; liveOrdersFilled: number
    livePnlDelta: number
  } | null
}) {
  const elapsedMs = Math.min(totalMs, Date.now() - startedAt)
  const progressPct = Math.round((elapsedMs / totalMs) * 100)
  const elapsedMin = elapsedMs / 60_000
  const rate = (delta: number) => (elapsedMin > 0 ? delta / elapsedMin : 0)

  return (
    <Card className="p-4 border-primary/40 bg-primary/5">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div className="flex items-center gap-2">
          <TimerReset className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">Live Observation</span>
          <Badge className="bg-primary text-primary-foreground text-[10px] font-mono">STREAMING</Badge>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-mono tabular-nums">
          <span className="text-muted-foreground">elapsed</span>
          <span className="font-semibold">{fmtMs(elapsedMs)}</span>
          <span className="text-muted-foreground">/ {fmtMs(totalMs)}</span>
          <span className="text-muted-foreground">·</span>
          <span className="font-semibold">{fmtMs(remainingMs)}</span>
          <span className="text-muted-foreground">left</span>
        </div>
      </div>

      <Progress value={progressPct} className="h-1.5 mb-4" />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <MetricCard
          icon={<Gauge className="w-3 h-3" />}
          label="Indication Cycles"
          value={fmtNum(current?.realtime.indicationCycles)}
          delta={deltas ? `Δ${deltas.indications} (${rate(deltas.indications).toFixed(1)}/min)` : undefined}
          tone="primary"
        />
        <MetricCard
          icon={<Gauge className="w-3 h-3" />}
          label="Strategy Cycles"
          value={fmtNum(current?.realtime.strategyCycles)}
          delta={deltas ? `Δ${deltas.strategies} (${rate(deltas.strategies).toFixed(1)}/min)` : undefined}
          tone="primary"
        />
        <MetricCard
          icon={<Activity className="w-3 h-3" />}
          label="Realtime Ticks"
          value={fmtNum(current?.realtime.realtimeCycles)}
          delta={deltas ? `Δ${deltas.realtime}` : undefined}
          tone="primary"
        />
        <MetricCard
          icon={<Clock className="w-3 h-3" />}
          label="Avg Cycle"
          value={`${fmtNum(current?.realtime.avgCycleTimeMs)}ms`}
          tone="neutral"
        />

        <MetricCard
          icon={<Target className="w-3 h-3" />}
          label="Positions Open"
          value={fmtNum(current?.realtime.positionsOpen)}
          delta={deltas ? `+${deltas.positionsOpened} / -${deltas.positionsClosed}` : undefined}
          tone="neutral"
        />
        <MetricCard
          icon={<TrendingUp className="w-3 h-3" />}
          label="Orders Filled"
          value={`${fmtNum(current?.live.ordersFilled)} / ${fmtNum(current?.live.ordersPlaced)}`}
          delta={deltas ? `+${deltas.liveOrdersFilled} / +${deltas.liveOrdersPlaced}` : undefined}
          tone="neutral"
        />
        <MetricCard
          icon={<Target className="w-3 h-3" />}
          label="Fill Rate"
          value={fmtPct(current?.live.fillRate)}
          tone={current && current.live.fillRate >= 70 ? "ok" : "warn"}
        />
        <MetricCard
          icon={<TrendingUp className="w-3 h-3" />}
          label="Live PnL"
          value={fmtUsd(current?.live.totalPnl)}
          delta={deltas ? `Δ ${fmtUsd(deltas.livePnlDelta)}` : undefined}
          tone={
            (current?.live.totalPnl ?? 0) > 0 ? "ok"
          : (current?.live.totalPnl ?? 0) < 0 ? "bad"
                                              : "neutral"
          }
        />
      </div>
    </Card>
  )
}

function MetricCard({
  icon, label, value, delta, tone = "neutral",
}: {
  icon: React.ReactNode
  label: string
  value: string
  delta?: string
  tone?: "primary" | "neutral" | "ok" | "warn" | "bad"
}) {
  const toneClass =
    tone === "primary" ? "text-primary"
  : tone === "ok"      ? "text-emerald-600 dark:text-emerald-400"
  : tone === "warn"    ? "text-amber-600 dark:text-amber-400"
  : tone === "bad"     ? "text-red-600 dark:text-red-400"
                       : "text-foreground"
  return (
    <div className="rounded-md border border-border/60 bg-background/60 px-2.5 py-1.5">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className={`text-sm font-semibold font-mono tabular-nums ${toneClass}`}>{value}</div>
      {delta && (
        <div className="text-[10px] font-mono tabular-nums text-muted-foreground mt-0.5">{delta}</div>
      )}
    </div>
  )
}

// ─── Final results panel ────────────────────────────────────────────────────

function ResultsPanel({
  prehistoric, baseline, final, deltas, observationMs,
}: {
  prehistoric: StatsSample | null
  baseline: StatsSample | null
  final: StatsSample | null
  deltas: {
    indications: number; strategies: number; realtime: number
    positionsOpened: number; positionsClosed: number
    liveOrdersPlaced: number; liveOrdersFilled: number
    livePnlDelta: number
  } | null
  observationMs: number
}) {
  if (!final) return null
  const h  = prehistoric?.historic || final.historic
  const rt = final.realtime
  const le = final.live
  const mins = observationMs / 60_000 || 1

  const rate = (delta: number) => (delta / mins)

  return (
    <Card className="p-4 border-emerald-200 dark:border-emerald-900/40 bg-emerald-50/30 dark:bg-emerald-950/10">
      <div className="flex items-center gap-2 mb-3">
        <CheckCircle2 className="w-4 h-4 text-emerald-600" />
        <span className="text-sm font-semibold">Final Results</span>
        <Badge variant="outline" className="text-[10px] font-mono ml-auto">
          {fmtMs(observationMs)} window
        </Badge>
      </div>

      <div className="space-y-4">
        {/* Prehistoric */}
        <ResultSection icon={<Database className="w-3.5 h-3.5" />} title="Prehistoric Calculations">
          <ResultRow label="Symbols Processed"      value={`${h.symbolsProcessed} / ${h.symbolsTotal}`} />
          <ResultRow label="Candles Loaded"          value={fmtNum(h.candlesLoaded)} />
          <ResultRow label="Indicators Calculated"   value={fmtNum(h.indicatorsCalculated)} />
          <ResultRow label="Cycles Completed"        value={fmtNum(h.cyclesCompleted)} />
          <ResultRow label="Frames Processed"        value={fmtNum(h.framesProcessed)} />
          <ResultRow label="Status"                   value={h.isComplete ? "Complete" : `${h.progressPercent}%`}
                     tone={h.isComplete ? "ok" : "warn"} />
        </ResultSection>

        {/* Realtime over the 5-min window */}
        <ResultSection icon={<Gauge className="w-3.5 h-3.5" />} title={`Realtime Processing — ${fmtMs(observationMs)} window`}>
          <ResultRow label="Indication Cycles"  value={fmtNum(rt.indicationCycles)}
                     delta={deltas ? `Δ${deltas.indications} (${rate(deltas.indications).toFixed(1)}/min)` : undefined} />
          <ResultRow label="Strategy Cycles"    value={fmtNum(rt.strategyCycles)}
                     delta={deltas ? `Δ${deltas.strategies} (${rate(deltas.strategies).toFixed(1)}/min)` : undefined} />
          <ResultRow label="Realtime Ticks"     value={fmtNum(rt.realtimeCycles)}
                     delta={deltas ? `Δ${deltas.realtime}` : undefined} />
          <ResultRow label="Indications Total"  value={fmtNum(rt.indicationsTotal)} />
          <ResultRow label="Strategies Total"   value={fmtNum(rt.strategiesTotal)} />
          <ResultRow label="Sets — Base/Main/Real" value={`${fmtNum(rt.setsBase)} / ${fmtNum(rt.setsMain)} / ${fmtNum(rt.setsReal)}`} />
          <ResultRow label="Avg Cycle Time"     value={`${fmtNum(rt.avgCycleTimeMs)} ms`} />
          <ResultRow label="Success Rate"       value={fmtPct(rt.successRate)}
                     tone={rt.successRate >= 95 ? "ok" : rt.successRate >= 80 ? "warn" : "bad"} />
        </ResultSection>

        {/* Live execution */}
        <ResultSection icon={<TrendingUp className="w-3.5 h-3.5" />} title="Live Trade Execution">
          <ResultRow label="Orders Placed"    value={fmtNum(le.ordersPlaced)}
                     delta={deltas ? `Δ${deltas.liveOrdersPlaced}` : undefined} />
          <ResultRow label="Orders Filled"    value={fmtNum(le.ordersFilled)}
                     delta={deltas ? `Δ${deltas.liveOrdersFilled}` : undefined} />
          <ResultRow label="Orders Failed"    value={fmtNum(le.ordersFailed + le.ordersRejected)}
                     tone={(le.ordersFailed + le.ordersRejected) === 0 ? "ok" : "warn"} />
          <ResultRow label="Fill Rate"        value={fmtPct(le.fillRate)}
                     tone={le.fillRate >= 70 ? "ok" : le.fillRate >= 40 ? "warn" : "bad"} />
          <ResultRow label="Positions Created" value={fmtNum(le.positionsCreated)} />
          <ResultRow label="Positions Closed"  value={fmtNum(le.positionsClosed)} />
          <ResultRow label="Positions Open"    value={fmtNum(le.positionsOpen)} />
          <ResultRow label="Wins"              value={`${fmtNum(le.wins)} (${fmtPct(le.winRate)})`}
                     tone={le.winRate >= 50 ? "ok" : "warn"} />
          <ResultRow label="Total PnL"         value={fmtUsd(le.totalPnl)}
                     delta={deltas ? `Δ ${fmtUsd(deltas.livePnlDelta)}` : undefined}
                     tone={le.totalPnl > 0 ? "ok" : le.totalPnl < 0 ? "bad" : "neutral"} />
          <ResultRow label="Avg PnL / Trade"   value={fmtUsd(le.avgPnl)} />
          <ResultRow label="Avg Hold Time"     value={`${le.avgHoldMinutes.toFixed(1)} min`} />
          <ResultRow label="Profit Factor"     value={le.profitFactor >= 999 ? "∞" : le.profitFactor.toFixed(2)}
                     tone={le.profitFactor >= 1.5 ? "ok" : le.profitFactor >= 1 ? "warn" : "bad"} />
          {/*
           * USDT row shows the *used balance* (capital committed = sum of
           * notional/leverage), NOT the leveraged notional. The notional
           * is preserved in the tooltip for operators who need it for
           * exchange-margin calculations.
           */}
          <ResultRow
            label="USDT (used)"
            value={fmtUsd(le.marginUsdTotal || le.volumeUsdTotal)}
            tooltip={
              le.marginUsdTotal > 0
                ? `Margin committed: ${fmtUsd(le.marginUsdTotal)}\nLeveraged notional: ${fmtUsd(le.volumeUsdTotal)}`
                : `Leveraged notional: ${fmtUsd(le.volumeUsdTotal)} (margin counter not yet populated)`
            }
          />
        </ResultSection>
      </div>
    </Card>
  )
}

function ResultSection({
  icon, title, children,
}: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
        {icon}
        {title}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
        {children}
      </div>
    </div>
  )
}

function ResultRow({
  label, value, delta, tone = "neutral", tooltip,
}: {
  label: string
  value: string
  delta?: string
  tone?: "ok" | "warn" | "bad" | "neutral"
  /**
   * Native title attribute applied to the row wrapper. Used to expose
   * extra context (e.g. "leveraged notional vs used margin") without
   * cluttering the dense KPI grid.
   */
  tooltip?: string
}) {
  const toneClass =
    tone === "ok"   ? "text-emerald-600 dark:text-emerald-400"
  : tone === "warn" ? "text-amber-600 dark:text-amber-400"
  : tone === "bad"  ? "text-red-600 dark:text-red-400"
                    : "text-foreground"
  return (
    <div
      className="flex items-baseline justify-between gap-2 text-[11px]"
      title={tooltip}
    >
      <span className="text-muted-foreground truncate">{label}</span>
      <span className={`font-mono font-semibold tabular-nums ${toneClass}`}>
        {value}
        {delta && <span className="text-muted-foreground font-normal ml-1.5">({delta})</span>}
      </span>
    </div>
  )
}

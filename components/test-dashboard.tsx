'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  Play,
  Square,
  RotateCcw,
  Activity,
  Cpu,
  Database,
  TrendingUp,
  Layers,
  Zap,
  BarChart2,
  RefreshCw,
  AlertCircle,
  CheckCircle,
  Clock,
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface StatsPayload {
  success: boolean
  connectionId: string
  historic: {
    symbolsProcessed: number
    symbolsTotal: number
    candlesLoaded: number
    indicatorsCalculated: number
    cyclesCompleted: number
    isComplete: boolean
    progressPercent: number
    avgProfitFactor: number
  }
  realtime: {
    indicationCycles: number
    strategyCycles: number
    realtimeCycles: number
    indicationsTotal: number
    strategiesTotal: number
    positionsOpen: number
    setsCreated: { base: number; main: number; real: number; total: number }
    isActive: boolean
    successRate: number
    avgCycleTimeMs: number
  }
  breakdown: {
    indications: { total: number; direction: number; move: number }
    strategies: {
      base: number; main: number; real: number; live: number; total: number
      baseEvaluated: number; mainEvaluated: number; realEvaluated: number
    }
  }
  metadata: {
    engineRunning: boolean
    phase: string
    progress: number
    message: string
    lastUpdate: string
    redisDbEntries: number
  }
  liveExecution: {
    ordersPlaced: number
    ordersFilled: number
    ordersRejected: number
    ordersSimulated: number
    positionsCreated: number
    positionsClosed: number
    positionsOpen: number
    wins: number
    fillRate: number
    winRate: number
    volumeUsdTotal: number
  }
  openPositions: {
    pseudo: { open: number; runningSets: number }
    real: { open: number; activeAvg: number; activeSamples: number }
    live: { open: number; volumeUsd: number; marginUsd: number }
  }
  stageEvalPercent: { base: number; main: number; real: number }
}

interface DebugConfig {
  enabled: boolean
  verbose: boolean
  logIndications: boolean
  logStrategies: boolean
  logPositions: boolean
  logMarketData: boolean
  logRedis: boolean
  logAPI: boolean
  logErrors: boolean
}

interface LogEntry {
  ts: string
  msg: string
  level: 'info' | 'warn' | 'error' | 'ok'
}

const CONN_ID = 'bingx-x01'
const POLL_MS = 2000

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toLocaleTimeString('en-US', { hour12: false })
}

function fmt(n: number | undefined | null, decimals = 0) {
  if (n == null || isNaN(n)) return '—'
  return n.toLocaleString(undefined, { maximumFractionDigits: decimals })
}

function phaseColor(phase: string) {
  if (phase === 'live_trading') return 'bg-green-500'
  if (phase === 'prehistoric' || phase === 'indication') return 'bg-blue-500'
  if (phase === 'stopped' || phase === 'idle') return 'bg-slate-400'
  if (phase === 'error') return 'bg-red-500'
  return 'bg-amber-400'
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: string | number
  sub?: string
  accent?: boolean
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 flex flex-col gap-0.5 ${
        accent ? 'border-green-400/60 bg-green-50 dark:bg-green-950/40' : 'border-border bg-card'
      }`}
    >
      <span className='text-[10px] font-medium text-muted-foreground uppercase tracking-wide leading-none'>
        {label}
      </span>
      <span className={`text-lg font-bold leading-tight ${accent ? 'text-green-700 dark:text-green-400' : 'text-foreground'}`}>
        {value}
      </span>
      {sub && <span className='text-[10px] text-muted-foreground leading-none'>{sub}</span>}
    </div>
  )
}

function StageBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0
  return (
    <div className='space-y-0.5'>
      <div className='flex justify-between text-xs'>
        <span className='font-medium text-muted-foreground'>{label}</span>
        <span className='font-bold text-foreground tabular-nums'>{fmt(value)}</span>
      </div>
      <div className='h-1.5 rounded-full bg-muted overflow-hidden'>
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function DebugToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className='flex items-center justify-between py-1.5 border-b border-border/50 last:border-0'>
      <Label className='text-sm font-normal capitalize'>{label.replace(/([A-Z])/g, ' $1').trim()}</Label>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function TestDashboard() {
  const [stats, setStats] = useState<StatsPayload | null>(null)
  const [debugConfig, setDebugConfig] = useState<DebugConfig>({
    enabled: false,
    verbose: false,
    logIndications: false,
    logStrategies: false,
    logPositions: false,
    logMarketData: false,
    logRedis: false,
    logAPI: false,
    logErrors: true,
  })
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [polling, setPolling] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const logsEndRef = useRef<HTMLDivElement>(null)

  const addLog = useCallback((msg: string, level: LogEntry['level'] = 'info') => {
    setLogs(prev => {
      const next = [...prev, { ts: ts(), msg, level }]
      return next.length > 300 ? next.slice(-300) : next
    })
  }, [])

  // ── Fetch stats ──────────────────────────────────────────────────────────
  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`/api/connections/progression/${CONN_ID}/stats`)
      if (!res.ok) {
        addLog(`Stats ${res.status}: ${res.statusText}`, 'warn')
        return
      }
      const data: StatsPayload = await res.json()
      setStats(data)
    } catch (e) {
      addLog(`Stats fetch error: ${e}`, 'error')
    }
  }, [addLog])

  // ── Poll toggle ──────────────────────────────────────────────────────────
  const startPolling = useCallback(() => {
    if (pollRef.current) return
    fetchStats()
    pollRef.current = setInterval(fetchStats, POLL_MS)
    setPolling(true)
    addLog('Live polling started (2s interval)', 'ok')
  }, [fetchStats, addLog])

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    setPolling(false)
    addLog('Live polling stopped', 'info')
  }, [addLog])

  // Always poll while mounted so the UI stays live
  useEffect(() => {
    startPolling()
    return () => stopPolling()
  }, [])

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  // ── Engine controls ──────────────────────────────────────────────────────
  const engineStart = async () => {
    setActionLoading('start')
    addLog('Sending engine start…', 'info')
    try {
      const res = await fetch('/api/trade-engine/start', { method: 'POST' })
      const d = await res.json()
      addLog(d.success ? 'Engine start accepted' : `Start failed: ${d.error ?? d.message}`, d.success ? 'ok' : 'error')
    } catch (e) {
      addLog(`Start error: ${e}`, 'error')
    }
    setActionLoading(null)
  }

  const engineStop = async () => {
    setActionLoading('stop')
    addLog('Sending engine stop…', 'info')
    try {
      const res = await fetch('/api/trade-engine/stop', { method: 'POST' })
      const d = await res.json()
      addLog(d.success ? 'Engine stop accepted' : `Stop failed: ${d.error ?? d.message}`, d.success ? 'ok' : 'error')
    } catch (e) {
      addLog(`Stop error: ${e}`, 'error')
    }
    setActionLoading(null)
  }

  const engineRestart = async () => {
    setActionLoading('restart')
    addLog('Restarting engine (stop → start)…', 'info')
    try {
      await fetch('/api/trade-engine/stop', { method: 'POST' })
      await new Promise(r => setTimeout(r, 1500))
      const res = await fetch('/api/trade-engine/start', { method: 'POST' })
      const d = await res.json()
      addLog(d.success ? 'Engine restarted' : `Restart failed: ${d.error}`, d.success ? 'ok' : 'error')
    } catch (e) {
      addLog(`Restart error: ${e}`, 'error')
    }
    setActionLoading(null)
  }

  const clearProgressions = async () => {
    setActionLoading('clear')
    addLog('Clearing progressions (full reset)…', 'warn')
    try {
      const res = await fetch('/api/admin/clear-progressions', { method: 'POST' })
      const d = await res.json()
      addLog(d.success ? 'Progressions cleared — restart engine for fresh run' : `Clear failed: ${d.error}`, d.success ? 'ok' : 'error')
    } catch (e) {
      addLog(`Clear error: ${e}`, 'error')
    }
    setActionLoading(null)
  }

  // ── Debug controls ───────────────────────────────────────────────────────
  const toggleDebug = async () => {
    const next = !debugConfig.enabled
    try {
      const res = await fetch('/api/debug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: next ? 'enable' : 'disable', verbose: true }),
      })
      const d = await res.json()
      if (d.config) setDebugConfig(d.config)
      addLog(`Debug mode ${next ? 'enabled' : 'disabled'}`, 'info')
    } catch (e) {
      addLog(`Debug toggle error: ${e}`, 'error')
    }
  }

  const setDebugOption = async (option: keyof DebugConfig, value: boolean) => {
    try {
      const res = await fetch('/api/debug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-option', option, value }),
      })
      const d = await res.json()
      if (d.config) setDebugConfig(d.config)
    } catch (e) {
      addLog(`Debug option error: ${e}`, 'error')
    }
  }

  // Derived values
  const phase = stats?.metadata.phase ?? 'unknown'
  const running = stats?.metadata.engineRunning ?? false
  const historicDone = stats?.historic.isComplete ?? false
  const symProc = stats?.historic.symbolsProcessed ?? 0
  const symTotal = stats?.historic.symbolsTotal ?? 0
  const baseS = stats?.breakdown.strategies.base ?? 0
  const mainS = stats?.breakdown.strategies.main ?? 0
  const realS = stats?.breakdown.strategies.real ?? 0
  const liveS = stats?.breakdown.strategies.live ?? 0
  const maxS = Math.max(baseS, mainS, realS, liveS, 1)
  const realtimeCycles = stats?.realtime.realtimeCycles ?? 0
  const indCycles = stats?.realtime.indicationCycles ?? 0

  return (
    <div className='space-y-4'>
      {/* ── Header bar ───────────────────────────────────────────────────── */}
      <Card className='p-4'>
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <div className='flex items-center gap-3'>
            <div className={`w-2.5 h-2.5 rounded-full ${phaseColor(phase)}`} />
            <span className='font-semibold text-sm tracking-tight'>
              {CONN_ID} &mdash; <span className='font-mono'>{phase}</span>
            </span>
            <Badge variant={running ? 'default' : 'secondary'} className='text-xs'>
              {running ? 'Running' : 'Stopped'}
            </Badge>
            {debugConfig.enabled && (
              <Badge variant='outline' className='text-xs border-amber-400 text-amber-600'>
                Debug ON
              </Badge>
            )}
          </div>

          <div className='flex flex-wrap gap-2'>
            <Button
              size='sm'
              onClick={engineStart}
              disabled={!!actionLoading || running}
              className='gap-1.5 h-8'
            >
              <Play className='w-3.5 h-3.5' />
              Start
            </Button>
            <Button
              size='sm'
              variant='destructive'
              onClick={engineStop}
              disabled={!!actionLoading || !running}
              className='gap-1.5 h-8'
            >
              <Square className='w-3.5 h-3.5' />
              Stop
            </Button>
            <Button
              size='sm'
              variant='outline'
              onClick={engineRestart}
              disabled={!!actionLoading}
              className='gap-1.5 h-8'
            >
              <RefreshCw className={`w-3.5 h-3.5 ${actionLoading === 'restart' ? 'animate-spin' : ''}`} />
              Restart
            </Button>
            <Button
              size='sm'
              variant='outline'
              onClick={clearProgressions}
              disabled={!!actionLoading || running}
              className='gap-1.5 h-8 text-red-600 border-red-300 hover:bg-red-50 dark:hover:bg-red-950'
            >
              <RotateCcw className='w-3.5 h-3.5' />
              Clear &amp; Reset
            </Button>
            <Button
              size='sm'
              variant={debugConfig.enabled ? 'default' : 'outline'}
              onClick={toggleDebug}
              className='gap-1.5 h-8'
            >
              <Zap className='w-3.5 h-3.5' />
              Debug {debugConfig.enabled ? 'ON' : 'OFF'}
            </Button>
            <Button
              size='sm'
              variant='ghost'
              onClick={fetchStats}
              className='gap-1.5 h-8'
            >
              <RefreshCw className='w-3.5 h-3.5' />
            </Button>
          </div>
        </div>

        {/* Progress bar for historic / prehistoric */}
        {!historicDone && (
          <div className='mt-3 space-y-1'>
            <div className='flex justify-between text-xs text-muted-foreground'>
              <span>Historic: {symProc}/{symTotal} symbols</span>
              <span>{stats?.historic.progressPercent ?? 0}%</span>
            </div>
            <div className='h-1.5 bg-muted rounded-full overflow-hidden'>
              <div
                className='h-full bg-blue-500 rounded-full transition-all duration-500'
                style={{ width: `${stats?.historic.progressPercent ?? 0}%` }}
              />
            </div>
          </div>
        )}
        {historicDone && (
          <div className='mt-2 flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400'>
            <CheckCircle className='w-3.5 h-3.5' />
            Historic complete — {symProc} symbols processed, {fmt(stats?.historic.candlesLoaded)} candles
          </div>
        )}
      </Card>

      {/* ── Tabs ─────────────────────────────────────────────────────────── */}
      <Tabs defaultValue='metrics' className='w-full'>
        <TabsList className='grid w-full grid-cols-4'>
          <TabsTrigger value='metrics' className='gap-1.5'>
            <BarChart2 className='w-3.5 h-3.5' /> Metrics
          </TabsTrigger>
          <TabsTrigger value='pipeline' className='gap-1.5'>
            <Layers className='w-3.5 h-3.5' /> Pipeline
          </TabsTrigger>
          <TabsTrigger value='debug' className='gap-1.5'>
            <Cpu className='w-3.5 h-3.5' /> Debug
          </TabsTrigger>
          <TabsTrigger value='logs' className='gap-1.5'>
            <Activity className='w-3.5 h-3.5' /> Logs
          </TabsTrigger>
        </TabsList>

        {/* ── METRICS TAB ──────────────────────────────────────────────── */}
        <TabsContent value='metrics' className='mt-3 space-y-4'>
          {/* Cycle counters */}
          <div>
            <p className='text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2'>Cycle Counters</p>
            <div className='grid grid-cols-2 sm:grid-cols-4 gap-2'>
              <StatTile label='Realtime cycles' value={fmt(realtimeCycles)} accent={realtimeCycles > 0} />
              <StatTile label='Indication cycles' value={fmt(indCycles)} />
              <StatTile label='Strategy cycles' value={fmt(stats?.realtime.strategyCycles)} />
              <StatTile label='Avg cycle ms' value={fmt(stats?.realtime.avgCycleTimeMs, 0)} />
            </div>
          </div>

          {/* Indications */}
          <div>
            <p className='text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2'>Indications</p>
            <div className='grid grid-cols-2 sm:grid-cols-4 gap-2'>
              <StatTile label='Total' value={fmt(stats?.breakdown.indications.total)} />
              <StatTile label='Direction' value={fmt(stats?.breakdown.indications.direction)} />
              <StatTile label='Move' value={fmt(stats?.breakdown.indications.move)} />
              <StatTile label='Success rate' value={`${fmt(stats?.realtime.successRate)}%`} />
            </div>
          </div>

          {/* Strategies */}
          <div>
            <p className='text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2'>Strategies (current cycle)</p>
            <div className='grid grid-cols-2 sm:grid-cols-4 gap-2'>
              <StatTile label='Base sets' value={fmt(baseS)} />
              <StatTile label='Main sets' value={fmt(mainS)} />
              <StatTile label='Real sets' value={fmt(realS)} />
              <StatTile
                label='Live sets'
                value={fmt(liveS)}
                accent={liveS > 0}
              />
            </div>
          </div>

          {/* Positions */}
          <div>
            <p className='text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2'>Positions &amp; Orders</p>
            <div className='grid grid-cols-2 sm:grid-cols-4 gap-2'>
              <StatTile label='Pseudo open' value={fmt(stats?.openPositions.pseudo.open)} />
              <StatTile label='Live open' value={fmt(stats?.openPositions.live.open)} />
              <StatTile label='Orders placed' value={fmt(stats?.liveExecution.ordersPlaced)} />
              <StatTile label='Orders filled' value={fmt(stats?.liveExecution.ordersFilled)} />
            </div>
          </div>

          {/* DB health */}
          <div>
            <p className='text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2'>Redis / Engine State</p>
            <div className='grid grid-cols-2 sm:grid-cols-4 gap-2'>
              <StatTile label='DB entries' value={fmt(stats?.metadata.redisDbEntries)} />
              <StatTile label='Phase' value={phase} />
              <StatTile label='Last update' value={stats?.metadata.lastUpdate ? new Date(stats.metadata.lastUpdate).toLocaleTimeString() : '—'} />
              <StatTile label='Polling' value={polling ? 'Active' : 'Off'} accent={polling} />
            </div>
          </div>
        </TabsContent>

        {/* ── PIPELINE TAB ─────────────────────────────────────────────── */}
        <TabsContent value='pipeline' className='mt-3 space-y-5'>
          {/* Stage funnel */}
          <Card className='p-4 space-y-3'>
            <div className='flex items-center gap-2 mb-1'>
              <TrendingUp className='w-4 h-4 text-muted-foreground' />
              <p className='text-sm font-semibold'>Stage Funnel (current cycle)</p>
            </div>
            <StageBar label='Base' value={baseS} total={maxS} color='bg-blue-500' />
            <StageBar label='Main' value={mainS} total={maxS} color='bg-indigo-500' />
            <StageBar label='Real' value={realS} total={maxS} color='bg-violet-500' />
            <StageBar label='Live' value={liveS} total={maxS} color='bg-green-500' />
          </Card>

          {/* Stage eval % */}
          <Card className='p-4 space-y-3'>
            <div className='flex items-center gap-2 mb-1'>
              <BarChart2 className='w-4 h-4 text-muted-foreground' />
              <p className='text-sm font-semibold'>Stage Eval %</p>
            </div>
            {(['base', 'main', 'real'] as const).map(stage => (
              <div key={stage} className='space-y-0.5'>
                <div className='flex justify-between text-xs'>
                  <span className='font-medium text-muted-foreground capitalize'>{stage}</span>
                  <span className='font-bold tabular-nums'>{fmt(stats?.stageEvalPercent[stage])}%</span>
                </div>
                <div className='h-1.5 rounded-full bg-muted overflow-hidden'>
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      stage === 'base' ? 'bg-blue-500' : stage === 'main' ? 'bg-indigo-500' : 'bg-violet-500'
                    }`}
                    style={{ width: `${stats?.stageEvalPercent[stage] ?? 0}%` }}
                  />
                </div>
              </div>
            ))}
          </Card>

          {/* Historic summary */}
          <Card className='p-4 space-y-3'>
            <div className='flex items-center gap-2 mb-1'>
              <Database className='w-4 h-4 text-muted-foreground' />
              <p className='text-sm font-semibold'>Historic Pipeline</p>
            </div>
            <div className='grid grid-cols-2 gap-x-6 gap-y-2 text-sm'>
              {[
                ['Symbols processed', `${symProc} / ${symTotal}`],
                ['Candles loaded', fmt(stats?.historic.candlesLoaded)],
                ['Indicators calculated', fmt(stats?.historic.indicatorsCalculated)],
                ['Cycles completed', fmt(stats?.historic.cyclesCompleted)],
                ['Progress', `${stats?.historic.progressPercent ?? 0}%`],
                ['Complete', historicDone ? 'Yes' : 'No'],
              ].map(([label, val]) => (
                <div key={label} className='flex justify-between'>
                  <span className='text-muted-foreground'>{label}</span>
                  <span className='font-medium tabular-nums'>{val}</span>
                </div>
              ))}
            </div>
          </Card>

          {/* Live execution */}
          <Card className='p-4 space-y-3'>
            <div className='flex items-center gap-2 mb-1'>
              <Zap className='w-4 h-4 text-muted-foreground' />
              <p className='text-sm font-semibold'>Live Execution</p>
            </div>
            <div className='grid grid-cols-2 gap-x-6 gap-y-2 text-sm'>
              {[
                ['Placed', fmt(stats?.liveExecution.ordersPlaced)],
                ['Filled', fmt(stats?.liveExecution.ordersFilled)],
                ['Rejected', fmt(stats?.liveExecution.ordersRejected)],
                ['Simulated', fmt(stats?.liveExecution.ordersSimulated)],
                ['Fill rate', `${fmt(stats?.liveExecution.fillRate, 1)}%`],
                ['Win rate', `${fmt(stats?.liveExecution.winRate, 1)}%`],
                ['Volume (USD)', fmt(stats?.liveExecution.volumeUsdTotal, 2)],
                ['Wins', fmt(stats?.liveExecution.wins)],
              ].map(([label, val]) => (
                <div key={label} className='flex justify-between'>
                  <span className='text-muted-foreground'>{label}</span>
                  <span className='font-medium tabular-nums'>{val}</span>
                </div>
              ))}
            </div>
          </Card>
        </TabsContent>

        {/* ── DEBUG TAB ────────────────────────────────────────────────── */}
        <TabsContent value='debug' className='mt-3 space-y-3'>
          <Card className='p-4'>
            <div className='flex items-center justify-between mb-3'>
              <p className='text-sm font-semibold'>Debug Mode</p>
              <Badge variant={debugConfig.enabled ? 'default' : 'secondary'}>
                {debugConfig.enabled ? 'ON' : 'OFF'}
              </Badge>
            </div>
            <p className='text-xs text-muted-foreground mb-4'>
              Enables verbose server-side logging across all engine components. Logs appear in the
              Next.js dev server terminal with prefix{' '}
              <code className='font-mono bg-muted px-1 rounded'>[v0-DEBUG]</code>.
            </p>
            <div className='space-y-0'>
              {(Object.keys(debugConfig) as Array<keyof DebugConfig>).map(key => (
                <DebugToggleRow
                  key={key}
                  label={key}
                  checked={debugConfig[key]}
                  onChange={val => setDebugOption(key, val)}
                />
              ))}
            </div>
          </Card>

          {/* Caps reference */}
          <Card className='p-4'>
            <p className='text-sm font-semibold mb-3'>Current Engine Limits</p>
            <div className='grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs'>
              {[
                ['Dev heap', '6144 MB'],
                ['Symbol concurrency', '8'],
                ['Replay concurrency', '3'],
                ['Replay steps/sym', '80'],
                ['Axis sets ceiling', '10 000'],
                ['Real sets ceiling', '20 000'],
                ['Live sets default', '750'],
                ['Active symbols', '20'],
              ].map(([label, val]) => (
                <div key={label} className='flex justify-between'>
                  <span className='text-muted-foreground'>{label}</span>
                  <span className='font-mono font-medium'>{val}</span>
                </div>
              ))}
            </div>
          </Card>

          {/* Test actions */}
          <Card className='p-4 space-y-2'>
            <p className='text-sm font-semibold mb-2'>Intense Retest Actions</p>
            <div className='text-xs text-muted-foreground mb-3 space-y-1'>
              <p>1. Run migrations (apply 035 / 20 symbols) via the Settings &rarr; Migrations panel.</p>
              <p>2. Click <strong>Clear &amp; Reset</strong> to wipe progression state for a clean run.</p>
              <p>3. Click <strong>Start</strong> to begin the full prehistoric &rarr; realtime cycle.</p>
              <p>4. Watch the Metrics and Pipeline tabs update every 2 seconds.</p>
            </div>
            <div className='grid grid-cols-2 gap-2'>
              <Button size='sm' variant='outline' onClick={engineStart} disabled={!!actionLoading || running} className='gap-1.5'>
                <Play className='w-3.5 h-3.5' /> Start Engine
              </Button>
              <Button size='sm' variant='outline' onClick={engineStop} disabled={!!actionLoading || !running} className='gap-1.5'>
                <Square className='w-3.5 h-3.5' /> Stop Engine
              </Button>
              <Button size='sm' variant='outline' onClick={engineRestart} disabled={!!actionLoading} className='gap-1.5'>
                <RefreshCw className='w-3.5 h-3.5' /> Restart
              </Button>
              <Button
                size='sm'
                variant='outline'
                onClick={clearProgressions}
                disabled={!!actionLoading || running}
                className='gap-1.5 text-red-600 border-red-300'
              >
                <RotateCcw className='w-3.5 h-3.5' /> Clear &amp; Reset
              </Button>
            </div>
          </Card>
        </TabsContent>

        {/* ── LOGS TAB ─────────────────────────────────────────────────── */}
        <TabsContent value='logs' className='mt-3'>
          <Card className='p-3'>
            <div className='flex items-center justify-between mb-2'>
              <div className='flex items-center gap-2'>
                <Activity className='w-3.5 h-3.5 text-muted-foreground' />
                <p className='text-sm font-semibold'>Session Logs</p>
                <Badge variant='outline' className='text-xs'>{logs.length}</Badge>
              </div>
              <div className='flex items-center gap-2'>
                <div className={`w-1.5 h-1.5 rounded-full ${polling ? 'bg-green-500 animate-pulse' : 'bg-slate-300'}`} />
                <span className='text-xs text-muted-foreground'>{polling ? 'Polling' : 'Idle'}</span>
                <Button size='sm' variant='ghost' className='h-6 px-2 text-xs' onClick={() => setLogs([])}>
                  Clear
                </Button>
              </div>
            </div>
            <ScrollArea className='h-72 rounded border bg-slate-950 p-3'>
              <div className='space-y-0.5 font-mono'>
                {logs.length === 0 ? (
                  <p className='text-xs text-slate-500'>No logs yet — engine actions will appear here.</p>
                ) : (
                  logs.map((entry, idx) => (
                    <div
                      key={idx}
                      className={`text-xs flex gap-2 ${
                        entry.level === 'error' ? 'text-red-400' :
                        entry.level === 'warn'  ? 'text-amber-400' :
                        entry.level === 'ok'    ? 'text-green-400' :
                        'text-slate-300'
                      }`}
                    >
                      <span className='text-slate-500 shrink-0'>{entry.ts}</span>
                      <span>{entry.msg}</span>
                    </div>
                  ))
                )}
                <div ref={logsEndRef} />
              </div>
            </ScrollArea>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

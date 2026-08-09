"use client"
/**
 * Direct-Trade Section
 *
 * Placed after Quickstart on the main dashboard. Provides:
 * - Live/Simulated toggle switch
 * - Config options: Volume Factor, Pos Count, Symbol Count, Symbol Order,
 *   PF Minimum, Max DDT, SL Max Ratio, Trailing on/off, Block on/off
 * - Start/Stop button
 * - Stats overview: last 12/25/50 positions, last 4/12/48 hours with PF and DDT
 * - Active configs and positions overview
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { Card } from "@/components/ui/card"
import { useExchange } from "@/lib/exchange-context"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import {
  DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_DIRECTION,
  DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_SYMBOL,
  DIRECT_TRADE_MAX_SYMBOLS,
} from "@/lib/direct-trade-limits"
import { mergePendingDirectTradeConfig } from "@/lib/direct-trade-settings-sync"
import {
  DIRECT_TRADE_RECENT_PF_DEFAULT,
  DIRECT_TRADE_TAKE_PROFIT_RATIO_DEFAULT_RANGE,
  DIRECT_TRADE_TAKE_PROFIT_RATIO_MAX,
  DIRECT_TRADE_TAKE_PROFIT_RATIO_MIN,
  DIRECT_TRADE_TAKE_PROFIT_RATIO_STEP_DEFAULT,
} from "@/lib/direct-trade-coordination"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Play,
  StopCircle,
  Zap,
  TrendingUp,
  Activity,
  BarChart3,
  Clock,
  Loader2,
  RefreshCw,
  Boxes,
  Target,
  Shield,
  ChevronDown,
  ChevronUp,
} from "lucide-react"

// ─── Types ────────────────────────────────────────────────────────────────────

interface DirectTradeState {
  enabled: boolean
  liveMode: boolean
  connectionId: string | null
  startedAt: string | null
  processingIntervalMs: number
  symbolCount: number
  symbolOrder: "volatility_1h" | "volume" | "volatility"
  minVolFactor: number
  positionCostPercent: number
  maxSlRatio: number
  slRatioStep: number
  inverseMaxSlRatio: number
  timeframes: ("1m" | "10m" | "15m")[]
  strategyTypes: ("standard" | "trailing_fixed" | "trailing_auto" | "combination" | "inverse" | "high_protection")[]
  historyHours: number
  entryTactics: ("momentum" | "mean_reversion" | "breakout" | "relative")[]
  exitTactics: ("bracket" | "momentum_reversal" | "relative" | "time")[]
  entryTiming: "current" | "last_confirmed"
  activityVolumeRatio: number
  maxHoldMinutes: number
  takeProfitRatioRange: [number, number]
  takeProfitRatioStep: number
  blockRange: [number, number]
  maxPositionsPerSymbol: number
  maxPositionsPerDirection: number
  keepEnabledPosCount: number
  deactivatePosCount: number
  minProfitFactor: number
  minRecentProfitFactor: number
  recentEvaluationPositions: number
  maxDrawdownTimeMin: number
  prevPosWindow: number
  prevPosMinCount: number
  evalPosCount: number
  trailingEnabled: boolean
}

interface DirectTradeStats {
  totalOrders: number
  totalFilled: number
  totalPnl: number
  winCount: number
  lossCount: number
  profitFactor: number | null
  profitFactorInfinite?: boolean
  maxDrawdownTimeMin: number
  currentDrawdownTimeMin: number
  lastPositionAt: string | null
  last12Pos: { pf: number | null; pfInfinite?: boolean; ddt: number; pnl: number }
  last25Pos: { pf: number | null; pfInfinite?: boolean; ddt: number; pnl: number }
  last50Pos: { pf: number | null; pfInfinite?: boolean; ddt: number; pnl: number }
  last4h: { pf: number | null; pfInfinite?: boolean; ddt: number; pnl: number }
  last12h: { pf: number | null; pfInfinite?: boolean; ddt: number; pnl: number }
  last48h: { pf: number | null; pfInfinite?: boolean; ddt: number; pnl: number }
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_STATE: DirectTradeState = {
  enabled: false,
  liveMode: false,
  connectionId: null,
  startedAt: null,
  processingIntervalMs: 280,
  symbolCount: 8,
  symbolOrder: "volatility_1h",
  minVolFactor: 0.1,
  positionCostPercent: 0.1,
  maxSlRatio: 0.75,
  slRatioStep: 0.25,
  inverseMaxSlRatio: 1.25,
  timeframes: ["1m", "10m", "15m"],
  strategyTypes: ["standard", "trailing_fixed", "trailing_auto", "combination", "inverse", "high_protection"],
  historyHours: 48,
  entryTactics: ["momentum", "mean_reversion", "breakout", "relative"],
  exitTactics: ["bracket", "momentum_reversal", "relative", "time"],
  entryTiming: "current",
  activityVolumeRatio: 1,
  maxHoldMinutes: 120,
  takeProfitRatioRange: DIRECT_TRADE_TAKE_PROFIT_RATIO_DEFAULT_RANGE,
  takeProfitRatioStep: DIRECT_TRADE_TAKE_PROFIT_RATIO_STEP_DEFAULT,
  blockRange: [1, 12],
  maxPositionsPerSymbol: DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_SYMBOL,
  maxPositionsPerDirection: DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_DIRECTION,
  keepEnabledPosCount: 12,
  deactivatePosCount: 16,
  minProfitFactor: 0.8,
  minRecentProfitFactor: DIRECT_TRADE_RECENT_PF_DEFAULT,
  recentEvaluationPositions: 12,
  maxDrawdownTimeMin: 10,
  prevPosWindow: 25,
  prevPosMinCount: 5,
  evalPosCount: 12,
  trailingEnabled: true,
}

const DEFAULT_STATS: DirectTradeStats = {
  totalOrders: 0,
  totalFilled: 0,
  totalPnl: 0,
  winCount: 0,
  lossCount: 0,
  profitFactor: null,
  profitFactorInfinite: false,
  maxDrawdownTimeMin: 0,
  currentDrawdownTimeMin: 0,
  lastPositionAt: null,
  last12Pos: { pf: 0, ddt: 0, pnl: 0 },
  last25Pos: { pf: 0, ddt: 0, pnl: 0 },
  last50Pos: { pf: 0, ddt: 0, pnl: 0 },
  last4h: { pf: 0, ddt: 0, pnl: 0 },
  last12h: { pf: 0, ddt: 0, pnl: 0 },
  last48h: { pf: 0, ddt: 0, pnl: 0 },
}

// ─── Component ────────────────────────────────────────────────────────────────

export function DirectTradeSection() {
  const { selectedConnectionId } = useExchange()
  const [state, setState] = useState<DirectTradeState>(DEFAULT_STATE)
  const [stats, setStats] = useState<DirectTradeStats>(DEFAULT_STATS)
  const [activeConfigs, setActiveConfigs] = useState(0)
  const [openPositions, setOpenPositions] = useState(0)
  const [closedPositions, setClosedPositions] = useState(0)
  const [disabledConfigs, setDisabledConfigs] = useState(0)
  const [calculationProgress, setCalculationProgress] = useState<{ status?: string; completedSymbols?: number; totalSymbols?: number; evaluatedSets?: number } | null>(null)
  const [processorHealthy, setProcessorHealthy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [calculating, setCalculating] = useState(false)
  const [calculationError, setCalculationError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)
  const [optionsExpanded, setOptionsExpanded] = useState(false)

  // Local config state for sliders (debounced save)
  const [localVolFactor, setLocalVolFactor] = useState(0.1)
  const [localPositionCost, setLocalPositionCost] = useState(0.1)
  const [localMaxSl, setLocalMaxSl] = useState(0.75)
  const [localInverseMaxSl, setLocalInverseMaxSl] = useState(1.25)
  const [localMinPF, setLocalMinPF] = useState(0.8)
  const [localMinRecentPF, setLocalMinRecentPF] = useState(10)
  const [localRecentEvaluationPositions, setLocalRecentEvaluationPositions] = useState(12)
  const [localMaxDDT, setLocalMaxDDT] = useState(10)
  const [localSymbolCount, setLocalSymbolCount] = useState(8)
  const [localMaxPosPerSymbol, setLocalMaxPosPerSymbol] = useState(DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_SYMBOL)
  const [localMaxPosPerDir, setLocalMaxPosPerDir] = useState(DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_DIRECTION)
  const [localTrailing, setLocalTrailing] = useState(true)
  const [localBlock, setLocalBlock] = useState(true)
  const [localBlockMax, setLocalBlockMax] = useState(12)
  const [localTimeframes, setLocalTimeframes] = useState<string[]>(["1m", "10m", "15m"])
  const [localStrategyTypes, setLocalStrategyTypes] = useState<string[]>(["standard", "trailing_fixed", "trailing_auto", "combination", "inverse", "high_protection"])
  const [localHistoryHours, setLocalHistoryHours] = useState(60)
  const [localEntryTactics, setLocalEntryTactics] = useState<string[]>(["momentum", "mean_reversion", "breakout", "relative"])
  const [localExitTactics, setLocalExitTactics] = useState<string[]>(["bracket", "momentum_reversal", "relative", "time"])
  const [localEntryTiming, setLocalEntryTiming] = useState<"current" | "last_confirmed">("current")
  const [localActivityVolumeRatio, setLocalActivityVolumeRatio] = useState(1)
  const [localMaxHoldMinutes, setLocalMaxHoldMinutes] = useState(120)
  const [localTakeProfitRatioRange, setLocalTakeProfitRatioRange] = useState<[number, number]>(DIRECT_TRADE_TAKE_PROFIT_RATIO_DEFAULT_RANGE)
  const [localTakeProfitRatioStep, setLocalTakeProfitRatioStep] = useState(DIRECT_TRADE_TAKE_PROFIT_RATIO_STEP_DEFAULT)
  const [localSymbolOrder, setLocalSymbolOrder] = useState<string>("volatility_1h")
  // Pos Count evaluation windows (for PF/DDT historic coordination calculations)
  const [localPrevPosWindow, setLocalPrevPosWindow] = useState(25)
  const [localPrevPosMinCount, setLocalPrevPosMinCount] = useState(5)
  const [localEvalPosCount, setLocalEvalPosCount] = useState(12)
  // Keep-enabled check: per symbol/direction/config independent evaluation
  const [localKeepEnabledPosCount, setLocalKeepEnabledPosCount] = useState(12)
  const [localDeactivatePosCount, setLocalDeactivatePosCount] = useState(16)

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingConfigRef = useRef<Record<string, unknown>>({})
  const pendingConfigKeysRef = useRef(new Set<string>())
  const configSaveInFlightRef = useRef(false)
  const flushConfigRef = useRef<(() => Promise<void>) | null>(null)
  const [savingConfig, setSavingConfig] = useState(false)
  const [configSaveError, setConfigSaveError] = useState<string | null>(null)

  const applyRemoteState = useCallback((remoteState: DirectTradeState) => {
    const pendingKeys = pendingConfigKeysRef.current
    const isPending = (key: string) => pendingKeys.has(key)
    setState((current) => mergePendingDirectTradeConfig(remoteState, current, pendingKeys))
    if (!isPending("minVolFactor")) setLocalVolFactor(remoteState.minVolFactor ?? 0.1)
    if (!isPending("positionCostPercent")) setLocalPositionCost(remoteState.positionCostPercent ?? 0.1)
    if (!isPending("maxSlRatio")) setLocalMaxSl(remoteState.maxSlRatio ?? 0.75)
    if (!isPending("inverseMaxSlRatio")) setLocalInverseMaxSl(remoteState.inverseMaxSlRatio ?? 1.25)
    if (!isPending("symbolCount")) setLocalSymbolCount(remoteState.symbolCount || 8)
    if (!isPending("maxPositionsPerSymbol")) setLocalMaxPosPerSymbol(remoteState.maxPositionsPerSymbol || DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_SYMBOL)
    if (!isPending("maxPositionsPerDirection")) setLocalMaxPosPerDir(remoteState.maxPositionsPerDirection || DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_DIRECTION)
    if (!isPending("timeframes")) setLocalTimeframes(remoteState.timeframes || ["1m", "10m", "15m"])
    if (!isPending("strategyTypes")) setLocalStrategyTypes(remoteState.strategyTypes || ["standard", "trailing_fixed", "trailing_auto", "combination", "inverse", "high_protection"])
    if (!isPending("historyHours")) setLocalHistoryHours(remoteState.historyHours ?? 48)
    if (!isPending("entryTactics")) setLocalEntryTactics(remoteState.entryTactics || ["momentum", "mean_reversion", "breakout", "relative"])
    if (!isPending("exitTactics")) setLocalExitTactics(remoteState.exitTactics || ["bracket", "momentum_reversal", "relative", "time"])
    if (!isPending("entryTiming")) setLocalEntryTiming(remoteState.entryTiming === "last_confirmed" ? "last_confirmed" : "current")
    if (!isPending("activityVolumeRatio")) setLocalActivityVolumeRatio(remoteState.activityVolumeRatio ?? 1)
    if (!isPending("maxHoldMinutes")) setLocalMaxHoldMinutes(remoteState.maxHoldMinutes ?? 120)
    if (!isPending("takeProfitRatioRange")) setLocalTakeProfitRatioRange(remoteState.takeProfitRatioRange ?? DIRECT_TRADE_TAKE_PROFIT_RATIO_DEFAULT_RANGE)
    if (!isPending("takeProfitRatioStep")) setLocalTakeProfitRatioStep(remoteState.takeProfitRatioStep ?? DIRECT_TRADE_TAKE_PROFIT_RATIO_STEP_DEFAULT)
    if (!isPending("symbolOrder")) setLocalSymbolOrder(remoteState.symbolOrder || "volatility_1h")
    if (!isPending("blockRange")) {
      setLocalBlock(remoteState.blockRange?.[1] > 0)
      setLocalBlockMax(remoteState.blockRange?.[1] || 12)
    }
    if (!isPending("minProfitFactor")) setLocalMinPF(remoteState.minProfitFactor ?? 0.8)
    if (!isPending("minRecentProfitFactor")) setLocalMinRecentPF(remoteState.minRecentProfitFactor ?? DIRECT_TRADE_RECENT_PF_DEFAULT)
    if (!isPending("recentEvaluationPositions")) setLocalRecentEvaluationPositions(remoteState.recentEvaluationPositions ?? 12)
    if (!isPending("maxDrawdownTimeMin")) setLocalMaxDDT(remoteState.maxDrawdownTimeMin ?? 10)
    if (!isPending("prevPosWindow")) setLocalPrevPosWindow(remoteState.prevPosWindow ?? 25)
    if (!isPending("prevPosMinCount")) setLocalPrevPosMinCount(remoteState.prevPosMinCount ?? 5)
    if (!isPending("evalPosCount")) setLocalEvalPosCount(remoteState.evalPosCount ?? 12)
    if (!isPending("keepEnabledPosCount")) setLocalKeepEnabledPosCount(remoteState.keepEnabledPosCount ?? 12)
    if (!isPending("deactivatePosCount")) setLocalDeactivatePosCount(remoteState.deactivatePosCount ?? 16)
    if (!isPending("trailingEnabled")) setLocalTrailing(remoteState.trailingEnabled !== false)
  }, [])

  // ─── Data Fetching ────────────────────────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/trade-engine/direct-trade/status", { cache: "no-store" })
      if (!res.ok) return
      const data = await res.json()
      if (data.state) {
        applyRemoteState(data.state)
      }
      if (data.stats) setStats({ ...DEFAULT_STATS, ...data.stats })
      if (data.activeConfigs !== undefined) setActiveConfigs(data.activeConfigs)
      if (data.openPositions !== undefined) setOpenPositions(data.openPositions)
      if (data.closedPositions !== undefined) setClosedPositions(data.closedPositions)
      if (data.disabledConfigs !== undefined) setDisabledConfigs(data.disabledConfigs)
      setCalculationProgress(data.calculationProgress && typeof data.calculationProgress === "object" ? data.calculationProgress : null)
      if (data.processor) setProcessorHealthy(data.processor.isHealthy || false)
    } catch {}
  }, [applyRemoteState])

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 3000)
    return () => clearInterval(interval)
  }, [fetchStatus])

  // ─── Actions ──────────────────────────────────────────────────────────────

  const handleStartStop = async () => {
    setLoading(true)
    try {
      const action = state.enabled ? "stop" : "start"
      const res = await fetch("/api/trade-engine/direct-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          liveMode: state.liveMode,
          connectionId: selectedConnectionId ?? state.connectionId,
          symbolCount: localSymbolCount,
          symbolOrder: localSymbolOrder,
          minVolFactor: localVolFactor,
          positionCostPercent: localPositionCost,
          maxSlRatio: localMaxSl,
          inverseMaxSlRatio: localInverseMaxSl,
          timeframes: localTimeframes,
          strategyTypes: localStrategyTypes,
          historyHours: localHistoryHours,
          entryTactics: localEntryTactics,
          exitTactics: localExitTactics,
          entryTiming: localEntryTiming,
          activityVolumeRatio: localActivityVolumeRatio,
          maxHoldMinutes: localMaxHoldMinutes,
          takeProfitRatioRange: localTakeProfitRatioRange,
          takeProfitRatioStep: localTakeProfitRatioStep,
          blockRange: localBlock ? [1, localBlockMax] : [0, 0],
          maxPositionsPerSymbol: localMaxPosPerSymbol,
          maxPositionsPerDirection: localMaxPosPerDir,
          keepEnabledPosCount: localKeepEnabledPosCount,
          deactivatePosCount: localDeactivatePosCount,
          minProfitFactor: localMinPF,
          minRecentProfitFactor: localMinRecentPF,
          recentEvaluationPositions: localRecentEvaluationPositions,
          maxDrawdownTimeMin: localMaxDDT,
          prevPosWindow: localPrevPosWindow,
          prevPosMinCount: localPrevPosMinCount,
          evalPosCount: localEvalPosCount,
          trailingEnabled: localTrailing,
        }),
      })
      const data = await res.json()
      if (data.state) setState(data.state)
    } catch {}
    setLoading(false)
  }

  const handleToggleLive = async () => {
    const nextLiveMode = !state.liveMode
    setState((current) => ({ ...current, liveMode: nextLiveMode }))
    try {
      const res = await fetch("/api/trade-engine/direct-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "toggle-live",
          liveMode: nextLiveMode,
          connectionId: selectedConnectionId ?? state.connectionId,
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.state) throw new Error(data.error || "Live mode update failed")
      setState(data.state)
    } catch {
      setState((current) => ({ ...current, liveMode: !nextLiveMode }))
    }
  }

  const handleRecalculate = async () => {
    if (calculating) return
    setCalculating(true)
    setCalculationError(null)
    try {
      const response = await fetch("/api/trade-engine/direct-trade/calculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbolCount: localSymbolCount,
          symbolOrder: localSymbolOrder,
          minVolFactor: localVolFactor,
          positionCostPercent: localPositionCost,
          maxSlRatio: localMaxSl,
          inverseMaxSlRatio: localInverseMaxSl,
          timeframes: localTimeframes,
          strategyTypes: localStrategyTypes,
          historyHours: localHistoryHours,
          entryTactics: localEntryTactics,
          exitTactics: localExitTactics,
          entryTiming: localEntryTiming,
          activityVolumeRatio: localActivityVolumeRatio,
          maxHoldMinutes: localMaxHoldMinutes,
          takeProfitRatioRange: localTakeProfitRatioRange,
          takeProfitRatioStep: localTakeProfitRatioStep,
          blockRange: localBlock ? [1, localBlockMax] : [0, 0],
          minProfitFactor: localMinPF,
          minRecentProfitFactor: localMinRecentPF,
          recentEvaluationPositions: localRecentEvaluationPositions,
          maxDrawdownTimeMin: localMaxDDT,
          deactivatePosCount: localDeactivatePosCount,
          trailingEnabled: localTrailing,
        }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(payload?.error || `Direct-Trade calculation failed (${response.status})`)
      }
      await fetchStatus()
    } catch (error) {
      setCalculationError(error instanceof Error ? error.message : "Direct-Trade calculation failed")
    } finally {
      setCalculating(false)
    }
  }

  // ─── Debounced Config Save ────────────────────────────────────────────────

  const flushConfig = useCallback(async () => {
    if (configSaveInFlightRef.current) return
    const updates = pendingConfigRef.current
    const updateKeys = Object.keys(updates)
    if (updateKeys.length === 0) return
    pendingConfigRef.current = {}
    configSaveInFlightRef.current = true
    setSavingConfig(true)
    try {
      const response = await fetch("/api/trade-engine/direct-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update-config", ...updates }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.success !== true || !payload?.state) {
        throw new Error(payload?.error || "Direct-Trade settings were not accepted")
      }
      for (const key of updateKeys) {
        if (!Object.prototype.hasOwnProperty.call(pendingConfigRef.current, key)) {
          pendingConfigKeysRef.current.delete(key)
        }
      }
      applyRemoteState(payload.state)
      setConfigSaveError(null)
    } catch (error) {
      for (const key of updateKeys) {
        if (!Object.prototype.hasOwnProperty.call(pendingConfigRef.current, key)) {
          pendingConfigKeysRef.current.delete(key)
        }
      }
      setConfigSaveError(error instanceof Error ? error.message : "Direct-Trade settings could not be saved")
      void fetchStatus()
    } finally {
      configSaveInFlightRef.current = false
      setSavingConfig(false)
      if (Object.keys(pendingConfigRef.current).length > 0) {
        void flushConfigRef.current?.()
      }
    }
  }, [applyRemoteState, fetchStatus])

  flushConfigRef.current = flushConfig

  const saveConfig = useCallback((updates: Record<string, unknown>) => {
    Object.assign(pendingConfigRef.current, updates)
    for (const key of Object.keys(updates)) pendingConfigKeysRef.current.add(key)
    setState((current) => ({ ...current, ...(updates as Partial<DirectTradeState>) }))
    setConfigSaveError(null)
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = setTimeout(() => void flushConfig(), 350)
  }, [flushConfig])

  useEffect(() => () => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    void flushConfigRef.current?.()
  }, [])

  // ─── Render Helpers ───────────────────────────────────────────────────────

  const formatPF = (pf: number | null, infinite = false) => infinite ? "∞" : pf == null ? "—" : pf.toFixed(2)
  const formatDDT = (ddt: number) => ddt > 0 ? `${ddt.toFixed(1)}m` : "0.0m"
  const formatPnl = (pnl: number) => {
    if (pnl === 0) return "0.00%"
    return `${pnl > 0 ? "+" : ""}${pnl.toFixed(3)}%`
  }

  const pnlColor = (pnl: number) =>
    pnl > 0 ? "text-green-500" : pnl < 0 ? "text-red-500" : "text-muted-foreground"

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <Card className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Target className="h-5 w-5 text-primary" />
          <h3 className="font-semibold text-base">Direct-Trade</h3>
          <Badge variant={state.enabled ? "default" : "secondary"} className="text-xs">
            {state.enabled ? "Active" : "Inactive"}
          </Badge>
          {state.enabled && (
            <Badge variant={state.liveMode ? "destructive" : "outline"} className="text-xs">
              {state.liveMode ? "LIVE" : "Simulated"}
            </Badge>
          )}
          {processorHealthy && (
            <Badge variant="outline" className="text-xs text-green-600 border-green-300">
              <Activity className="h-3 w-3 mr-1" /> Processor OK
            </Badge>
          )}
          {savingConfig && <Badge variant="outline" className="text-xs">Saving settings…</Badge>}
          {configSaveError && <Badge variant="outline" className="text-xs text-red-600 border-red-300" title={configSaveError}>Settings save failed</Badge>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}>
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {expanded && (
        <>
          {/* Controls Row */}
          <div className="flex flex-wrap items-center gap-3 border-b pb-3">
            {/* Live Switch */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Live Trade</span>
              <Switch
                checked={state.liveMode}
                onCheckedChange={handleToggleLive}
                className="data-[state=checked]:bg-red-500"
              />
            </div>

            {/* Start/Stop */}
            <Button
              size="sm"
              variant={state.enabled ? "destructive" : "default"}
              onClick={handleStartStop}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : state.enabled ? (
                <StopCircle className="h-4 w-4 mr-1" />
              ) : (
                <Play className="h-4 w-4 mr-1" />
              )}
              {state.enabled ? "Stop" : "Start"}
            </Button>

            {/* Recalculate */}
            <Button size="sm" variant="outline" onClick={handleRecalculate} disabled={calculating}>
              {calculating ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
              Recalc
            </Button>

            {/* Quick Stats */}
            <div className="flex items-center gap-3 ml-auto text-xs">
              <span className="text-muted-foreground">Configs: <strong>{activeConfigs}</strong></span>
              <span className="text-muted-foreground">Open: <strong>{openPositions}</strong></span>
              <span className="text-muted-foreground">Closed: <strong>{closedPositions}</strong></span>
              <span className="text-muted-foreground">Disabled: <strong>{disabledConfigs}</strong></span>
              <span className={pnlColor(stats.totalPnl)}>PnL: <strong>{formatPnl(stats.totalPnl)}</strong></span>
            </div>
          </div>

          {(calculating || calculationProgress || calculationError) && (
            <div
              role="status"
              aria-live="polite"
              className={`rounded-md border px-3 py-2 text-xs ${
                calculationError
                  ? "border-destructive/40 bg-destructive/5 text-destructive"
                  : calculationProgress?.status === "ready"
                    ? "border-green-500/30 bg-green-500/5 text-green-700 dark:text-green-300"
                    : "border-primary/20 bg-primary/5 text-muted-foreground"
              }`}
            >
              {calculationError ? (
                <span>Calculation failed: {calculationError}</span>
              ) : calculating && !calculationProgress ? (
                <span>Starting Direct-Trade calculation…</span>
              ) : calculationProgress?.status === "running" ? (
                <span>
                  Calculating independently: <span className="font-mono text-foreground">
                    {calculationProgress.completedSymbols || 0}/{calculationProgress.totalSymbols || 0}
                  </span> symbols · <span className="font-mono text-foreground">
                    {(calculationProgress.evaluatedSets || 0).toLocaleString()}
                  </span> sets indexed
                </span>
              ) : calculationProgress?.status === "ready" ? (
                <span>Direct-Trade calculation ready · {(calculationProgress.evaluatedSets || 0).toLocaleString()} sets indexed</span>
              ) : (
                <span>Direct-Trade calculation status: {calculationProgress?.status || "queued"}</span>
              )}
            </div>
          )}

          {/* Options Toggle */}
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-between text-xs"
            onClick={() => setOptionsExpanded(!optionsExpanded)}
          >
            <span className="flex items-center gap-1">
              <Boxes className="h-3 w-3" /> Options & Configuration
            </span>
            {optionsExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </Button>

          {optionsExpanded && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-3 bg-muted/30 rounded-lg">
              {/* Volume Factor */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Volume Factor (minimum)</span>
                  <span className="font-mono font-medium">{localVolFactor.toFixed(1)}</span>
                </div>
                <input
                  aria-label="Direct-Trade volume factor"
                  className="h-8 w-full rounded border bg-background px-2 font-mono text-xs"
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={localVolFactor}
                  onChange={(event) => {
                    const v = Math.max(0.1, Number(event.target.value) || 0.1)
                    setLocalVolFactor(v)
                    saveConfig({ minVolFactor: v })
                  }}
                />
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Position Cost (net close)</span>
                  <span className="font-mono font-medium">{localPositionCost.toFixed(2)}%</span>
                </div>
                <Slider
                  value={[localPositionCost]}
                  min={0.02}
                  max={1}
                  step={0.01}
                  onValueChange={([v]) => {
                    setLocalPositionCost(v)
                    saveConfig({ positionCostPercent: v })
                  }}
                />
                <p className="text-[10px] text-muted-foreground/70 leading-tight">Deducted once from every closed historical, simulated, and live Direct-Trade result; never added to open-position PF/DDT.</p>
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">TP Set range · × PositionCost</span>
                  <span className="font-mono font-medium">{localTakeProfitRatioRange[0]}–{localTakeProfitRatioRange[1]} · step {localTakeProfitRatioStep}</span>
                </div>
                <Slider
                  aria-label="Direct-Trade take-profit PositionCost range"
                  value={localTakeProfitRatioRange}
                  min={DIRECT_TRADE_TAKE_PROFIT_RATIO_MIN}
                  max={DIRECT_TRADE_TAKE_PROFIT_RATIO_MAX}
                  step={1}
                  minStepsBetweenThumbs={0}
                  onValueChange={(next) => {
                    const minimum = Math.max(DIRECT_TRADE_TAKE_PROFIT_RATIO_MIN, Math.min(DIRECT_TRADE_TAKE_PROFIT_RATIO_MAX, Math.round(next[0] ?? localTakeProfitRatioRange[0])))
                    const maximum = Math.max(minimum, Math.min(DIRECT_TRADE_TAKE_PROFIT_RATIO_MAX, Math.round(next[1] ?? localTakeProfitRatioRange[1])))
                    const range: [number, number] = [minimum, maximum]
                    setLocalTakeProfitRatioRange(range)
                    saveConfig({ takeProfitRatioRange: range })
                  }}
                />
                <Slider
                  aria-label="Direct-Trade take-profit Set-creation step"
                  value={[localTakeProfitRatioStep]}
                  min={1}
                  max={20}
                  step={1}
                  onValueChange={([value]) => {
                    setLocalTakeProfitRatioStep(value)
                    saveConfig({ takeProfitRatioStep: value })
                  }}
                />
                <p className="text-[10px] text-muted-foreground/70 leading-tight">The two handles accept every 2–22× ratio. Only every configured Set step plus the upper handle is materialised, preserving the selected boundary without multiplying the grid unnecessarily.</p>
              </div>

              {/* Symbol Count */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Symbol Count</span>
                  <span className="font-mono font-medium">{localSymbolCount}</span>
                </div>
                <Slider
                  value={[localSymbolCount]}
                  min={1}
                  max={DIRECT_TRADE_MAX_SYMBOLS}
                  step={1}
                  onValueChange={([v]) => {
                    setLocalSymbolCount(v)
                    saveConfig({ symbolCount: v })
                  }}
                />
              </div>

              {/* Symbol Order */}
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Symbol Order</span>
                <Select
                  value={localSymbolOrder}
                  onValueChange={(v) => {
                    setLocalSymbolOrder(v)
                    saveConfig({ symbolOrder: v })
                  }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="volatility_1h">Most Volatile 1h</SelectItem>
                    <SelectItem value="volatility">Volatility 24h</SelectItem>
                    <SelectItem value="volume">Volume 24h</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Max Positions per Symbol */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Max Pos / Symbol</span>
                  <span className="font-mono font-medium">{localMaxPosPerSymbol}</span>
                </div>
                <Slider
                  value={[localMaxPosPerSymbol]}
                  min={1}
                  max={300}
                  step={1}
                  onValueChange={([v]) => {
                    setLocalMaxPosPerSymbol(v)
                    saveConfig({ maxPositionsPerSymbol: v })
                  }}
                />
              </div>

              {/* Max Positions per Direction */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Max Pos / Direction</span>
                  <span className="font-mono font-medium">{localMaxPosPerDir}</span>
                </div>
                <Slider
                  value={[localMaxPosPerDir]}
                  min={1}
                  max={300}
                  step={1}
                  onValueChange={([v]) => {
                    setLocalMaxPosPerDir(v)
                    saveConfig({ maxPositionsPerDirection: v })
                  }}
                />
              </div>

              {/* SL Max Ratio */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">StopLoss Max Ratio</span>
                  <span className="font-mono font-medium">{localMaxSl.toFixed(2)}</span>
                </div>
                <Slider
                  value={[localMaxSl]}
                  min={0.25}
                  max={0.75}
                  step={0.25}
                  onValueChange={([v]) => {
                    setLocalMaxSl(v)
                    saveConfig({ maxSlRatio: v })
                  }}
                />
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Inverse SL Max / TP</span>
                  <span className="font-mono font-medium">{localInverseMaxSl.toFixed(2)}</span>
                </div>
                <Slider
                  value={[localInverseMaxSl]}
                  min={0.25}
                  max={1.25}
                  step={0.25}
                  onValueChange={([v]) => {
                    setLocalInverseMaxSl(v)
                    saveConfig({ inverseMaxSlRatio: v })
                  }}
                />
                <p className="text-[10px] text-muted-foreground/70 leading-tight">Independent inverse Long/Short orders; capped at 1.25× TP.</p>
              </div>

              {/* Min Profit Factor */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Min Profit Factor</span>
                  <span className="font-mono font-medium">{localMinPF.toFixed(1)}</span>
                </div>
                <Slider
                  value={[localMinPF]}
                  min={0.8}
                  max={3.5}
                  step={0.1}
                  onValueChange={([v]) => {
                    setLocalMinPF(v)
                    saveConfig({ minProfitFactor: v })
                  }}
                />
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Recent PF Gate</span>
                  <span className="font-mono font-medium">{localMinRecentPF.toFixed(1)} / {localRecentEvaluationPositions} closed</span>
                </div>
                <Slider
                  value={[localMinRecentPF]}
                  min={0.8}
                  max={20}
                  step={0.1}
                  onValueChange={([v]) => {
                    setLocalMinRecentPF(v)
                    saveConfig({ minRecentProfitFactor: v })
                  }}
                />
                <Slider
                  value={[localRecentEvaluationPositions]}
                  min={3}
                  max={50}
                  step={1}
                  onValueChange={([v]) => {
                    setLocalRecentEvaluationPositions(v)
                    saveConfig({ recentEvaluationPositions: v })
                  }}
                />
                <p className="text-[10px] text-muted-foreground/70 leading-tight">Historical last-position PF gate for new entries; open positions keep their own TP/SL/trailing/time exit until closed.</p>
              </div>

              {/* Max Drawdown Time */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Max DDT (min)</span>
                  <span className="font-mono font-medium">{localMaxDDT}</span>
                </div>
                <Slider
                  value={[localMaxDDT]}
                  min={1}
                  max={30}
                  step={1}
                  onValueChange={([v]) => {
                    setLocalMaxDDT(v)
                    saveConfig({ maxDrawdownTimeMin: v })
                  }}
                />
              </div>

              {/* Block Max Count */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Block Max Count</span>
                  <span className="font-mono font-medium">{localBlockMax}</span>
                </div>
                <Slider
                  value={[localBlockMax]}
                  min={1}
                  max={12}
                  step={1}
                  disabled={!localBlock}
                  onValueChange={([v]) => {
                    setLocalBlockMax(v)
                    saveConfig({ blockRange: [1, v] })
                  }}
                />
              </div>

              {/* Timeframes */}
              <div className="space-y-2">
                <span className="text-xs text-muted-foreground">Timeframes</span>
                <div className="flex gap-2">
                  {(["1m", "10m", "15m"] as const).map((tf) => (
                    <Button
                      key={tf}
                      size="sm"
                      variant={localTimeframes.includes(tf) ? "default" : "outline"}
                      className="h-7 text-xs px-2"
                      onClick={() => {
                        const next = localTimeframes.includes(tf)
                          ? localTimeframes.filter((t) => t !== tf)
                          : [...localTimeframes, tf]
                        if (next.length === 0) return
                        setLocalTimeframes(next)
                        saveConfig({ timeframes: next })
                      }}
                    >
                      {tf}
                    </Button>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground/70 leading-tight">
                  Every selected timeframe and every non-empty combination are evaluated as independent sets.
                </p>
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Historic range (hours)</span>
                  <span className="font-mono font-medium">{localHistoryHours}h</span>
                </div>
                <input
                  aria-label="Direct-Trade historical range in hours"
                  className="h-8 w-full rounded border bg-background px-2 font-mono text-xs"
                  type="number"
                  min={1}
                  step={1}
                  value={localHistoryHours}
                  onChange={(event) => {
                    const value = Math.max(1, Math.floor(Number(event.target.value) || 1))
                    setLocalHistoryHours(value)
                    saveConfig({ historyHours: value })
                  }}
                />
                <p className="text-[10px] text-muted-foreground/70 leading-tight">Default 48h; the public kline transport is paged until this range is fully covered.</p>
              </div>

              <div className="space-y-2">
                <span className="text-xs text-muted-foreground">Independent entry tactics</span>
                <div className="flex flex-wrap gap-1">
                  {(["momentum", "mean_reversion", "breakout", "relative"] as const).map((tactic) => (
                    <Button key={tactic} size="sm" variant={localEntryTactics.includes(tactic) ? "default" : "outline"} className="h-7 px-2 text-[10px]" onClick={() => {
                      const next = localEntryTactics.includes(tactic)
                        ? localEntryTactics.filter((value) => value !== tactic)
                        : [...localEntryTactics, tactic]
                      if (next.length === 0) return
                      setLocalEntryTactics(next)
                      saveConfig({ entryTactics: next })
                    }}>{tactic.replace("_", " ")}</Button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <span className="text-xs text-muted-foreground">Independent exit tactics</span>
                <div className="flex flex-wrap gap-1">
                  {(["bracket", "momentum_reversal", "relative", "time"] as const).map((tactic) => (
                    <Button key={tactic} size="sm" variant={localExitTactics.includes(tactic) ? "default" : "outline"} className="h-7 px-2 text-[10px]" onClick={() => {
                      const next = localExitTactics.includes(tactic)
                        ? localExitTactics.filter((value) => value !== tactic)
                        : [...localExitTactics, tactic]
                      if (next.length === 0) return
                      setLocalExitTactics(next)
                      saveConfig({ exitTactics: next })
                    }}>{tactic.replace("_", " ")}</Button>
                  ))}
                </div>
              </div>

              <div className="space-y-2 md:col-span-2">
                <span className="text-xs text-muted-foreground">Independent coordination types</span>
                <div className="flex flex-wrap gap-1">
                  {([
                    ["standard", "Standard"],
                    ["trailing_fixed", "Trailing Fixed"],
                    ["trailing_auto", "Trailing Auto"],
                    ["combination", "Combination"],
                    ["inverse", "Inverse Long/Short"],
                    ["high_protection", "High TP / SL 0.75"],
                  ] as const).map(([type, label]) => (
                    <Button key={type} size="sm" variant={localStrategyTypes.includes(type) ? "default" : "outline"} className="h-7 px-2 text-[10px]" onClick={() => {
                      const next = localStrategyTypes.includes(type)
                        ? localStrategyTypes.filter((value) => value !== type)
                        : [...localStrategyTypes, type]
                      if (next.length === 0) return
                      setLocalStrategyTypes(next)
                      saveConfig({ strategyTypes: next })
                    }}>{label}</Button>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground/70 leading-tight">Each type has a separate signal lineage, set key, position evaluation and deactivation record.</p>
              </div>

              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Entry confirmation</span>
                <Select value={localEntryTiming} onValueChange={(value: "current" | "last_confirmed") => {
                  setLocalEntryTiming(value)
                  saveConfig({ entryTiming: value })
                }}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="current">Current active candle</SelectItem>
                    <SelectItem value="last_confirmed">Last confirmed candle</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-xs"><span className="text-muted-foreground">Activity volume ratio</span><span className="font-mono font-medium">{localActivityVolumeRatio.toFixed(2)}×</span></div>
                <input aria-label="Direct-Trade activity volume ratio" className="h-8 w-full rounded border bg-background px-2 font-mono text-xs" type="number" min={0} step={0.05} value={localActivityVolumeRatio} onChange={(event) => {
                  const value = Math.max(0, Number(event.target.value) || 0)
                  setLocalActivityVolumeRatio(value)
                  saveConfig({ activityVolumeRatio: value })
                }} />
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-xs"><span className="text-muted-foreground">Maximum hold (minutes)</span><span className="font-mono font-medium">{localMaxHoldMinutes}</span></div>
                <input aria-label="Direct-Trade maximum hold in minutes" className="h-8 w-full rounded border bg-background px-2 font-mono text-xs" type="number" min={1} step={1} value={localMaxHoldMinutes} onChange={(event) => {
                  const value = Math.max(1, Math.floor(Number(event.target.value) || 1))
                  setLocalMaxHoldMinutes(value)
                  saveConfig({ maxHoldMinutes: value })
                }} />
              </div>

              {/* Pos Count Window (Last N for PF/DDT evaluation) */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Eval Window (Last N Pos)</span>
                  <span className="font-mono font-medium">{localPrevPosWindow}</span>
                </div>
                <Slider
                  value={[localPrevPosWindow]}
                  min={5}
                  max={100}
                  step={5}
                  onValueChange={([v]) => {
                    setLocalPrevPosWindow(v)
                    saveConfig({ prevPosWindow: v })
                  }}
                />
              </div>

              {/* Pos Count Min (minimum positions before PF eval activates) */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Min Pos for Eval</span>
                  <span className="font-mono font-medium">{localPrevPosMinCount}</span>
                </div>
                <Slider
                  value={[localPrevPosMinCount]}
                  min={1}
                  max={25}
                  step={1}
                  onValueChange={([v]) => {
                    setLocalPrevPosMinCount(v)
                    saveConfig({ prevPosMinCount: v })
                  }}
                />
              </div>

              {/* Eval Pos Count (positions used for coordination checks) */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Coord. Eval Count</span>
                  <span className="font-mono font-medium">{localEvalPosCount}</span>
                </div>
                <Slider
                  value={[localEvalPosCount]}
                  min={3}
                  max={50}
                  step={1}
                  onValueChange={([v]) => {
                    setLocalEvalPosCount(v)
                    saveConfig({ evalPosCount: v })
                  }}
                />
              </div>

              {/* Keep-Enabled Pos Count (per symbol/direction/config independent check) */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Keep-Enabled Check (N Pos)</span>
                  <span className="font-mono font-medium">{localKeepEnabledPosCount}</span>
                </div>
                <Slider
                  value={[localKeepEnabledPosCount]}
                  min={3}
                  max={30}
                  step={1}
                  onValueChange={([v]) => {
                    setLocalKeepEnabledPosCount(v)
                    saveConfig({ keepEnabledPosCount: v })
                  }}
                />
                <p className="text-[10px] text-muted-foreground/70 leading-tight">
                  Per symbol/direction/config: disables config if last N pos PF &lt; min or DDT &gt; max
                </p>
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Permanent Deactivation (N Pos)</span>
                  <span className="font-mono font-medium">{localDeactivatePosCount}</span>
                </div>
                <Slider
                  value={[localDeactivatePosCount]}
                  min={3}
                  max={50}
                  step={1}
                  onValueChange={([v]) => {
                    setLocalDeactivatePosCount(v)
                    saveConfig({ deactivatePosCount: v })
                  }}
                />
                <p className="text-[10px] text-muted-foreground/70 leading-tight">A negative average over this exact config's latest window stays disabled after restart. Default: 16.</p>
              </div>

              {/* Trailing Switch */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Trailing Stop</span>
                <Switch
                  checked={localTrailing}
                  onCheckedChange={(v) => {
                    setLocalTrailing(v)
                    saveConfig({ trailingEnabled: v })
                  }}
                />
              </div>

              {/* Block Strategy Switch */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Block Strategy</span>
                <Switch
                  checked={localBlock}
                  onCheckedChange={(v) => {
                    setLocalBlock(v)
                    saveConfig({ blockRange: v ? [1, localBlockMax] : [0, 0] })
                  }}
                />
              </div>
            </div>
          )}

          {/* Stats Grid */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Performance Stats</span>
            </div>

            {/* Overall Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <div className="bg-muted/40 rounded p-2">
                <div className="text-muted-foreground">Total PnL</div>
                <div className={`font-mono font-bold ${pnlColor(stats.totalPnl)}`}>
                  {formatPnl(stats.totalPnl)}
                </div>
              </div>
              <div className="bg-muted/40 rounded p-2">
                <div className="text-muted-foreground">Profit Factor</div>
                  <div className="font-mono font-bold">{formatPF(stats.profitFactor, stats.profitFactorInfinite)}</div>
              </div>
              <div className="bg-muted/40 rounded p-2">
                <div className="text-muted-foreground">Win/Loss</div>
                <div className="font-mono font-bold">{stats.winCount}/{stats.lossCount}</div>
              </div>
              <div className="bg-muted/40 rounded p-2">
                <div className="text-muted-foreground">Max DDT</div>
                <div className="font-mono font-bold">{formatDDT(stats.maxDrawdownTimeMin)}</div>
              </div>
            </div>

            {/* Rolling Position Stats */}
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="text-left py-1 pr-3">Window</th>
                    <th className="text-right py-1 px-2">PF</th>
                    <th className="text-right py-1 px-2">DDT</th>
                    <th className="text-right py-1 px-2">PnL</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  <tr className="border-b border-dashed">
                    <td className="py-1 pr-3">Last 12 Pos</td>
                    <td className="text-right px-2">{formatPF(stats.last12Pos.pf, stats.last12Pos.pfInfinite)}</td>
                    <td className="text-right px-2">{formatDDT(stats.last12Pos.ddt)}</td>
                    <td className={`text-right px-2 ${pnlColor(stats.last12Pos.pnl)}`}>{formatPnl(stats.last12Pos.pnl)}</td>
                  </tr>
                  <tr className="border-b border-dashed">
                    <td className="py-1 pr-3">Last 25 Pos</td>
                    <td className="text-right px-2">{formatPF(stats.last25Pos.pf, stats.last25Pos.pfInfinite)}</td>
                    <td className="text-right px-2">{formatDDT(stats.last25Pos.ddt)}</td>
                    <td className={`text-right px-2 ${pnlColor(stats.last25Pos.pnl)}`}>{formatPnl(stats.last25Pos.pnl)}</td>
                  </tr>
                  <tr className="border-b border-dashed">
                    <td className="py-1 pr-3">Last 50 Pos</td>
                    <td className="text-right px-2">{formatPF(stats.last50Pos.pf, stats.last50Pos.pfInfinite)}</td>
                    <td className="text-right px-2">{formatDDT(stats.last50Pos.ddt)}</td>
                    <td className={`text-right px-2 ${pnlColor(stats.last50Pos.pnl)}`}>{formatPnl(stats.last50Pos.pnl)}</td>
                  </tr>
                  <tr className="border-b border-dashed">
                    <td className="py-1 pr-3 flex items-center gap-1"><Clock className="h-3 w-3" /> Last 4h</td>
                    <td className="text-right px-2">{formatPF(stats.last4h.pf, stats.last4h.pfInfinite)}</td>
                    <td className="text-right px-2">{formatDDT(stats.last4h.ddt)}</td>
                    <td className={`text-right px-2 ${pnlColor(stats.last4h.pnl)}`}>{formatPnl(stats.last4h.pnl)}</td>
                  </tr>
                  <tr className="border-b border-dashed">
                    <td className="py-1 pr-3 flex items-center gap-1"><Clock className="h-3 w-3" /> Last 12h</td>
                    <td className="text-right px-2">{formatPF(stats.last12h.pf, stats.last12h.pfInfinite)}</td>
                    <td className="text-right px-2">{formatDDT(stats.last12h.ddt)}</td>
                    <td className={`text-right px-2 ${pnlColor(stats.last12h.pnl)}`}>{formatPnl(stats.last12h.pnl)}</td>
                  </tr>
                  <tr>
                    <td className="py-1 pr-3 flex items-center gap-1"><Clock className="h-3 w-3" /> Last 48h</td>
                    <td className="text-right px-2">{formatPF(stats.last48h.pf, stats.last48h.pfInfinite)}</td>
                    <td className="text-right px-2">{formatDDT(stats.last48h.ddt)}</td>
                    <td className={`text-right px-2 ${pnlColor(stats.last48h.pnl)}`}>{formatPnl(stats.last48h.pnl)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Active Configs Summary */}
            {activeConfigs > 0 && (
              <div className="text-xs text-muted-foreground flex items-center gap-2 pt-1">
                <Zap className="h-3 w-3" />
                <span>{activeConfigs} active configs across {localTimeframes.length} timeframes</span>
                {state.enabled && <span>| Processing every {state.processingIntervalMs || 280}ms</span>}
              </div>
            )}
          </div>
        </>
      )}
    </Card>
  )
}

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
  clampDirectTradeSymbolCount,
  clampDirectTradeVolumeFactor,
  DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_DIRECTION,
  DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_SYMBOL,
  DIRECT_TRADE_EFFECTIVE_VOLUME_RATIO,
  DIRECT_TRADE_MAX_SYMBOLS,
  DIRECT_TRADE_MIN_SYMBOLS,
  DIRECT_TRADE_VOLUME_FACTOR_DEFAULT,
  DIRECT_TRADE_VOLUME_FACTOR_MAX,
  DIRECT_TRADE_VOLUME_FACTOR_MIN,
} from "@/lib/direct-trade-limits"
import { mergePendingDirectTradeConfig } from "@/lib/direct-trade-settings-sync"
import { HIGH_SCALE_SYMBOL_STRESS_TARGET } from "@/lib/symbol-capacity"
import type {
  DirectTradeOverview48h,
  DirectTradeOverviewCategory,
} from "@/lib/direct-trade-overview-stats"
import type { ExchangeAccountPerformance15h } from "@/lib/exchange-account-performance"
import type { DirectTradeIndicationTypeStatsRow } from "@/lib/direct-trade-indication-stats"
import {
  DIRECT_TRADE_ENTRY_TACTICS,
  DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT,
  DIRECT_TRADE_RECENT_PF_DEFAULT,
  DIRECT_TRADE_TAKE_PROFIT_RATIO_DEFAULT_RANGE,
  DIRECT_TRADE_TAKE_PROFIT_RATIO_MAX,
  DIRECT_TRADE_TAKE_PROFIT_RATIO_MIN,
  DIRECT_TRADE_TAKE_PROFIT_RATIO_STEP_DEFAULT,
  DIRECT_TRADE_TRAILING_MIN_TAKE_PROFIT_RATIO_DEFAULT,
  type DirectTradeEntryTactic,
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
  timeframes: ("5m" | "15m" | "30m")[]
  strategyTypes: ("standard" | "trailing_fixed" | "trailing_auto" | "combination" | "inverse" | "high_protection" | "dca")[]
  historyHours: number
  entryTactics: DirectTradeEntryTactic[]
  enabledIndicationTypes: DirectTradeEntryTactic[]
  exitTactics: ("bracket" | "momentum_reversal" | "relative" | "time")[]
  entryTiming: "current" | "last_confirmed"
  activityVolumeRatio: number
  maxHoldMinutes: number
  takeProfitRatioRange: [number, number]
  takeProfitRatioStep: number
  trailingMinTakeProfitRatio: number
  blockRange: [number, number]
  blockVolumeRatio: number
  blockIncrementSteps: number
  blockProfitFactorRatio: number
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
  liveExecutionReady?: boolean
  liveExecutionBlockReason?: string | null
}

interface DirectTradeStats {
  totalOrders: number
  totalFilled: number
  totalPnl: number
  totalPnlUsdt?: number
  winCount: number
  lossCount: number
  breakEvenCount: number
  settledClosedCount: number
  accountingPending: number
  openPositionCount: number
  openingPositionCount: number
  profitFactor: number | null
  profitFactorInfinite?: boolean
  profitFactorPercent?: number
  statsPnlBasis?: "usdt" | "percent"
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

const DIRECT_TRADE_OVERVIEW_CATEGORY_LABELS: Record<DirectTradeOverviewCategory, string> = {
  general: "General",
  trailing: "Trailing",
  block: "Block",
  dca: "DCA",
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
  minVolFactor: DIRECT_TRADE_VOLUME_FACTOR_DEFAULT,
  positionCostPercent: 0.1,
  maxSlRatio: 0.75,
  slRatioStep: 0.25,
  inverseMaxSlRatio: 1.25,
  timeframes: ["5m", "15m", "30m"],
  strategyTypes: ["standard", "trailing_fixed", "trailing_auto", "combination", "inverse", "high_protection", "dca"],
  historyHours: 48,
  entryTactics: ["relative"],
  enabledIndicationTypes: ["relative"],
  exitTactics: ["bracket", "momentum_reversal", "relative", "time"],
  entryTiming: "current",
  activityVolumeRatio: 1,
  maxHoldMinutes: 120,
  takeProfitRatioRange: DIRECT_TRADE_TAKE_PROFIT_RATIO_DEFAULT_RANGE,
  takeProfitRatioStep: DIRECT_TRADE_TAKE_PROFIT_RATIO_STEP_DEFAULT,
  trailingMinTakeProfitRatio: DIRECT_TRADE_TRAILING_MIN_TAKE_PROFIT_RATIO_DEFAULT,
  blockRange: [1, 12],
  blockVolumeRatio: 1,
  blockIncrementSteps: 2,
  blockProfitFactorRatio: 1.1,
  maxPositionsPerSymbol: DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_SYMBOL,
  maxPositionsPerDirection: DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_DIRECTION,
  keepEnabledPosCount: 12,
  deactivatePosCount: 16,
  minProfitFactor: DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT,
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
  breakEvenCount: 0,
  settledClosedCount: 0,
  accountingPending: 0,
  openPositionCount: 0,
  openingPositionCount: 0,
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
  const [overview48h, setOverview48h] = useState<DirectTradeOverview48h | null>(null)
  const [exchangeAccount15h, setExchangeAccount15h] = useState<ExchangeAccountPerformance15h | null>(null)
  const [activeConfigs, setActiveConfigs] = useState(0)
  const [openPositions, setOpenPositions] = useState(0)
  const [closedPositions, setClosedPositions] = useState(0)
  const [accountingPending, setAccountingPending] = useState(0)
  const [indicationTypeStats, setIndicationTypeStats] = useState<DirectTradeIndicationTypeStatsRow[]>([])
  const [disabledConfigs, setDisabledConfigs] = useState(0)
  const [calculationProgress, setCalculationProgress] = useState<{ status?: string; completedSymbols?: number; totalSymbols?: number; evaluatedSets?: number } | null>(null)
  const [processorHealthy, setProcessorHealthy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [calculating, setCalculating] = useState(false)
  const [calculationError, setCalculationError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)
  const [optionsExpanded, setOptionsExpanded] = useState(false)

  // Local config state for sliders (debounced save)
  const [localVolFactor, setLocalVolFactor] = useState(DIRECT_TRADE_VOLUME_FACTOR_DEFAULT)
  const [localPositionCost, setLocalPositionCost] = useState(0.1)
  const [localMaxSl, setLocalMaxSl] = useState(0.75)
  const [localInverseMaxSl, setLocalInverseMaxSl] = useState(1.25)
  const [localMinPF, setLocalMinPF] = useState(DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT)
  const [localMinRecentPF, setLocalMinRecentPF] = useState(DIRECT_TRADE_RECENT_PF_DEFAULT)
  const [localRecentEvaluationPositions, setLocalRecentEvaluationPositions] = useState(12)
  const [localMaxDDT, setLocalMaxDDT] = useState(10)
  const [localSymbolCount, setLocalSymbolCount] = useState(8)
  const [localMaxPosPerSymbol, setLocalMaxPosPerSymbol] = useState(DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_SYMBOL)
  const [localMaxPosPerDir, setLocalMaxPosPerDir] = useState(DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_DIRECTION)
  const [localTrailing, setLocalTrailing] = useState(true)
  const [localBlock, setLocalBlock] = useState(true)
  const [localBlockMax, setLocalBlockMax] = useState(12)
  const [localTimeframes, setLocalTimeframes] = useState<string[]>(["5m", "15m", "30m"])
  const [localStrategyTypes, setLocalStrategyTypes] = useState<string[]>(["standard", "trailing_fixed", "trailing_auto", "combination", "inverse", "high_protection", "dca"])
  const [localHistoryHours, setLocalHistoryHours] = useState(48)
  const [localEntryTactics, setLocalEntryTactics] = useState<DirectTradeEntryTactic[]>([...DIRECT_TRADE_ENTRY_TACTICS])
  const [localEnabledIndicationTypes, setLocalEnabledIndicationTypes] = useState<DirectTradeEntryTactic[]>(["relative"])
  const [localExitTactics, setLocalExitTactics] = useState<string[]>(["bracket", "momentum_reversal", "relative", "time"])
  const [localEntryTiming, setLocalEntryTiming] = useState<"current" | "last_confirmed">("current")
  const [localActivityVolumeRatio, setLocalActivityVolumeRatio] = useState(1)
  const [localMaxHoldMinutes, setLocalMaxHoldMinutes] = useState(120)
  const [localTakeProfitRatioRange, setLocalTakeProfitRatioRange] = useState<[number, number]>(DIRECT_TRADE_TAKE_PROFIT_RATIO_DEFAULT_RANGE)
  const [localTakeProfitRatioStep, setLocalTakeProfitRatioStep] = useState(DIRECT_TRADE_TAKE_PROFIT_RATIO_STEP_DEFAULT)
  const [localTrailingMinTakeProfitRatio, setLocalTrailingMinTakeProfitRatio] = useState(DIRECT_TRADE_TRAILING_MIN_TAKE_PROFIT_RATIO_DEFAULT)
  const [localSymbolOrder, setLocalSymbolOrder] = useState<string>("volatility_1h")
  // Pos Count evaluation windows (for PF/DDT historic coordination calculations)
  const [localPrevPosWindow, setLocalPrevPosWindow] = useState(25)
  const [localPrevPosMinCount, setLocalPrevPosMinCount] = useState(5)
  const [localEvalPosCount, setLocalEvalPosCount] = useState(12)
  // Keep-enabled check: per symbol/direction/config independent evaluation
  const [localKeepEnabledPosCount, setLocalKeepEnabledPosCount] = useState(12)
  const [localDeactivatePosCount, setLocalDeactivatePosCount] = useState(16)

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const statusRequestInFlightRef = useRef(false)
  const statusRequestGenerationRef = useRef(0)
  const accountRequestInFlightRef = useRef(false)
  const accountRequestGenerationRef = useRef(0)
  const pendingConfigRef = useRef(new Map<string, {
    connectionId: string | null
    updates: Record<string, unknown>
  }>())
  const pendingConfigKeysRef = useRef(new Set<string>())
  const configSaveInFlightRef = useRef(false)
  const flushConfigRef = useRef<(() => Promise<void>) | null>(null)
  const [savingConfig, setSavingConfig] = useState(false)
  const [configSaveError, setConfigSaveError] = useState<string | null>(null)

  const applyRemoteState = useCallback((remoteState: DirectTradeState) => {
    const pendingKeys = pendingConfigKeysRef.current
    const isPending = (key: string) => pendingKeys.has(key)
    setState((current) => mergePendingDirectTradeConfig(remoteState, current, pendingKeys))
    if (!isPending("minVolFactor")) setLocalVolFactor(clampDirectTradeVolumeFactor(remoteState.minVolFactor))
    if (!isPending("positionCostPercent")) setLocalPositionCost(remoteState.positionCostPercent ?? 0.1)
    if (!isPending("maxSlRatio")) setLocalMaxSl(remoteState.maxSlRatio ?? 0.75)
    if (!isPending("inverseMaxSlRatio")) setLocalInverseMaxSl(remoteState.inverseMaxSlRatio ?? 1.25)
    if (!isPending("symbolCount")) setLocalSymbolCount(remoteState.symbolCount || 8)
    if (!isPending("maxPositionsPerSymbol")) setLocalMaxPosPerSymbol(remoteState.maxPositionsPerSymbol || DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_SYMBOL)
    if (!isPending("maxPositionsPerDirection")) setLocalMaxPosPerDir(remoteState.maxPositionsPerDirection || DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_DIRECTION)
    if (!isPending("timeframes")) setLocalTimeframes(remoteState.timeframes || ["5m", "15m", "30m"])
    if (!isPending("strategyTypes")) setLocalStrategyTypes(remoteState.strategyTypes || ["standard", "trailing_fixed", "trailing_auto", "combination", "inverse", "high_protection", "dca"])
    if (!isPending("historyHours")) setLocalHistoryHours(remoteState.historyHours ?? 48)
    if (!isPending("entryTactics")) setLocalEntryTactics(remoteState.entryTactics || ["momentum", "mean_reversion", "breakout", "relative"])
    if (!isPending("enabledIndicationTypes")) {
      setLocalEnabledIndicationTypes(Array.isArray(remoteState.enabledIndicationTypes)
        ? remoteState.enabledIndicationTypes
        : remoteState.entryTactics || ["relative"])
    }
    if (!isPending("exitTactics")) setLocalExitTactics(remoteState.exitTactics || ["bracket", "momentum_reversal", "relative", "time"])
    if (!isPending("entryTiming")) setLocalEntryTiming(remoteState.entryTiming === "last_confirmed" ? "last_confirmed" : "current")
    if (!isPending("activityVolumeRatio")) setLocalActivityVolumeRatio(remoteState.activityVolumeRatio ?? 1)
    if (!isPending("maxHoldMinutes")) setLocalMaxHoldMinutes(remoteState.maxHoldMinutes ?? 120)
    if (!isPending("takeProfitRatioRange")) setLocalTakeProfitRatioRange(remoteState.takeProfitRatioRange ?? DIRECT_TRADE_TAKE_PROFIT_RATIO_DEFAULT_RANGE)
    if (!isPending("takeProfitRatioStep")) setLocalTakeProfitRatioStep(remoteState.takeProfitRatioStep ?? DIRECT_TRADE_TAKE_PROFIT_RATIO_STEP_DEFAULT)
    if (!isPending("trailingMinTakeProfitRatio")) setLocalTrailingMinTakeProfitRatio(remoteState.trailingMinTakeProfitRatio ?? DIRECT_TRADE_TRAILING_MIN_TAKE_PROFIT_RATIO_DEFAULT)
    if (!isPending("symbolOrder")) setLocalSymbolOrder(remoteState.symbolOrder || "volatility_1h")
    if (!isPending("blockRange")) {
      setLocalBlock(remoteState.blockRange?.[1] > 0)
      setLocalBlockMax(remoteState.blockRange?.[1] || 12)
    }
    if (!isPending("minProfitFactor")) setLocalMinPF(remoteState.minProfitFactor ?? DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT)
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
    if (statusRequestInFlightRef.current) return
    statusRequestInFlightRef.current = true
    const requestGeneration = ++statusRequestGenerationRef.current
    try {
      const query = selectedConnectionId
        ? `?connectionId=${encodeURIComponent(selectedConnectionId)}`
        : ""
      const res = await fetch(`/api/trade-engine/direct-trade/status${query}`, { cache: "no-store" })
      if (!res.ok) return
      const data = await res.json()
      if (requestGeneration !== statusRequestGenerationRef.current) return
      if (data.state) {
        applyRemoteState(data.state)
      }
      if (data.stats) setStats({ ...DEFAULT_STATS, ...data.stats })
      if (data.overview48h) setOverview48h(data.overview48h)
      if (data.activeConfigs !== undefined) setActiveConfigs(data.activeConfigs)
      if (data.openPositions !== undefined) setOpenPositions(data.openPositions)
      if (data.closedPositions !== undefined) setClosedPositions(data.closedPositions)
      if (data.accountingPending !== undefined) setAccountingPending(data.accountingPending)
      setIndicationTypeStats(Array.isArray(data.indicationTypeStats) ? data.indicationTypeStats : [])
      if (data.disabledConfigs !== undefined) setDisabledConfigs(data.disabledConfigs)
      setCalculationProgress(data.calculationProgress && typeof data.calculationProgress === "object" ? data.calculationProgress : null)
      if (data.processor) setProcessorHealthy(data.processor.isHealthy || false)
    } catch {} finally {
      statusRequestInFlightRef.current = false
    }
  }, [applyRemoteState, selectedConnectionId])

  useEffect(() => {
    // Do not render one exchange connection's Direct-Trade state while the
    // newly selected independent Redis scope is loading.
    statusRequestGenerationRef.current++
    accountRequestGenerationRef.current++
    setState({ ...DEFAULT_STATE, connectionId: selectedConnectionId })
    setStats(DEFAULT_STATS)
    setOverview48h(null)
    setActiveConfigs(0)
    setOpenPositions(0)
    setClosedPositions(0)
    setAccountingPending(0)
    setIndicationTypeStats([])
    setDisabledConfigs(0)
    setCalculationProgress(null)
    setProcessorHealthy(false)
  }, [selectedConnectionId])

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 3000)
    return () => clearInterval(interval)
  }, [fetchStatus])

  const fetchExchangeAccount = useCallback(async () => {
    if (accountRequestInFlightRef.current) return
    accountRequestInFlightRef.current = true
    const requestGeneration = ++accountRequestGenerationRef.current
    try {
      const connectionId = selectedConnectionId ?? state.connectionId
      const query = connectionId
        ? `?connectionId=${encodeURIComponent(String(connectionId))}`
        : ""
      const response = await fetch(`/api/exchange/live-summary${query}`, { cache: "no-store" })
      if (!response.ok) return
      const payload = await response.json()
      if (requestGeneration === accountRequestGenerationRef.current && payload.accountPerformance15h) {
        setExchangeAccount15h(payload.accountPerformance15h)
      }
    } catch {} finally {
      accountRequestInFlightRef.current = false
    }
  }, [selectedConnectionId, state.connectionId])

  useEffect(() => {
    void fetchExchangeAccount()
    const interval = setInterval(fetchExchangeAccount, 10_000)
    return () => clearInterval(interval)
  }, [fetchExchangeAccount])

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
          enabledIndicationTypes: localEnabledIndicationTypes,
          exitTactics: localExitTactics,
          entryTiming: localEntryTiming,
          activityVolumeRatio: localActivityVolumeRatio,
          maxHoldMinutes: localMaxHoldMinutes,
          takeProfitRatioRange: localTakeProfitRatioRange,
          takeProfitRatioStep: localTakeProfitRatioStep,
          trailingMinTakeProfitRatio: localTrailingMinTakeProfitRatio,
          blockRange: localBlock ? [1, localBlockMax] : [0, 0],
          blockVolumeRatio: state.blockVolumeRatio,
          blockIncrementSteps: state.blockIncrementSteps,
          blockProfitFactorRatio: state.blockProfitFactorRatio,
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
    if (!state.liveMode && state.liveExecutionReady === false) {
      setCalculationError(state.liveExecutionBlockReason || "Direct-Trade live execution is not ready")
      return
    }
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
    } catch (error) {
      setCalculationError(error instanceof Error ? error.message : "Live mode update failed")
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
          trailingMinTakeProfitRatio: localTrailingMinTakeProfitRatio,
          blockRange: localBlock ? [1, localBlockMax] : [0, 0],
          blockVolumeRatio: state.blockVolumeRatio,
          blockIncrementSteps: state.blockIncrementSteps,
          blockProfitFactorRatio: state.blockProfitFactorRatio,
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
    const nextBatch = pendingConfigRef.current.entries().next().value as
      | [string, { connectionId: string | null; updates: Record<string, unknown> }]
      | undefined
    if (!nextBatch) return
    const [batchKey, batch] = nextBatch
    pendingConfigRef.current.delete(batchKey)
    const updates = batch.updates
    const updateKeys = Object.keys(updates)
    if (updateKeys.length === 0) return
    // Bind this exact debounced batch to the card/connection on which it was
    // created. A connection switch while the request is in flight must never
    // redirect X01 settings into X02 (or into the legacy global scope).
    const updateScopeConnectionId = batch.connectionId
    configSaveInFlightRef.current = true
    setSavingConfig(true)
    try {
      const response = await fetch("/api/trade-engine/direct-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update-config",
          ...updates,
          ...(updateScopeConnectionId ? { connectionId: updateScopeConnectionId } : {}),
        }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.success !== true || !payload?.state) {
        throw new Error(payload?.error || "Direct-Trade settings were not accepted")
      }
      for (const key of updateKeys) {
        const hasNewerPendingValue = [...pendingConfigRef.current.values()].some((pending) =>
          Object.prototype.hasOwnProperty.call(pending.updates, key),
        )
        if (!hasNewerPendingValue) {
          pendingConfigKeysRef.current.delete(key)
        }
      }
      applyRemoteState(payload.state)
      setConfigSaveError(null)
    } catch (error) {
      for (const key of updateKeys) {
        const hasNewerPendingValue = [...pendingConfigRef.current.values()].some((pending) =>
          Object.prototype.hasOwnProperty.call(pending.updates, key),
        )
        if (!hasNewerPendingValue) {
          pendingConfigKeysRef.current.delete(key)
        }
      }
      setConfigSaveError(error instanceof Error ? error.message : "Direct-Trade settings could not be saved")
      void fetchStatus()
    } finally {
      configSaveInFlightRef.current = false
      setSavingConfig(false)
      if (pendingConfigRef.current.size > 0) {
        void flushConfigRef.current?.()
      }
    }
  }, [applyRemoteState, fetchStatus])

  flushConfigRef.current = flushConfig

  const saveConfig = useCallback((updates: Record<string, unknown>) => {
    const scopeConnectionId = selectedConnectionId ?? state.connectionId ?? null
    const scopeKey = scopeConnectionId || "__global__"
    const pending = pendingConfigRef.current.get(scopeKey)
    pendingConfigRef.current.set(scopeKey, {
      connectionId: scopeConnectionId,
      updates: { ...(pending?.updates || {}), ...updates },
    })
    for (const key of Object.keys(updates)) pendingConfigKeysRef.current.add(key)
    setState((current) => ({ ...current, ...(updates as Partial<DirectTradeState>) }))
    setConfigSaveError(null)
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = setTimeout(() => void flushConfig(), 350)
  }, [flushConfig, selectedConnectionId, state.connectionId])

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
                // A stale persisted live flag must remain switchable back to
                // paper mode even while new live entries are fail-closed.
                // Only the unsafe direction (paper -> live) is disabled.
                disabled={state.liveExecutionReady === false && !state.liveMode}
                title={state.liveExecutionBlockReason || undefined}
                className="data-[state=checked]:bg-red-500"
              />
            </div>
            {state.liveExecutionReady === false && (
              <span className="max-w-xl text-xs text-amber-700">
                Live entry disabled: {state.liveExecutionBlockReason}
              </span>
            )}

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
              <span className="text-muted-foreground" title="Evaluated parameter lineages, not physical positions">Variants: <strong>{activeConfigs}</strong></span>
              <span className="text-muted-foreground">Open: <strong>{openPositions}</strong></span>
              <span
                className="text-muted-foreground"
                title="Confirmed Direct-Trade entry, Block and DCA fills; rejected or unconfirmed submissions are excluded"
              >
                Confirmed fills: <strong data-testid="direct-trade-orders-count">{stats.totalFilled.toLocaleString()}</strong>
              </span>
              <span className="text-muted-foreground">Closed: <strong>{closedPositions}</strong></span>
              <span className="text-muted-foreground">Disabled: <strong>{disabledConfigs}</strong></span>
              <span className={pnlColor(state.liveMode ? Number(stats.totalPnlUsdt || 0) : stats.totalPnl)}>
                {state.liveMode ? "Exchange PnL" : "Paper PnL"}: <strong>{state.liveMode
                  ? `${Number(stats.totalPnlUsdt || 0) >= 0 ? "+" : ""}${Number(stats.totalPnlUsdt || 0).toFixed(4)} USDT`
                  : formatPnl(stats.totalPnl)}</strong>
              </span>
              {accountingPending > 0 && <span className="text-amber-600">Accounting pending: <strong>{accountingPending}</strong></span>}
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
                  </span> configuration variants indexed
                </span>
              ) : calculationProgress?.status === "ready" ? (
                <span>Direct-Trade calculation ready · {(calculationProgress.evaluatedSets || 0).toLocaleString()} configuration variants indexed</span>
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
                  <span className="text-muted-foreground">Direct-Trade volume factor</span>
                  <span className="font-mono font-medium">{clampDirectTradeVolumeFactor(localVolFactor).toFixed(1)}×</span>
                </div>
                <Slider
                  aria-label="Direct-Trade volume factor"
                  value={[clampDirectTradeVolumeFactor(localVolFactor)]}
                  min={DIRECT_TRADE_VOLUME_FACTOR_MIN}
                  max={DIRECT_TRADE_VOLUME_FACTOR_MAX}
                  step={0.1}
                  onValueChange={([value]) => {
                    const v = clampDirectTradeVolumeFactor(value)
                    setLocalVolFactor(v)
                    saveConfig({ minVolFactor: v })
                  }}
                />
                <p className="text-[10px] text-muted-foreground/70 leading-tight">0.1–10, default 0.1. Effective request is factor × {DIRECT_TRADE_EFFECTIVE_VOLUME_RATIO}; the connector raises it only to the smallest executable exchange lot when required.</p>
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
                <p className="text-[10px] text-muted-foreground/70 leading-tight">The two handles accept every 2–22× ratio. The default 1× step materialises every PositionCost coordinate in the selected range; larger operator-selected steps remain supported.</p>
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Trailing from TP step</span>
                  <span className="font-mono font-medium">{localTrailingMinTakeProfitRatio}× PositionCost</span>
                </div>
                <Slider
                  aria-label="Direct-Trade trailing minimum take-profit PositionCost ratio"
                  value={[localTrailingMinTakeProfitRatio]}
                  min={DIRECT_TRADE_TAKE_PROFIT_RATIO_MIN}
                  max={DIRECT_TRADE_TAKE_PROFIT_RATIO_MAX}
                  step={1}
                  disabled={!localTrailing}
                  onValueChange={([value]) => {
                    setLocalTrailingMinTakeProfitRatio(value)
                    saveConfig({ trailingMinTakeProfitRatio: value })
                  }}
                />
                <p className="text-[10px] text-muted-foreground/70 leading-tight">Only trailed variants at or above this TP multiple are calculated/opened. Normal, DCA and non-trailing combination lanes below it remain independent.</p>
              </div>

              {/* Symbol Count */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Symbol Count</span>
                  <span className="font-mono font-medium">{localSymbolCount}</span>
                </div>
                <Slider
                  value={[localSymbolCount]}
                  min={DIRECT_TRADE_MIN_SYMBOLS}
                  max={DIRECT_TRADE_MAX_SYMBOLS}
                  step={1}
                  onValueChange={([v]) => {
                    setLocalSymbolCount(v)
                    saveConfig({ symbolCount: v })
                  }}
                />
                <input
                  aria-label="Direct-Trade symbol count"
                  className="h-7 w-full rounded border bg-background px-2 font-mono text-xs"
                  type="number"
                  min={DIRECT_TRADE_MIN_SYMBOLS}
                  max={DIRECT_TRADE_MAX_SYMBOLS}
                  value={localSymbolCount}
                  onChange={(event) => {
                    const count = clampDirectTradeSymbolCount(event.target.value, localSymbolCount)
                    setLocalSymbolCount(count)
                    saveConfig({ symbolCount: count })
                  }}
                />
                <div className="flex flex-wrap gap-1">
                  {[32, HIGH_SCALE_SYMBOL_STRESS_TARGET, DIRECT_TRADE_MAX_SYMBOLS].map((count) => (
                    <Button
                      key={count}
                      type="button"
                      size="sm"
                      variant={localSymbolCount === count ? "secondary" : "outline"}
                      className="h-6 px-2 text-[10px]"
                      onClick={() => {
                        setLocalSymbolCount(count)
                        saveConfig({ symbolCount: count })
                      }}
                    >
                      {count === DIRECT_TRADE_MAX_SYMBOLS ? "All" : count}
                    </Button>
                  ))}
                </div>
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
                  max={6}
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
                  {(["5m", "15m", "30m"] as const).map((tf) => (
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

              <div className="space-y-3 rounded-lg border bg-background/70 p-3 md:col-span-2 lg:col-span-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-medium">Live entry indication types</div>
                    <p className="text-[10px] text-muted-foreground">These sliders control only new exchange entries. Internal historical calculation and validation continue for every calculated type.</p>
                  </div>
                  <Badge variant={localEnabledIndicationTypes.length > 0 ? "outline" : "secondary"} className="text-[9px]">
                    {localEnabledIndicationTypes.length > 0 ? `${localEnabledIndicationTypes.length} enabled` : "All live entries blocked"}
                  </Badge>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {DIRECT_TRADE_ENTRY_TACTICS.map((tactic) => {
                    const checked = localEnabledIndicationTypes.includes(tactic)
                    return (
                      <label key={tactic} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs">
                        <span className="capitalize">{tactic.replace("_", " ")}</span>
                        <Switch
                          aria-label={`Enable ${tactic.replace("_", " ")} Direct-Trade live entries`}
                          checked={checked}
                          onCheckedChange={(nextChecked) => {
                            const next = nextChecked
                              ? [...localEnabledIndicationTypes, tactic]
                              : localEnabledIndicationTypes.filter((value) => value !== tactic)
                            setLocalEnabledIndicationTypes(next)
                            saveConfig({ enabledIndicationTypes: next })
                          }}
                        />
                      </label>
                    )
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <span className="text-xs text-muted-foreground">Calculated indication types</span>
                <div className="flex flex-wrap gap-1">
                  {DIRECT_TRADE_ENTRY_TACTICS.map((tactic) => (
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
                <p className="text-[10px] text-muted-foreground/70 leading-tight">This matrix remains active in Live mode so simulated historic results can be compared with settled exchange results.</p>
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
                    ["dca", "DCA · 5× capped"],
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

          {/* Canonical 48h Direct-Trade Overview */}
          <div className="space-y-3 rounded-xl border bg-gradient-to-br from-background via-background to-muted/30 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold">Direct-Trade Overview</span>
                <Badge variant="outline" className="text-[10px]">Last 48 hours</Badge>
              </div>
              <span className="text-[10px] text-muted-foreground">
                Open = active now · Count/PF/DDT = realised closes only
              </span>
            </div>

            <div className="grid gap-3 xl:grid-cols-2">
              {(overview48h?.environments || []).map((environment) => (
                <div key={environment.mode} className="overflow-hidden rounded-lg border bg-background/80">
                  <div className="flex items-center justify-between border-b bg-muted/35 px-3 py-2">
                    <span className="text-xs font-semibold">
                      {environment.mode === "simulated" ? "Simulated Strategies" : "Exchange (Live) Strategies"}
                    </span>
                    <Badge
                      variant={environment.mode === "exchange" ? "destructive" : "secondary"}
                      className="text-[9px]"
                    >
                      {environment.mode === "exchange" ? "LIVE" : "SIM"}
                    </Badge>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[420px] text-[11px]">
                      <thead className="text-muted-foreground">
                        <tr className="border-b">
                          <th className="px-3 py-1.5 text-left font-medium">Strategy</th>
                          <th className="px-2 py-1.5 text-right font-medium" title="Currently active running positions">Open</th>
                          <th className="px-2 py-1.5 text-right font-medium" title="Closed positions inside the exact 48-hour window">Count</th>
                          <th className="px-2 py-1.5 text-right font-medium" title="Weighted average PF: sum of realised gains divided by absolute sum of realised losses">PF (avg.)</th>
                          <th className="px-3 py-1.5 text-right font-medium" title="Overall time spent below the prior realised-equity peak in this 48-hour window">DDT (overall)</th>
                        </tr>
                      </thead>
                      <tbody className="font-mono">
                        {environment.rows.map((row) => (
                          <tr key={row.category} className="border-b border-dashed last:border-0">
                            <td className="px-3 py-1.5 font-sans font-medium">
                              {DIRECT_TRADE_OVERVIEW_CATEGORY_LABELS[row.category]}
                            </td>
                            <td className="px-2 py-1.5 text-right">{row.open}</td>
                            <td className="px-2 py-1.5 text-right">{row.closed}</td>
                            <td className="px-2 py-1.5 text-right">
                              {formatPF(row.profitFactor, row.profitFactorInfinite)}
                            </td>
                            <td className="px-3 py-1.5 text-right" title={`Longest episode ${formatDDT(row.maxDrawdownEpisodeMin)} · current ${formatDDT(row.currentDrawdownTimeMin)}`}>
                              {formatDDT(row.overallDrawdownTimeMin)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
              {!overview48h && (
                <div className="col-span-full rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                  Loading verified 48-hour position statistics…
                </div>
              )}
            </div>

            <div className="rounded-lg border border-red-500/20 bg-red-500/[0.035] p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Activity className="h-3.5 w-3.5 text-red-500" />
                  <span className="text-xs font-semibold">At Exchange</span>
                  <span className="text-[10px] text-muted-foreground">verified connector account data</span>
                </div>
                <span className="text-[10px] text-muted-foreground">
                  PnL Ratio = current Equity / Balance 15h ago · 1.000 neutral
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="rounded-md bg-background/75 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Balance</div>
                  <div className="font-mono text-sm font-semibold">
                    {exchangeAccount15h?.balance == null
                      ? "—"
                      : `${exchangeAccount15h.balance.toFixed(2)} ${exchangeAccount15h.currency}`}
                  </div>
                </div>
                <div className="rounded-md bg-background/75 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Equity</div>
                  <div className="font-mono text-sm font-semibold">
                    {exchangeAccount15h?.equity == null
                      ? "—"
                      : `${exchangeAccount15h.equity.toFixed(2)} ${exchangeAccount15h.currency}`}
                  </div>
                </div>
                <div className="rounded-md bg-background/75 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">PnL Ratio · 15h</div>
                  <div className={`font-mono text-sm font-semibold ${pnlColor(exchangeAccount15h?.pnlPercent || 0)}`}>
                    {exchangeAccount15h?.pnlRatio == null
                      ? "—"
                      : `${exchangeAccount15h.pnlRatio.toFixed(4)}× (${exchangeAccount15h.pnlPercent! >= 0 ? "+" : ""}${exchangeAccount15h.pnlPercent!.toFixed(2)}%)`}
                  </div>
                </div>
              </div>
              {!exchangeAccount15h?.available && (
                <p className="mt-2 text-[10px] text-muted-foreground">
                  {exchangeAccount15h?.reason === "history-collecting"
                    ? "15-hour baseline is still being collected; Balance and Equity remain current, while the ratio stays unavailable until an exact baseline exists."
                    : exchangeAccount15h?.reason === "currency-mismatch"
                      ? "15-hour ratio unavailable because the baseline currency differs from the current account currency."
                      : "Exchange account values are unavailable until a fresh, non-fallback connector balance is verified."}
                </p>
              )}
            </div>
          </div>

          {/* Stats Grid */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Performance Stats</span>
            </div>

            {/* Overall Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <div className="bg-muted/40 rounded p-2">
                <div className="text-muted-foreground">{state.liveMode ? "Realized exchange PnL" : "Simulated PnL"}</div>
                <div className={`font-mono font-bold ${pnlColor(state.liveMode ? Number(stats.totalPnlUsdt || 0) : stats.totalPnl)}`}>
                  {state.liveMode
                    ? `${Number(stats.totalPnlUsdt || 0) >= 0 ? "+" : ""}${Number(stats.totalPnlUsdt || 0).toFixed(4)} USDT`
                    : formatPnl(stats.totalPnl)}
                </div>
                <div className="text-[10px] text-muted-foreground">{state.liveMode ? `${accountingPending} settlement(s) pending` : "percentage basis"}</div>
              </div>
              <div className="bg-muted/40 rounded p-2">
                <div className="text-muted-foreground">Profit Factor</div>
                  <div className="font-mono font-bold">{formatPF(stats.profitFactor, stats.profitFactorInfinite)}</div>
              </div>
              <div className="bg-muted/40 rounded p-2">
                <div className="text-muted-foreground">Win/Loss/BE</div>
                <div className="font-mono font-bold">{stats.winCount}/{stats.lossCount}/{stats.breakEvenCount}</div>
              </div>
              <div className="bg-muted/40 rounded p-2">
                <div className="text-muted-foreground">Max DDT</div>
                <div className="font-mono font-bold">{formatDDT(stats.maxDrawdownTimeMin)}</div>
              </div>
            </div>

            <div className="overflow-hidden rounded-lg border">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/35 px-3 py-2">
                <div>
                  <div className="text-xs font-semibold">Indication types · results overview</div>
                  <div className="text-[10px] text-muted-foreground">Settled runtime outcomes versus the simultaneous internal historical calculation</div>
                </div>
                <span className="text-[10px] text-muted-foreground">PF coordinate: 1.00 neutral · 1.10 = +1× PositionCost</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1050px] text-[11px]">
                  <thead className="text-muted-foreground">
                    <tr className="border-b">
                      <th className="px-3 py-1.5 text-left font-medium">Indication</th>
                      <th className="px-2 py-1.5 text-center font-medium">Live entry</th>
                      <th className="px-2 py-1.5 text-right font-medium">Open</th>
                      <th className="px-2 py-1.5 text-right font-medium">Closed / pending</th>
                      <th className="px-2 py-1.5 text-right font-medium">W / L / BE</th>
                      <th className="px-2 py-1.5 text-right font-medium">Realized result</th>
                      <th className="px-2 py-1.5 text-right font-medium" title="Classic realised gross-profit / absolute gross-loss Profit Factor">Realized PF</th>
                      <th className="px-2 py-1.5 text-right font-medium" title="1 + 0.1 × Σ net PnL percent / Σ realised PositionCost percent">PF coordinate</th>
                      <th className="px-2 py-1.5 text-right font-medium">Internal valid / eval</th>
                      <th
                        className="px-3 py-1.5 text-right font-medium"
                        title="Average simulated net PnL per independently evaluated alternative set; PF uses aggregate simulated gross profit / absolute gross loss"
                      >
                        Internal avg/set / PF
                      </th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {indicationTypeStats.map((row) => (
                      <tr key={row.indicationType} className="border-b border-dashed last:border-0">
                        <td className="px-3 py-1.5 font-sans font-medium capitalize">{row.indicationType.replace("_", " ")}</td>
                        <td className="px-2 py-1.5 text-center">
                          <Badge variant={row.liveEntryEnabled ? "outline" : "secondary"} className="text-[9px]">
                            {row.liveEntryEnabled ? "On" : "Off"}
                          </Badge>
                        </td>
                        <td className="px-2 py-1.5 text-right">{row.openPositions}</td>
                        <td className="px-2 py-1.5 text-right">{row.closedPositions} / <span className={row.accountingPending > 0 ? "text-amber-600" : ""}>{row.accountingPending}</span></td>
                        <td className="px-2 py-1.5 text-right">{row.wins} / {row.losses} / {row.breakeven}</td>
                        <td className={`px-2 py-1.5 text-right ${pnlColor(state.liveMode ? Number(row.netExchangePnlUsdt || 0) : row.netPnlPercent)}`}>
                          {row.closedPositions === 0
                            ? "—"
                            : state.liveMode
                              ? `${Number(row.netExchangePnlUsdt || 0) >= 0 ? "+" : ""}${Number(row.netExchangePnlUsdt || 0).toFixed(4)} USDT`
                              : formatPnl(row.netPnlPercent)}
                        </td>
                        <td className="px-2 py-1.5 text-right">{formatPF(row.profitFactor, row.profitFactorInfinite)}</td>
                        <td className="px-2 py-1.5 text-right">{row.profitFactorCoordinate == null ? "—" : row.profitFactorCoordinate.toFixed(4)}</td>
                        <td className="px-2 py-1.5 text-right">{row.internalValid.toLocaleString()} / {row.internalEvaluated.toLocaleString()}</td>
                        <td
                          className={`px-3 py-1.5 text-right ${pnlColor(row.internalAveragePnlPerSet)}`}
                          title={`Aggregate across ${row.internalEvaluated.toLocaleString()} alternative sets: ${formatPnl(row.internalTotalPnl)}`}
                        >
                          {formatPnl(row.internalAveragePnlPerSet)} / {formatPF(row.internalProfitFactor, row.internalProfitFactorInfinite)}
                        </td>
                      </tr>
                    ))}
                    {indicationTypeStats.length === 0 ? (
                      <tr><td colSpan={10} className="px-3 py-5 text-center text-muted-foreground">Loading indication-type results…</td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              <p className="border-t px-3 py-2 text-[10px] text-muted-foreground">Open positions and incomplete exchange settlements never enter W/L/BE, PnL or PF. Internal PnL is the average per independently evaluated alternative set; its aggregate sum is available in the cell tooltip and is not portfolio or exchange PnL.</p>
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

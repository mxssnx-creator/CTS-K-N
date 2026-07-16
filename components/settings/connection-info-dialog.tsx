"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  Activity,
  BarChart3,
  CheckCircle2,
  Clock3,
  Database,
  Gauge,
  Layers3,
  Loader2,
  RefreshCw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { boundedPassedCount, boundedPercentage, nonNegativeMetric } from "@/lib/dashboard-metrics"
import { cn } from "@/lib/utils"
import { toast } from "@/lib/simple-toast"

interface ConnectionInfoDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  connectionId: string
  connectionName: string
}

type JsonRecord = Record<string, unknown>
type InfoSection = "overview" | "runtime" | "indications" | "strategies" | "settings"

interface ConnectionInfoSnapshot {
  connection: JsonRecord
  settings: JsonRecord
  statistics: JsonRecord
  indicationChannels: {
    main: JsonRecord
    preset: JsonRecord
  }
  presetType: JsonRecord | null
  engineStates: JsonRecord
  progression: JsonRecord
  stats: JsonRecord
}

const INDICATION_TYPES = ["direction", "move", "active", "optimal", "auto", "trend"] as const
const STRATEGY_STAGES = ["base", "main", "real", "live"] as const

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const asRecord = (value: unknown): JsonRecord => isRecord(value) ? value : {}

const asBoolean = (...values: unknown[]): boolean => {
  const value = values.find((candidate) => candidate !== undefined && candidate !== null && candidate !== "")
  return value === true || value === 1 || value === "1" || value === "true" || value === "yes" || value === "on"
}

const asNumber = (...values: unknown[]): number => {
  for (const value of values) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

const asText = (...values: unknown[]): string => {
  const value = values.find((candidate) => candidate !== undefined && candidate !== null && String(candidate).trim() !== "")
  return value === undefined ? "" : String(value)
}

const firstValue = (record: JsonRecord, keys: string[]): unknown => {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key]
  }
  return undefined
}

const parseSymbols = (...values: unknown[]): string[] => {
  for (const value of values) {
    if (Array.isArray(value)) {
      const symbols = value.map(String).map((item) => item.trim()).filter(Boolean)
      if (symbols.length > 0) return Array.from(new Set(symbols))
    }
    if (typeof value !== "string" || !value.trim()) continue
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) {
        const symbols = parsed.map(String).map((item) => item.trim()).filter(Boolean)
        if (symbols.length > 0) return Array.from(new Set(symbols))
      }
    } catch {
      const symbols = value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)
      if (symbols.length > 0) return Array.from(new Set(symbols))
    }
  }
  return []
}

const titleCase = (value: string): string =>
  value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())

const formatNumber = (value: unknown, maximumFractionDigits = 1): string =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(nonNegativeMetric(value))

const formatSignedNumber = (value: unknown, maximumFractionDigits = 2): string => {
  const parsed = Number(value)
  return Number.isFinite(parsed)
    ? new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(parsed)
    : "0"
}

const formatDuration = (value: unknown): string => {
  const milliseconds = nonNegativeMetric(value)
  if (milliseconds < 1_000) return `${formatNumber(milliseconds, 0)} ms`
  if (milliseconds < 60_000) return `${formatNumber(milliseconds / 1_000, 1)} s`
  return `${formatNumber(milliseconds / 60_000, 1)} min`
}

const formatTimestamp = (value: unknown): string => {
  if (!value) return "Not reported"
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? "Not reported" : date.toLocaleString()
}

function MetricCard({
  label,
  value,
  hint,
  icon,
  tone = "default",
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  tone?: "default" | "success" | "warning" | "danger"
}) {
  return (
    <div className={cn(
      "rounded-xl border bg-card/80 p-3 shadow-sm backdrop-blur-sm",
      tone === "success" && "border-emerald-500/30 bg-emerald-500/5",
      tone === "warning" && "border-amber-500/30 bg-amber-500/5",
      tone === "danger" && "border-red-500/30 bg-red-500/5",
    )}>
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1.5 text-lg font-semibold tabular-nums text-foreground">{value}</div>
      {hint !== undefined && <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</div>}
    </div>
  )
}

function SectionPanel({
  title,
  description,
  icon,
  children,
  className,
}: {
  title: string
  description?: string
  icon?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn("rounded-2xl border bg-card/65 p-4 shadow-sm", className)}>
      <div className="mb-3 flex items-start gap-2.5">
        {icon && <div className="mt-0.5 rounded-lg bg-primary/10 p-1.5 text-primary">{icon}</div>}
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          {description && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
        </div>
      </div>
      {children}
    </section>
  )
}

function DetailRow({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-4 border-b border-border/60 py-1.5 last:border-b-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("max-w-[65%] text-right text-xs font-medium text-foreground", mono && "font-mono")}>{value}</span>
    </div>
  )
}

function BooleanBadge({ value, onLabel = "On", offLabel = "Off" }: { value: boolean; onLabel?: string; offLabel?: string }) {
  return value ? (
    <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300">{onLabel}</Badge>
  ) : (
    <Badge variant="secondary">{offLabel}</Badge>
  )
}

function RuntimeStateCard({
  title,
  description,
  requested,
  effective,
  inSync,
}: {
  title: string
  description: string
  requested: boolean
  effective: boolean
  inSync: boolean
}) {
  return (
    <div className="rounded-xl border bg-background/65 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{title}</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{description}</p>
        </div>
        {inSync ? (
          <Badge variant="outline" className="border-emerald-500/30 text-emerald-700 dark:text-emerald-300">Synced</Badge>
        ) : (
          <Badge variant="destructive">Drift</Badge>
        )}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg bg-muted/60 p-2">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Requested</p>
          <p className="mt-1 font-medium">{requested ? "Enabled" : "Disabled"}</p>
        </div>
        <div className="rounded-lg bg-muted/60 p-2">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Effective</p>
          <p className="mt-1 font-medium">{effective ? "Active" : "Inactive"}</p>
        </div>
      </div>
    </div>
  )
}

export function ConnectionInfoDialog({ open, onOpenChange, connectionId, connectionName }: ConnectionInfoDialogProps) {
  const [activeSection, setActiveSection] = useState<InfoSection>("overview")
  const [loading, setLoading] = useState(false)
  const [info, setInfo] = useState<ConnectionInfoSnapshot | null>(null)
  const [failedSections, setFailedSections] = useState<string[]>([])
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null)
  const loadSequenceRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const loadInfo = useCallback(async (clearPrevious = false) => {
    const loadSequence = ++loadSequenceRef.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    setFailedSections([])
    if (clearPrevious) setInfo(null)

    const encodedId = encodeURIComponent(connectionId)
    const endpoints = [
      ["settings", `/api/settings/connections/${encodedId}/settings`],
      ["indications", `/api/settings/connections/${encodedId}/active-indications`],
      ["preset", `/api/settings/connections/${encodedId}/preset-type`],
      ["runtime", `/api/connections/${encodedId}/engine-states`],
      ["progression", `/api/connections/progression/${encodedId}`],
      ["strategy metrics", `/api/connections/progression/${encodedId}/stats`],
    ] as const

    try {
      const results = await Promise.allSettled(
        endpoints.map(async ([label, path]) => {
          const response = await fetch(path, { cache: "no-store", signal: controller.signal })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) {
            const message = asText(asRecord(payload).error, `${response.status} ${response.statusText}`)
            throw new Error(`${label}: ${message}`)
          }
          return asRecord(payload)
        }),
      )

      if (loadSequence !== loadSequenceRef.current || controller.signal.aborted) return

      const failures = results.flatMap((result, index) =>
        result.status === "rejected" ? [String(endpoints[index][0])] : [],
      )
      const resolved = (index: number): JsonRecord => {
        const result = results[index]
        return result.status === "fulfilled" ? result.value : {}
      }

      if (failures.length === endpoints.length) {
        throw new Error("No information endpoint returned a usable snapshot")
      }

      const settingsPayload = resolved(0)
      const indicationsPayload = resolved(1)
      const channels = asRecord(indicationsPayload.channels)
      const presetPayload = resolved(2)

      setInfo({
        connection: asRecord(settingsPayload.connection),
        settings: asRecord(settingsPayload.settings),
        statistics: asRecord(settingsPayload.statistics),
        indicationChannels: {
          main: asRecord(channels.main),
          preset: asRecord(channels.preset),
        },
        presetType: isRecord(presetPayload.presetType) ? presetPayload.presetType : null,
        engineStates: resolved(3),
        progression: resolved(4),
        stats: resolved(5),
      })
      setFailedSections(failures)
      setLastUpdatedAt(new Date())
    } catch (error) {
      if (controller.signal.aborted || loadSequence !== loadSequenceRef.current) return
      console.error("[ConnectionInfoDialog] Failed to load connection snapshot:", error)
      toast.error("Connection information unavailable", {
        description: error instanceof Error ? error.message : "Failed to load connection information",
      })
      setFailedSections(["all sections"])
    } finally {
      if (loadSequence === loadSequenceRef.current) setLoading(false)
    }
  }, [connectionId])

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort()
      loadSequenceRef.current += 1
      return
    }
    setActiveSection("overview")
    void loadInfo(true)
    return () => abortRef.current?.abort()
  }, [open, connectionId, loadInfo])

  const derived = useMemo(() => {
    const connection = info?.connection ?? {}
    const settings = info?.settings ?? {}
    const engine = info?.engineStates ?? {}
    const progressionPayload = info?.progression ?? {}
    const progression = asRecord(progressionPayload.progression)
    const progressionMetrics = asRecord(progressionPayload.metrics)
    const stats = info?.stats ?? {}
    const realtime = asRecord(stats.realtime)
    const historic = asRecord(stats.historic)
    const engineModes = asRecord(engine.modes)
    const enabledState = asRecord(engine.enabled)
    const mainTradeState = Object.keys(asRecord(engineModes.mainTrade)).length > 0
      ? asRecord(engineModes.mainTrade)
      : asRecord(engine.live)
    const presetTradeState = Object.keys(asRecord(engineModes.presetTrade)).length > 0
      ? asRecord(engineModes.presetTrade)
      : asRecord(engine.preset)
    const engineRunning = asBoolean(engine.engineRunning, progressionMetrics.engineRunning, progressionMetrics.isEngineRunning)
    const symbols = parseSymbols(
      settings.symbols,
      settings.active_symbols,
      settings.force_symbols,
      connection.active_symbols,
      connection.force_symbols,
    )
    const configuredSymbolCount = Math.max(
      symbols.length,
      asNumber(settings.symbol_count, connection.symbol_count, progressionMetrics.prehistoricSymbolsTotal, historic.symbolsTotal),
    )
    const activeCounts = asRecord(stats.activeCounts)
    const strategyActiveCounts = asRecord(activeCounts.strategies)
    const indicationActiveCounts = asRecord(activeCounts.indications)
    const breakdown = asRecord(stats.breakdown)
    const strategyTrackingCounts = asRecord(breakdown.strategies)
    const indicationTrackingCounts = asRecord(breakdown.indications)
    const strategyDetail = asRecord(stats.strategyDetail)
    const stageEvalPercent = asRecord(stats.stageEvalPercent)

    return {
      connection,
      settings,
      engine,
      progression,
      progressionMetrics,
      stats,
      realtime,
      historic,
      enabledState,
      mainTradeState,
      presetTradeState,
      engineRunning,
      symbols,
      configuredSymbolCount,
      strategyActiveCounts,
      indicationActiveCounts,
      strategyTrackingCounts,
      indicationTrackingCounts,
      strategyDetail,
      stageEvalPercent,
    }
  }, [info])

  const phase = asText(derived.progression.phase, derived.engineRunning ? "realtime" : "idle")
  const progressPercent = boundedPercentage(derived.progression.progress)
  const mainTradeRequested = asBoolean(derived.mainTradeState.flag)
  const mainTradeEffective = asBoolean(derived.mainTradeState.effective)
  const executionMode = asText(derived.mainTradeState.executionMode, mainTradeEffective ? "real" : "simulation")
  const statsSettingsRecoordination = asRecord(derived.stats.settingsRecoordination)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(92vh,880px)] w-[min(96vw,1180px)] max-w-6xl grid-rows-none flex-col gap-0 overflow-hidden border-primary/15 p-0">
        <div className="relative overflow-hidden border-b bg-gradient-to-br from-primary/15 via-background to-cyan-500/10 px-5 py-4 pr-14 sm:px-6 sm:py-5 sm:pr-16">
          <div className="pointer-events-none absolute -right-12 -top-20 h-52 w-52 rounded-full bg-primary/15 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-20 left-1/3 h-40 w-64 rounded-full bg-cyan-500/10 blur-3xl" />
          <DialogHeader className="relative gap-3 text-left">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div className="min-w-0">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="border-primary/30 bg-background/60 text-primary backdrop-blur-sm">
                    <Sparkles className="mr-1 h-3 w-3" /> Main Connection
                  </Badge>
                  <Badge variant={derived.engineRunning ? "default" : "secondary"} className={cn(derived.engineRunning && "bg-emerald-600 hover:bg-emerald-600")}>
                    {derived.engineRunning ? <Wifi className="mr-1 h-3 w-3" /> : <WifiOff className="mr-1 h-3 w-3" />}
                    {derived.engineRunning ? "Engine running" : "Engine stopped"}
                  </Badge>
                  <Badge variant="outline" className="bg-background/50 capitalize">{executionMode}</Badge>
                </div>
                <DialogTitle className="truncate text-xl sm:text-2xl">{connectionName}</DialogTitle>
                <DialogDescription className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-mono text-[11px]">{connectionId}</span>
                  <span aria-hidden="true">•</span>
                  <span>Live configuration, processing health, ratios, and strategy coordination.</span>
                </DialogDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-fit gap-1.5 bg-background/65 backdrop-blur-sm"
                onClick={() => void loadInfo(false)}
                disabled={loading}
              >
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Refresh
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1"><Clock3 className="h-3 w-3" /> Snapshot {lastUpdatedAt ? lastUpdatedAt.toLocaleTimeString() : "loading"}</span>
              <span>Phase: <strong className="font-medium text-foreground">{titleCase(phase)}</strong></span>
              <span>Progress: <strong className="font-medium text-foreground">{progressPercent.toFixed(0)}%</strong></span>
              <span>Symbols: <strong className="font-medium text-foreground">{formatNumber(derived.configuredSymbolCount, 0)}</strong></span>
            </div>
          </DialogHeader>
        </div>

        <Tabs value={activeSection} onValueChange={(value) => setActiveSection(value as InfoSection)} className="min-h-0 flex-1 gap-0">
          <div className="shrink-0 overflow-x-auto border-b bg-muted/20 px-4 py-2 sm:px-6">
            <TabsList aria-label="Connection information sections" className="grid h-10 min-w-[650px] w-full grid-cols-5 rounded-xl bg-muted/70 p-1">
              <TabsTrigger value="overview" className="gap-1.5 text-xs sm:text-sm"><Gauge className="h-3.5 w-3.5" />Overview</TabsTrigger>
              <TabsTrigger value="runtime" className="gap-1.5 text-xs sm:text-sm"><Activity className="h-3.5 w-3.5" />Runtime</TabsTrigger>
              <TabsTrigger value="indications" className="gap-1.5 text-xs sm:text-sm"><Zap className="h-3.5 w-3.5" />Indications</TabsTrigger>
              <TabsTrigger value="strategies" className="gap-1.5 text-xs sm:text-sm"><Layers3 className="h-3.5 w-3.5" />Strategies</TabsTrigger>
              <TabsTrigger value="settings" className="gap-1.5 text-xs sm:text-sm"><Settings2 className="h-3.5 w-3.5" />Settings</TabsTrigger>
            </TabsList>
          </div>

          {failedSections.length > 0 && info && (
            <div className="mx-4 mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200 sm:mx-6">
              Partial snapshot: {failedSections.join(", ")} could not be refreshed. Other sections remain available.
            </div>
          )}

          {loading && !info ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-muted-foreground">
              <div className="rounded-2xl border bg-card p-4 shadow-sm"><Loader2 className="h-7 w-7 animate-spin text-primary" /></div>
              <p className="text-sm font-medium text-foreground">Building live connection snapshot</p>
              <p className="max-w-md text-center text-xs">Reading runtime state, progression, ratios, indication profiles, and saved settings.</p>
            </div>
          ) : !info ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <WifiOff className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm font-medium">Connection information is unavailable.</p>
              <Button variant="outline" size="sm" onClick={() => void loadInfo(true)}>Try again</Button>
            </div>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="p-4 sm:p-6">
                <TabsContent value="overview" className="m-0 space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <MetricCard
                      label="Processing Engine"
                      value={derived.engineRunning ? "Running" : "Stopped"}
                      hint={asBoolean(derived.enabledState.inSync) ? "Requested and effective state agree" : "Requested state differs from runtime"}
                      icon={<Activity className="h-3.5 w-3.5" />}
                      tone={derived.engineRunning ? "success" : "warning"}
                    />
                    <MetricCard
                      label="Progression"
                      value={`${progressPercent.toFixed(0)}%`}
                      hint={titleCase(phase)}
                      icon={<Gauge className="h-3.5 w-3.5" />}
                    />
                    <MetricCard
                      label="Configured Symbols"
                      value={formatNumber(derived.configuredSymbolCount, 0)}
                      hint={asText(derived.settings.symbol_order, "Saved selection")}
                      icon={<Database className="h-3.5 w-3.5" />}
                    />
                    <MetricCard
                      label="Average Cycle"
                      value={formatDuration(firstValue(derived.realtime, ["avgCycleTimeMs"]) ?? derived.progressionMetrics.cycleTimeMs)}
                      hint={`${formatNumber(derived.realtime.realtimeCycles, 0)} realtime cycles`}
                      icon={<Clock3 className="h-3.5 w-3.5" />}
                    />
                  </div>

                  <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
                    <SectionPanel
                      title="Progression health"
                      description="Current processing phase and the latest engine-owned work counters."
                      icon={<BarChart3 className="h-4 w-4" />}
                    >
                      <div className="space-y-3">
                        <div>
                          <div className="mb-1.5 flex items-center justify-between text-xs">
                            <span className="font-medium">{titleCase(phase)}</span>
                            <span className="tabular-nums text-muted-foreground">{progressPercent.toFixed(0)}%</span>
                          </div>
                          <Progress value={progressPercent} className="h-2" />
                          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{asText(derived.progression.message, "No progression message reported")}</p>
                        </div>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                          {STRATEGY_STAGES.map((stage) => (
                            <div key={stage} className="rounded-lg bg-muted/55 p-2.5 text-center">
                              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{stage}</p>
                              <p className="mt-1 text-base font-semibold tabular-nums">{formatNumber(derived.strategyActiveCounts[stage], 0)}</p>
                              <p className="text-[10px] text-muted-foreground">active sets</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    </SectionPanel>

                    <SectionPanel
                      title="Execution safety"
                      description="Requested trading mode is kept separate from effective real-order permission."
                      icon={<ShieldCheck className="h-4 w-4" />}
                    >
                      <DetailRow label="Main Trade requested" value={<BooleanBadge value={mainTradeRequested} onLabel="Requested" offLabel="Not requested" />} />
                      <DetailRow label="Real orders effective" value={<BooleanBadge value={mainTradeEffective} onLabel="Effective" offLabel="Blocked / off" />} />
                      <DetailRow label="Execution mode" value={<span className="capitalize">{executionMode}</span>} />
                      <DetailRow label="Credentials valid" value={<BooleanBadge value={asBoolean(derived.mainTradeState.credentialsValid)} onLabel="Valid" offLabel="Not ready" />} />
                      <DetailRow label="Durable coordination" value={<BooleanBadge value={asBoolean(derived.mainTradeState.durableCoordinationReady)} onLabel="Ready" offLabel="Not ready" />} />
                      {asText(derived.mainTradeState.blockReason) && (
                        <div className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-2.5 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
                          {asText(derived.mainTradeState.blockReason)}
                        </div>
                      )}
                    </SectionPanel>
                  </div>

                  <SectionPanel title="Connection summary" icon={<Wifi className="h-4 w-4" />}>
                    <div className="grid gap-x-6 md:grid-cols-2 xl:grid-cols-3">
                      <DetailRow label="Exchange" value={asText(derived.connection.exchange, "Unknown")} />
                      <DetailRow label="Connection method" value={asText(derived.connection.connection_method, derived.settings.connection_method, "Default")} />
                      <DetailRow label="Library" value={asText(derived.connection.connection_library, derived.settings.connection_library, "Exchange SDK")} />
                      <DetailRow label="Network" value={asBoolean(derived.connection.is_testnet) ? "Testnet" : "Mainnet"} />
                      <DetailRow label="Position mode" value={titleCase(asText(derived.connection.position_mode, derived.settings.position_mode, "Default"))} />
                      <DetailRow label="Margin mode" value={titleCase(asText(derived.connection.margin_type, derived.settings.margin_mode, "Default"))} />
                    </div>
                  </SectionPanel>
                </TabsContent>

                <TabsContent value="runtime" className="m-0 space-y-4">
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <RuntimeStateCard
                      title="Main Connection"
                      description="Dashboard processing assignment and shared engine state."
                      requested={asBoolean(derived.enabledState.flag)}
                      effective={asBoolean(derived.enabledState.running)}
                      inSync={asBoolean(derived.enabledState.inSync)}
                    />
                    <RuntimeStateCard
                      title="Realtime Loop"
                      description="Continuous indications, strategies, and position supervision."
                      requested={asBoolean(derived.enabledState.flag)}
                      effective={derived.engineRunning}
                      inSync={asBoolean(derived.enabledState.inSync)}
                    />
                    <RuntimeStateCard
                      title="Main Trade"
                      description="Operator request versus effective real-order eligibility."
                      requested={mainTradeRequested}
                      effective={mainTradeEffective}
                      inSync={asBoolean(derived.mainTradeState.inSync)}
                    />
                    <RuntimeStateCard
                      title="Preset Trade"
                      description="Preset request handled by the same coordinated engine."
                      requested={asBoolean(derived.presetTradeState.flag)}
                      effective={asBoolean(derived.presetTradeState.effective)}
                      inSync={asBoolean(derived.presetTradeState.inSync)}
                    />
                  </div>

                  <div className="grid gap-4 lg:grid-cols-2">
                    <SectionPanel title="Cycle telemetry" description="Cumulative processor work for the current run." icon={<Activity className="h-4 w-4" />}>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        <MetricCard label="Indication cycles" value={formatNumber(derived.realtime.indicationCycles, 0)} />
                        <MetricCard label="Strategy cycles" value={formatNumber(derived.realtime.strategyCycles, 0)} />
                        <MetricCard label="Realtime cycles" value={formatNumber(derived.realtime.realtimeCycles, 0)} />
                        <MetricCard label="Frames" value={formatNumber(derived.realtime.framesProcessed, 0)} />
                        <MetricCard label="Success rate" value={`${boundedPercentage(derived.realtime.successRate).toFixed(1)}%`} />
                        <MetricCard label="Cycle time" value={formatDuration(derived.realtime.avgCycleTimeMs)} />
                      </div>
                    </SectionPanel>

                    <SectionPanel title="Historical initialization" description="Data coverage that gates realtime strategy processing." icon={<Database className="h-4 w-4" />}>
                      <div className="mb-3">
                        <div className="mb-1.5 flex justify-between text-xs">
                          <span>Historical data</span>
                          <span className="tabular-nums">{boundedPercentage(derived.historic.progressPercent).toFixed(0)}%</span>
                        </div>
                        <Progress value={boundedPercentage(derived.historic.progressPercent)} className="h-2" />
                      </div>
                      <div className="grid gap-x-5 sm:grid-cols-2">
                        <DetailRow label="Symbols" value={`${formatNumber(derived.historic.symbolsProcessed, 0)} / ${formatNumber(derived.historic.symbolsTotal, 0)}`} />
                        <DetailRow label="Candles loaded" value={formatNumber(derived.historic.candlesLoaded, 0)} />
                        <DetailRow label="Frames processed" value={formatNumber(derived.historic.framesProcessed, 0)} />
                        <DetailRow label="Indicators" value={formatNumber(derived.historic.indicatorsCalculated, 0)} />
                        <DetailRow label="Complete" value={<BooleanBadge value={asBoolean(derived.historic.isComplete)} onLabel="Complete" offLabel="In progress" />} />
                        <DetailRow label="Timeframe" value={`${formatNumber(derived.historic.timeframeSeconds, 0)} s`} />
                      </div>
                    </SectionPanel>
                  </div>

                  <SectionPanel title="Freshness and recoordination" description="Timestamps and settings-version ownership used to detect stale runtime state." icon={<RefreshCw className="h-4 w-4" />}>
                    <div className="grid gap-x-6 md:grid-cols-2">
                      <DetailRow label="Progression updated" value={formatTimestamp(derived.progression.updatedAt)} />
                      <DetailRow label="Progression started" value={formatTimestamp(derived.progression.startedAt)} />
                      <DetailRow label="Last indication run" value={formatTimestamp(derived.progressionMetrics.lastIndicationRun)} />
                      <DetailRow label="Last strategy run" value={formatTimestamp(derived.progressionMetrics.lastStrategyRun)} />
                      <DetailRow label="Settings version" value={asText(statsSettingsRecoordination.appliedVersion, statsSettingsRecoordination.requestedVersion, derived.connection.settings_version, "Not reported")} mono />
                      <DetailRow label="Recoordination state" value={titleCase(asText(statsSettingsRecoordination.status, statsSettingsRecoordination.phase, "Current"))} />
                    </div>
                  </SectionPanel>
                </TabsContent>

                <TabsContent value="indications" className="m-0 space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <MetricCard
                      label="Main channels enabled"
                      value={INDICATION_TYPES.filter((type) => asBoolean(asRecord(info.indicationChannels.main[type]).enabled)).length}
                      hint={`of ${INDICATION_TYPES.length} configured channels`}
                      icon={<Zap className="h-3.5 w-3.5" />}
                    />
                    <MetricCard
                      label="Preset channels enabled"
                      value={INDICATION_TYPES.filter((type) => asBoolean(asRecord(info.indicationChannels.preset[type]).enabled)).length}
                      hint={`of ${INDICATION_TYPES.length} configured channels`}
                      icon={<SlidersHorizontal className="h-3.5 w-3.5" />}
                    />
                    <MetricCard label="Active now" value={formatNumber(derived.indicationActiveCounts.total, 0)} hint="Current qualified indication entries" />
                    <MetricCard label="Tracked total" value={formatNumber(derived.indicationTrackingCounts.total, 0)} hint="Cumulative current-run observations" />
                  </div>

                  <SectionPanel title="Main and Preset indication profiles" description="Each channel keeps independent enablement, range, timeout, and evaluation interval settings." icon={<Zap className="h-4 w-4" />}>
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {INDICATION_TYPES.map((type) => {
                        const main = asRecord(info.indicationChannels.main[type])
                        const preset = asRecord(info.indicationChannels.preset[type])
                        return (
                          <div key={type} className="rounded-xl border bg-background/70 p-3">
                            <div className="mb-3 flex items-center justify-between gap-2">
                              <div>
                                <p className="text-sm font-semibold">{titleCase(type)}</p>
                                <p className="text-[10px] text-muted-foreground">{formatNumber(derived.indicationActiveCounts[type], 0)} active · {formatNumber(derived.indicationTrackingCounts[type], 0)} tracked</p>
                              </div>
                              <Badge variant="outline" className="text-[10px]">{type === "trend" ? "multi-range" : "signal"}</Badge>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              {[["Main", main], ["Preset", preset]].map(([label, profile]) => {
                                const values = asRecord(profile)
                                return (
                                  <div key={String(label)} className="rounded-lg bg-muted/55 p-2.5">
                                    <div className="mb-2 flex items-center justify-between gap-1">
                                      <span className="text-xs font-medium">{String(label)}</span>
                                      <BooleanBadge value={asBoolean(values.enabled)} />
                                    </div>
                                    <p className="text-[10px] text-muted-foreground">Range <span className="float-right font-medium text-foreground">{asText(values.range, "—")}</span></p>
                                    <p className="mt-1 text-[10px] text-muted-foreground">Timeout <span className="float-right font-medium text-foreground">{formatDuration(values.timeout)}</span></p>
                                    <p className="mt-1 text-[10px] text-muted-foreground">Interval <span className="float-right font-medium text-foreground">{formatDuration(values.interval)}</span></p>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </SectionPanel>
                </TabsContent>

                <TabsContent value="strategies" className="m-0 space-y-4">
                  <SectionPanel title="Stage coordination" description="Active Sets, evaluated entries, bounded pass ratios, and profitability metrics by pipeline stage." icon={<Layers3 className="h-4 w-4" />}>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      {STRATEGY_STAGES.map((stage) => {
                        const detail = asRecord(derived.strategyDetail[stage])
                        const evaluated = nonNegativeMetric(detail.evaluated)
                        const passed = boundedPassedCount(detail.passed, evaluated)
                        return (
                          <div key={stage} className="rounded-xl border bg-background/70 p-3">
                            <div className="mb-3 flex items-center justify-between gap-2">
                              <div>
                                <p className="text-sm font-semibold">{titleCase(stage)}</p>
                                <p className="text-[10px] text-muted-foreground">Pipeline stage</p>
                              </div>
                              <Badge variant={stage === "live" ? "default" : "outline"}>{formatNumber(derived.strategyActiveCounts[stage], 0)} active</Badge>
                            </div>
                            <DetailRow label="Tracked Sets" value={formatNumber(derived.strategyTrackingCounts[stage], 0)} />
                            <DetailRow label="Evaluation rate" value={`${boundedPercentage(derived.stageEvalPercent[stage]).toFixed(1)}%`} />
                            <DetailRow label="Evaluated / passed" value={`${formatNumber(evaluated, 0)} / ${formatNumber(passed, 0)}`} />
                            <DetailRow label="Pass ratio" value={`${boundedPercentage(detail.passRatio).toFixed(1)}%`} />
                            <DetailRow label="Avg profit factor" value={formatNumber(detail.avgProfitFactor, 2)} />
                            <DetailRow label={stage === "live" ? "Avg hold time" : "Avg drawdown time"} value={formatDuration(asNumber(detail.avgDrawdownTime) * 60_000)} />
                          </div>
                        )
                      })}
                    </div>
                  </SectionPanel>

                  <div className="grid gap-4 lg:grid-cols-2">
                    <SectionPanel title="Strategy variants" description="Saved coordination gates applied during Main-stage Set creation." icon={<SlidersHorizontal className="h-4 w-4" />}>
                      {(() => {
                        const coordination = asRecord(derived.settings.coordination_settings ?? derived.settings.coordinationSettings)
                        const variants = asRecord(coordination.variants)
                        return (
                          <div className="grid grid-cols-2 gap-2">
                            {[
                              ["Default", true],
                              ["Trailing", asBoolean(variants.trailing, derived.settings.variantTrailingEnabled)],
                              ["Block", asBoolean(variants.block, derived.settings.variantBlockEnabled)],
                              ["DCA", asBoolean(variants.dca, derived.settings.variantDcaEnabled)],
                            ].map(([label, enabled]) => (
                              <div key={String(label)} className="flex items-center justify-between rounded-lg border bg-background/60 p-2.5">
                                <span className="text-xs font-medium">{String(label)}</span>
                                <BooleanBadge value={Boolean(enabled)} />
                              </div>
                            ))}
                          </div>
                        )
                      })()}
                    </SectionPanel>

                    <SectionPanel title="Assigned preset" description="Preset-level position, timing, Block, and DCA constraints." icon={<Sparkles className="h-4 w-4" />}>
                      {info.presetType ? (
                        <>
                          <div className="mb-2 flex flex-wrap items-center gap-2">
                            <Badge>{asText(info.presetType.name, "Preset")}</Badge>
                            <BooleanBadge value={asBoolean(info.presetType.is_active)} onLabel="Active" offLabel="Inactive" />
                            <Badge variant="outline">{titleCase(asText(info.presetType.preset_trade_type, "Standard"))}</Badge>
                          </div>
                          {asText(info.presetType.description) && <p className="mb-3 text-xs leading-relaxed text-muted-foreground">{asText(info.presetType.description)}</p>}
                          <div className="grid gap-x-5 sm:grid-cols-2">
                            <DetailRow label="Positions / indication" value={formatNumber(info.presetType.max_positions_per_indication, 0)} />
                            <DetailRow label="Positions / direction" value={formatNumber(info.presetType.max_positions_per_direction, 0)} />
                            <DetailRow label="Positions / range" value={formatNumber(info.presetType.max_positions_per_range, 0)} />
                            <DetailRow label="Evaluation interval" value={`${formatNumber(info.presetType.evaluation_interval_hours)} h`} />
                            <DetailRow label="Block" value={<BooleanBadge value={asBoolean(info.presetType.block_enabled)} />} />
                            <DetailRow label="DCA" value={<BooleanBadge value={asBoolean(info.presetType.dca_enabled)} />} />
                          </div>
                        </>
                      ) : (
                        <div className="rounded-lg border border-dashed p-5 text-center text-xs text-muted-foreground">No preset type is assigned to this Main Connection.</div>
                      )}
                    </SectionPanel>
                  </div>
                </TabsContent>

                <TabsContent value="settings" className="m-0 space-y-4">
                  <div className="grid gap-4 lg:grid-cols-2">
                    <SectionPanel title="Connection and market" description="Canonical exchange, symbol, order, and position settings." icon={<Wifi className="h-4 w-4" />}>
                      <DetailRow label="Connection ID" value={connectionId} mono />
                      <DetailRow label="Exchange" value={asText(derived.connection.exchange, "Unknown")} />
                      <DetailRow label="Library" value={asText(derived.connection.connection_library, derived.settings.connection_library, "Exchange SDK")} />
                      <DetailRow label="Connection method" value={asText(derived.connection.connection_method, derived.settings.connection_method, "Default")} />
                      <DetailRow label="Order type" value={titleCase(asText(derived.settings.order_type, derived.settings.orderType, "Market"))} />
                      <DetailRow label="Volume type" value={titleCase(asText(derived.settings.volume_type, derived.settings.volumeType, "USDT"))} />
                      <DetailRow label="Position mode" value={titleCase(asText(derived.connection.position_mode, derived.settings.position_mode, "Default"))} />
                      <DetailRow label="Margin mode" value={titleCase(asText(derived.connection.margin_type, derived.settings.margin_mode, "Default"))} />
                      <DetailRow label="Control orders" value={<BooleanBadge value={asBoolean(derived.settings.control_orders, derived.settings.controlOrders)} />} />
                    </SectionPanel>

                    <SectionPanel title="Volume and risk" description="Effective sizing multipliers and saved progression boundaries." icon={<Gauge className="h-4 w-4" />}>
                      <DetailRow label="Main volume factor" value={formatNumber(firstValue(derived.settings, ["live_volume_factor", "volume_factor_live", "baseVolumeFactorLive"]), 3)} />
                      <DetailRow label="Preset volume factor" value={formatNumber(firstValue(derived.settings, ["preset_volume_factor", "volume_factor_preset", "baseVolumeFactorPreset"]), 3)} />
                      <DetailRow label="Volume step ratio" value={formatNumber(firstValue(derived.settings, ["volume_step_ratio", "block_volume_step_ratio"]), 3)} />
                      <DetailRow label="Leverage" value={asBoolean(derived.settings.useMaximalLeverage) ? "Maximum allowed" : `${formatNumber(derived.settings.leveragePercentage, 1)}%`} />
                      <DetailRow label="Minimum step" value={formatNumber(firstValue(derived.settings, ["minStep", "minimal_step_count"]), 0)} />
                      <DetailRow label="Trailing minimum step" value={formatNumber(derived.settings.trailingMinStep, 0)} />
                      <DetailRow label="Max stop-loss ratio" value={formatNumber(firstValue(derived.settings, ["maxStopLossRatio", "max_stoploss_ratio"]), 2)} />
                      <DetailRow label="Max concurrent trades" value={formatNumber(firstValue(derived.settings, ["max_concurrent_trades", "targetPositions"]), 0)} />
                    </SectionPanel>
                  </div>

                  <SectionPanel title={`Symbols (${derived.configuredSymbolCount})`} description="Current resolved or manually saved processing universe." icon={<Database className="h-4 w-4" />}>
                    {derived.symbols.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {derived.symbols.map((symbol) => <Badge key={symbol} variant="outline" className="font-mono text-[10px]">{symbol}</Badge>)}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">Symbols are exchange-resolved at engine start; no static list is stored.</p>
                    )}
                  </SectionPanel>

                  <div className="grid gap-4 lg:grid-cols-2">
                    <SectionPanel title="Position-count axes" description="Previous, Last, Continuous, and Pause windows used for ongoing Set calculations." icon={<BarChart3 className="h-4 w-4" />}>
                      {[
                        ["Previous", "axisPrevEnabled", "axisPrevMaxWindow"],
                        ["Last", "axisLastEnabled", "axisLastMaxWindow"],
                        ["Continuous", "axisContEnabled", "axisContMaxWindow"],
                        ["Pause", "axisPauseEnabled", "axisPauseMaxWindow"],
                      ].map(([label, enabledKey, windowKey]) => (
                        <div key={label} className="flex items-center justify-between gap-3 border-b py-2 last:border-b-0">
                          <div>
                            <p className="text-xs font-medium">{label}</p>
                            <p className="text-[10px] text-muted-foreground">Max window {formatNumber(derived.settings[windowKey], 0)}</p>
                          </div>
                          <BooleanBadge value={asBoolean(derived.settings[enabledKey])} />
                        </div>
                      ))}
                    </SectionPanel>

                    <SectionPanel title="DCA and trailing" description="Saved multi-step accumulation and trailing coordination parameters." icon={<SlidersHorizontal className="h-4 w-4" />}>
                      <DetailRow label="DCA max steps" value={formatNumber(derived.settings.dcaMaxSteps, 0)} />
                      <DetailRow label="DCA breakeven profit" value={`${formatSignedNumber(derived.settings.dcaBreakevenProfitPct)}%`} />
                      <DetailRow label="DCA cooldown" value={`${formatNumber(derived.settings.dcaCooldownSeconds, 0)} s`} />
                      <DetailRow label="DCA take-profit mode" value={titleCase(asText(derived.settings.dcaTakeProfitMode, "Weighted"))} />
                      <DetailRow label="Trailing variants" value={Array.isArray(derived.settings.strategyBaseTrailingVariants) ? derived.settings.strategyBaseTrailingVariants.length : 0} />
                      <DetailRow label="System close only" value={<BooleanBadge value={asBoolean(derived.settings.useSystemCloseOnly, derived.settings.use_system_close_only)} />} />
                    </SectionPanel>
                  </div>

                  <SectionPanel title="Persistence" description="Saved-object metadata and current settings reconciliation ownership." icon={<CheckCircle2 className="h-4 w-4" />}>
                    <div className="grid gap-x-6 md:grid-cols-2">
                      <DetailRow label="Created" value={formatTimestamp(info.statistics.created_at)} />
                      <DetailRow label="Updated" value={formatTimestamp(info.statistics.updated_at)} />
                      <DetailRow label="Saved settings fields" value={Object.keys(derived.settings).length} />
                      <DetailRow label="Settings version" value={asText(statsSettingsRecoordination.appliedVersion, statsSettingsRecoordination.requestedVersion, derived.connection.settings_version, "Not reported")} mono />
                    </div>
                  </SectionPanel>
                </TabsContent>
              </div>
            </ScrollArea>
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

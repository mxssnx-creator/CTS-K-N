"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  PlayCircle,
  PauseCircle,
  CheckCircle2,
  Zap,
  Target,
  BarChart3,
  Clock,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Award,
  AlertTriangle,
} from "lucide-react"

export interface PerformanceTier {
  avgProfitFactor: number
  avgDrawdownMin: number
  avgPosPerSet: number
  winRate: number
  sharpe: number
  totalPnl: number
  avgPnl?: number
  avgSignedR?: number
  avgPositiveR?: number
  avgNegativeR?: number
  netR?: number
  totalCreated: number
  totalEntries: number
  totalRunning: number
  symbolCount: number
  isExecution: boolean
  fillRate?: number
  volumeUsdTotal?: number
  totalClosed?: number
  openScanned?: number
}

export interface PerformanceTiersData {
  base: PerformanceTier
  main: PerformanceTier
  real: PerformanceTier
  live: PerformanceTier
}

interface PerformanceTiersProps {
  tiers: PerformanceTiersData
  compact?: boolean
}

function pfColor(v: number): string {
  if (v >= 1.5) return "text-green-600"
  if (v >= 1.0) return "text-yellow-600"
  if (v > 0)    return "text-orange-500"
  return "text-muted-foreground"
}

function pnlColor(v: number): string {
  if (v > 0) return "text-green-600"
  if (v < 0) return "text-red-600"
  return ""
}

function wrColor(v: number): string {
  if (v >= 60) return "text-green-600"
  if (v >= 45) return "text-yellow-600"
  if (v > 0)   return "text-red-600"
  return "text-muted-foreground"
}

const STAGE_META: Record<string, { label: string; Icon: typeof PlayCircle; badgeVariant: "default" | "secondary" | "outline" | "destructive"; border: string }> = {
  base: { label: "Base",        Icon: PlayCircle,  badgeVariant: "secondary",  border: "border-l-4 border-l-blue-400" },
  main: { label: "Main",        Icon: PauseCircle, badgeVariant: "secondary",  border: "border-l-4 border-l-amber-400" },
  real: { label: "Real",        Icon: CheckCircle2,badgeVariant: "default",    border: "border-l-4 border-l-emerald-400" },
  live: { label: "Live / Exch", Icon: Zap,         badgeVariant: "destructive", border: "border-l-4 border-l-red-400"    },
}

function TierCard({ keyName, tier }: { keyName: string; tier: PerformanceTier }) {
  const meta = STAGE_META[keyName]
  if (!meta) return null

  const pf = tier.avgProfitFactor
  const wrLabel = tier.isExecution ? `${tier.winRate.toFixed(1)}%` : `${tier.totalRunning}/${tier.totalCreated}`

  return (
    <Card className={`${meta.border} bg-muted/20`}>
      <CardHeader className="pb-1 pt-3 px-3">
        <CardTitle className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-1.5">
            <meta.Icon className="h-4 w-4" />
            {meta.label}
          </span>
          <Badge variant={meta.badgeVariant} className="text-[10px] h-5">
            {tier.symbolCount} sym
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-3 pt-1 space-y-1.5">
        {/* PF row — always the hero metric */}
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
            <Target className="h-3 w-3" /> PF
          </span>
          <span className={`text-lg font-bold leading-none ${pfColor(pf)}`}>
            {pf > 0 ? pf.toFixed(3) : "—"}
          </span>
        </div>

        {/* Win rate */}
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] text-muted-foreground flex items-center gap-1">
            <Award className="h-3 w-3" />
            {tier.isExecution ? "Win Rate" : "Running / Created"}
          </span>
          <span className={`text-sm font-medium ${tier.isExecution ? wrColor(tier.winRate) : "text-muted-foreground"}`}>
            {wrLabel}
          </span>
        </div>

        {/* Avg hold / DDT */}
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] text-muted-foreground flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {tier.isExecution ? "Avg Hold" : "Avg DDT"}
          </span>
          <span className="text-sm text-muted-foreground">
            {tier.avgDrawdownMin > 0 ? tier.avgDrawdownMin.toFixed(1) + "m" : "—"}
          </span>
        </div>

        {/* Avg P&L (execution tiers only) */}
        {tier.isExecution && (
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
              <DollarSign className="h-3 w-3" /> Avg P&L
            </span>
            <span className={`text-sm font-medium ${pnlColor(tier.avgPnl || 0)}`}>
              {(tier.avgPnl || 0) >= 0 ? "+" : ""}{(tier.avgPnl || 0).toFixed(2)}
            </span>
          </div>
        )}

        {/* Sharpe */}
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] text-muted-foreground flex items-center gap-1">
            <BarChart3 className="h-3 w-3" /> Sharpe
          </span>
          <span className={tier.sharpe > 0 ? "text-green-600 text-sm font-medium" : "text-muted-foreground text-sm"}>
            {tier.sharpe > 0 ? tier.sharpe.toFixed(2) : "—"}
          </span>
        </div>

        {/* Volatility proxy (DDT) */}
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] text-muted-foreground flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            {tier.isExecution ? "Open / Total" : "Total Entries"}
          </span>
          <span className="text-sm text-muted-foreground">
            {tier.isExecution
              ? `${tier.totalRunning} / ${tier.totalCreated}`
              : tier.totalEntries.toLocaleString()
            }
          </span>
        </div>

        {/* Live only: fill rate and volume */}
        {tier.isExecution && (
          <>
            <Separator className="my-1" />
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] text-muted-foreground">Fill Rate</span>
              <span className="text-sm text-muted-foreground">{tier.fillRate ?? 0}%</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] text-muted-foreground">Avg R</span>
              <span className={`text-sm font-semibold ${pnlColor(tier.avgSignedR || 0)}`}>
                {(tier.avgSignedR || 0) >= 0 ? "+" : ""}{(tier.avgSignedR || 0).toFixed(2)}R
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] text-muted-foreground">Avg Win / Loss</span>
              <span className="text-sm text-muted-foreground">
                +{(tier.avgPositiveR || 0).toFixed(2)}R / {(tier.avgNegativeR || 0).toFixed(2)}R
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] text-muted-foreground">Total P&L</span>
              <span className={`text-sm font-semibold ${pnlColor(tier.totalPnl)}`}>
                {tier.totalPnl >= 0 ? "+" : ""}{tier.totalPnl.toFixed(2)}
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] text-muted-foreground">Volume USD</span>
              <span className="text-sm text-muted-foreground">${(tier.volumeUsdTotal || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            </div>
          </>
        )}

        {/* Base/Main/Real: PF direction */}
        {!tier.isExecution && tier.avgPosPerSet > 0 && (
          <div className="flex items-center gap-1 pt-0.5">
            {pf >= 1 ? (
              <TrendingUp className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <TrendingDown className="h-3.5 w-3.5 text-red-500" />
            )}
            <span className="text-[10px] text-muted-foreground">
              PF dir – {tier.avgPosPerSet.toFixed(1)} avg pos/set
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function PerformanceTiers({ tiers, compact = false }: PerformanceTiersProps) {
  const stages: (keyof PerformanceTiersData)[] = ["base", "main", "real", "live"]

  if (compact) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {stages.map((s) => (
          <TierCard key={s} keyName={s} tier={tiers[s]} />
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
      {stages.map((s) => (
        <TierCard key={s} keyName={s} tier={tiers[s]} />
      ))}
    </div>
  )
}

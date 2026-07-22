"use client"

import {
  Activity,
  BarChart3,
  CircleDollarSign,
  Clock3,
  Gauge,
  Layers3,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  WalletCards,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import type { LiveTradingAnalytics, ProfitFactorMetric } from "@/lib/live-trading-analytics"
import type { LiveAccountSummary, LivePositionView } from "@/components/live-trading/live-trading-types"
import {
  formatCompactMoney,
  formatDuration,
  formatMoney,
  formatProfitFactor,
  positionMargin,
  positionPnl,
} from "@/components/live-trading/live-trading-format"

interface LiveOverviewCompactProps {
  account: LiveAccountSummary | null
  positions: LivePositionView[]
  analytics: LiveTradingAnalytics | null
}

function tone(value: number): string {
  if (value > 0) return "text-emerald-600 dark:text-emerald-400"
  if (value < 0) return "text-rose-600 dark:text-rose-400"
  return "text-foreground"
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  valueClassName = "text-foreground",
}: {
  icon: typeof Activity
  label: string
  value: string
  detail?: string
  valueClassName?: string
}) {
  return (
    <Card className="min-w-0 border-border/70 bg-card/80 shadow-sm">
      <CardContent className="flex min-h-[64px] items-center gap-2.5 p-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-muted/50 text-muted-foreground">
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0">
          <div className={`truncate text-sm font-semibold tabular-nums ${valueClassName}`}>{value}</div>
          <div className="truncate text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
          {detail ? <div className="truncate text-[10px] text-muted-foreground/80">{detail}</div> : null}
        </div>
      </CardContent>
    </Card>
  )
}

function PerformanceWindow({ label, metric }: { label: string; metric?: ProfitFactorMetric }) {
  const pnl = metric?.netPnl || 0
  return (
    <div className="rounded-md border bg-muted/20 p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        <Badge variant="outline" className="h-4 px-1 text-[9px] font-mono">
          {metric?.trades || 0} trades
        </Badge>
      </div>
      <div className="flex items-end justify-between gap-2">
        <div>
          <div className={`text-sm font-semibold tabular-nums ${tone(pnl)}`}>{formatCompactMoney(pnl)}</div>
          <div className="text-[10px] text-muted-foreground">
            {metric?.wins || 0}W / {metric?.losses || 0}L · {metric?.winRate.toFixed(0) || "0"}%
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm font-bold tabular-nums">{formatProfitFactor(metric?.profitFactor, metric?.infinite)}</div>
          <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Profit factor</div>
        </div>
      </div>
    </div>
  )
}

export function LiveOverviewCompact({ account, positions, analytics }: LiveOverviewCompactProps) {
  // The live-position endpoint is the canonical engine ledger. Use its exact
  // currently visible rows for position-derived totals so account-cache lag
  // cannot produce mismatched counts/PnL after an operator close or reload.
  const positionPnlTotal = positions.reduce((sum, position) => sum + positionPnl(position), 0)
  const positionMarginTotal = positions.reduce((sum, position) => sum + positionMargin(position), 0)
  const positionNotionalTotal = positions.reduce(
    (sum, position) => sum + positionMargin(position) * Math.max(1, Number(position.leverage) || 1),
    0,
  )
  const openPnl = positions.length > 0 ? positionPnlTotal : account?.unrealizedPnl ?? 0
  const margin = positions.length > 0 ? positionMarginTotal : account?.marginUsd ?? 0
  const notional = positions.length > 0 ? positionNotionalTotal : account?.volumeUsd ?? 0
  const balance = account?.balance.total ?? 0
  const equity = positions.length > 0 ? balance + openPnl : account?.balance.equity ?? balance
  const available = Math.max(0, equity - margin)
  const currency = account?.balance.currency || "USDT"
  const marginRatio = equity > 0 ? (margin / equity) * 100 : 0
  const drawdown = analytics?.drawdown5d
  const longPositions = positions.filter((position) => String(position.direction ?? position.side).toLowerCase().includes("long")).length
  const shortPositions = positions.filter((position) => String(position.direction ?? position.side).toLowerCase().includes("short")).length

  return (
    <section className="space-y-2" aria-label="Live account and performance overview">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <MetricCard
          icon={WalletCards}
          label="Balance"
          value={formatMoney(balance, currency)}
          detail={`Free est. ${formatCompactMoney(available, currency)}`}
        />
        <MetricCard
          icon={BarChart3}
          label="Equity"
          value={formatMoney(equity, currency)}
          detail={`${openPnl >= 0 ? "+" : ""}${formatCompactMoney(openPnl, currency)} open PnL`}
          valueClassName={tone(equity - balance)}
        />
        <MetricCard
          icon={Gauge}
          label="Margin"
          value={formatMoney(margin, currency)}
          detail={`${marginRatio.toFixed(1)}% · ${formatCompactMoney(notional, currency)} notional`}
        />
        <MetricCard
          icon={CircleDollarSign}
          label="Open Profit"
          value={formatMoney(openPnl, currency)}
          detail="Unrealized, exchange-synced"
          valueClassName={tone(openPnl)}
        />
        <MetricCard
          icon={Layers3}
          label="Open positions"
          value={String(positions.length)}
          detail={`${longPositions} long · ${shortPositions} short`}
        />
        <MetricCard
          icon={Clock3}
          label="Drawdown time · 5d"
          value={formatDuration(drawdown?.currentDurationMs || drawdown?.maxDurationMs || 0)}
          detail={drawdown?.inDrawdown
            ? `Active · depth ${formatCompactMoney(drawdown.currentDepth)}`
            : `Max ${formatDuration(drawdown?.maxDurationMs || 0)} · ${drawdown?.episodes || 0} episodes`}
          valueClassName={drawdown?.inDrawdown ? "text-amber-600 dark:text-amber-400" : "text-foreground"}
        />
      </div>

      <div className="grid gap-2 lg:grid-cols-[1.45fr_1fr_1fr]">
        <Card className="border-border/70 bg-card/80 shadow-sm">
          <CardContent className="p-2.5">
            <div className="mb-2 flex items-center gap-2">
              <Activity className="size-3.5 text-primary" />
              <h2 className="text-xs font-semibold">Profit &amp; factor by closing time</h2>
              <span className="ml-auto text-[9px] text-muted-foreground">PF 1.00 = break-even</span>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              <PerformanceWindow label="Last 4 hours" metric={analytics?.timeWindows["4h"]} />
              <PerformanceWindow label="Last 12 hours" metric={analytics?.timeWindows["12h"]} />
              <PerformanceWindow label="Last 48 hours" metric={analytics?.timeWindows["48h"]} />
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card/80 shadow-sm">
          <CardContent className="p-2.5">
            <div className="mb-2 flex items-center gap-2">
              <ShieldCheck className="size-3.5 text-primary" />
              <h2 className="text-xs font-semibold">Profit factor · last positions</h2>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {(["25", "75", "150"] as const).map((window) => {
                const metric = analytics?.positionWindows[window]
                return (
                  <div key={window} className="rounded-md border bg-muted/20 px-2 py-2 text-center">
                    <div className="text-base font-bold tabular-nums">{formatProfitFactor(metric?.profitFactor, metric?.infinite)}</div>
                    <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Last {window}</div>
                    <div className="mt-0.5 text-[9px] text-muted-foreground">{metric?.wins || 0}W / {metric?.losses || 0}L</div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card/80 shadow-sm">
          <CardContent className="p-2.5">
            <div className="mb-2 flex items-center gap-2">
              {openPnl >= 0 ? <TrendingUp className="size-3.5 text-emerald-500" /> : <TrendingDown className="size-3.5 text-rose-500" />}
              <h2 className="text-xs font-semibold">Closed orders</h2>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {(["4h", "24h", "48h"] as const).map((window) => (
                <div key={window} className="rounded-md border bg-muted/20 px-2 py-2 text-center">
                  <div className="text-base font-bold tabular-nums">{analytics?.orderWindows[window] || 0}</div>
                  <div className="text-[9px] uppercase tracking-wide text-muted-foreground">{window}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  )
}

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
import { liveOverviewExposure } from "./live-overview-exposure"
import {
  formatCompactMoney,
  formatDuration,
  formatMoney,
  formatProfitFactor,
} from "@/components/live-trading/live-trading-format"

interface LiveOverviewCompactProps {
  account: LiveAccountSummary | null
  positions: LivePositionView[]
  analytics: LiveTradingAnalytics | null
  positionsAvailable?: boolean
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
          {metric ? `${metric.trades} trades` : "Unavailable"}
        </Badge>
      </div>
      <div className="flex items-end justify-between gap-2">
        <div>
          <div className={`text-sm font-semibold tabular-nums ${tone(pnl)}`}>{metric ? formatCompactMoney(pnl) : "—"}</div>
          <div className="text-[10px] text-muted-foreground">
            {metric ? `${metric.wins}W / ${metric.losses}L · ${Number(metric.winRate).toFixed(0)}%` : "History unavailable"}
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

export function LiveOverviewCompact({ account, positions, analytics, positionsAvailable = true }: LiveOverviewCompactProps) {
  // The live-position endpoint is the canonical engine ledger. Use its exact
  // currently visible rows for position-derived totals so account-cache lag
  // cannot produce mismatched counts/PnL after an operator close or reload.
  const exposure = liveOverviewExposure(positions, account)
  const positionDataAvailable = positionsAvailable || account?.positionsDataAvailable === true
  const balanceDataAvailable = account !== null && account.balance.dataAvailable !== false
  const equityDataAvailable = balanceDataAvailable && account?.balance.equityDataAvailable !== false
  const availableDataAvailable = balanceDataAvailable && account?.balance.availableDataAvailable !== false
  const openPnl = positionsAvailable ? exposure.unrealizedPnl : account?.unrealizedPnl ?? 0
  const margin = positionsAvailable ? exposure.margin : account?.marginUsd ?? 0
  const notional = positionsAvailable ? exposure.notional : account?.volumeUsd ?? 0
  const balance = account?.balance.total ?? 0
  const equity = account?.balance.equity ?? 0
  const available = account?.balance.available ?? 0
  const currency = account?.balance.currency || "USDT"
  const marginRatio = equity > 0 ? (margin / equity) * 100 : 0
  const drawdown = analytics?.drawdown3d

  return (
    <section className="space-y-2" aria-label="Live account and performance overview">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <MetricCard
          icon={WalletCards}
          label="Balance"
          value={balanceDataAvailable ? formatMoney(balance, currency) : "—"}
          detail={balanceDataAvailable ? availableDataAvailable ? `Available ${formatCompactMoney(available, currency)}` : "Available margin unavailable" : "Balance snapshot unavailable"}
        />
        <MetricCard
          icon={BarChart3}
          label="Equity"
          value={equityDataAvailable ? formatMoney(equity, currency) : "—"}
          detail={equityDataAvailable ? "Exchange account equity" : "Equity snapshot unavailable"}
          valueClassName={tone(equity - balance)}
        />
        <MetricCard
          icon={Gauge}
          label="Margin"
          value={positionDataAvailable ? formatMoney(margin, currency) : "—"}
          detail={positionDataAvailable ? `${equityDataAvailable ? `${marginRatio.toFixed(1)}% · ` : ""}${formatCompactMoney(notional, currency)} notional` : "Position snapshot unavailable"}
        />
        <MetricCard
          icon={CircleDollarSign}
          label="Open Profit"
          value={positionDataAvailable ? formatMoney(openPnl, currency) : "—"}
          detail={positionDataAvailable ? "Unrealized, filled positions" : "Position snapshot unavailable"}
          valueClassName={tone(openPnl)}
        />
        <MetricCard
          icon={Layers3}
          label="Open positions"
          value={positionsAvailable ? String(exposure.positions) : "—"}
          detail={positionsAvailable ? `${exposure.long} long · ${exposure.short} short · ${exposure.pendingIntents} pending intents` : "Position snapshot unavailable"}
        />
        <MetricCard
          icon={Layers3}
          label="Exchange positions"
          value={exposure.exchangePositions === null ? "—" : String(exposure.exchangePositions)}
          detail="Aggregate symbol/side positions"
        />
        <MetricCard
          icon={Activity}
          label="Open orders"
          value={exposure.exchangeOrders === null ? "—" : String(exposure.exchangeOrders)}
          detail={exposure.exchangeOrders === null ? "Order snapshot unavailable" : "CTS-tracked exchange orders"}
        />
        <MetricCard
          icon={Clock3}
          label="Drawdown time · 3d"
          value={drawdown ? formatDuration(drawdown.currentDurationMs || drawdown.maxDurationMs || 0) : "—"}
          detail={!drawdown ? "History unavailable" : drawdown.inDrawdown
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
              {(["12", "25", "75"] as const).map((window) => {
                const metric = analytics?.positionWindows[window]
                return (
                  <div key={window} className="rounded-md border bg-muted/20 px-2 py-2 text-center">
                    <div className="text-base font-bold tabular-nums">{formatProfitFactor(metric?.profitFactor, metric?.infinite)}</div>
                    <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Last {window}</div>
                    <div className="mt-0.5 text-[9px] text-muted-foreground">{metric ? `${metric.wins}W / ${metric.losses}L` : "Unavailable"}</div>
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
                  <div className="text-base font-bold tabular-nums">{analytics ? analytics.orderWindows[window] : "—"}</div>
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

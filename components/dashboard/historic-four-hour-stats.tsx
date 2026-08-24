"use client"

import { memo, useId } from "react"
import { Badge } from "@/components/ui/badge"
import type {
  HistoricFourHourBucketStats,
  HistoricFourHourMetrics,
  HistoricFourHourStats,
} from "@/lib/historic-four-hour-stats"

const countFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })
const utcWindowFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
})

function formatCount(value: number): string {
  return countFormatter.format(Number.isFinite(value) ? Math.max(0, value) : 0)
}

function formatMetric(value: number | null, decimals = 4): string {
  return value === null || !Number.isFinite(value) ? "—" : value.toFixed(decimals)
}

function formatSignedPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—"
  const sign = value > 0 ? "+" : ""
  return `${sign}${value.toFixed(4)}%`
}

function formatUtcWindow(bucket: HistoricFourHourBucketStats): string {
  return `${utcWindowFormatter.format(bucket.bucketStartMs)}–${utcWindowFormatter.format(bucket.bucketEndMs)} UTC`
}

function formatHistoricRange(stats: HistoricFourHourStats): string | null {
  if (!stats.rangeStart || !stats.rangeEnd) return null
  const start = Date.parse(stats.rangeStart)
  const end = Date.parse(stats.rangeEnd)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return `${utcWindowFormatter.format(start)}–${utcWindowFormatter.format(end)} UTC`
}

function formatRealizedPf(metrics: HistoricFourHourMetrics): string {
  if (metrics.performance.realizedProfitFactorInfinite) return "∞"
  return formatMetric(metrics.performance.realizedProfitFactor)
}

function CoordinateBadge({ metrics }: { metrics: HistoricFourHourMetrics }) {
  const coordinate = metrics.performance.pfCoordinate
  if (coordinate === null) {
    return <Badge variant="outline" className="font-mono text-[9px]">—</Badge>
  }
  return (
    <Badge
      variant={metrics.performance.meetsMinimumPf ? "default" : "secondary"}
      className="font-mono text-[9px] tabular-nums"
    >
      {coordinate.toFixed(4)}
    </Badge>
  )
}

function SummaryMetric({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-md border bg-muted/20 px-2.5 py-2">
      <div className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-xs font-semibold tabular-nums">{children}</div>
    </div>
  )
}

export const HistoricFourHourStatsPanel = memo(function HistoricFourHourStatsPanel({
  stats,
}: {
  stats?: HistoricFourHourStats | null
}) {
  const summary = stats?.summary
  const titleId = useId()
  const historicRange = stats ? formatHistoricRange(stats) : null
  const integrityInvalid = Boolean(stats && !stats.integrityValid)
  const statusLabel = integrityInvalid
    ? "invalid · recalculation required"
    : stats?.complete
      ? "complete"
      : "calculating"

  return (
    <section
      className="mt-3 border-t pt-3"
      aria-labelledby={titleId}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4
            id={titleId}
            className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Historic calculations · 4-hour details
          </h4>
          <p className="mt-1 max-w-4xl text-[10px] leading-relaxed text-muted-foreground">
            Exhaustive UTC windows, without sampling. PF coordinate = 1.00 + 0.10 ×
            (Σ closed net PnL % ÷ Σ PositionCost %): 1.00 is neutral and 1.10 is
            +1× average PositionCost. Classic realised PF is shown separately.
          </p>
        </div>
        <Badge
          variant={integrityInvalid ? "destructive" : stats?.complete ? "default" : "secondary"}
          className="text-[9px]"
        >
          {statusLabel}
        </Badge>
      </div>

      {integrityInvalid && (
        <div
          role="alert"
          className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[10px] text-destructive"
        >
          Historic aggregate integrity check failed: {stats?.integrityIssues.slice(0, 3).join(" ")}
        </div>
      )}

      {summary && (
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <SummaryMetric label="Coverage / 4h windows">
            {stats?.symbolsProcessed === null || stats?.symbolsExpected === null
              ? "—"
              : `${formatCount(stats.symbolsProcessed)}/${formatCount(stats.symbolsExpected)}`}
            {` · ${formatCount(stats?.bucketCount ?? 0)}`}
          </SummaryMetric>
          <SummaryMetric label="Config evals I / S">
            {formatCount(summary.indicationConfigs)} / {formatCount(summary.strategyConfigs)}
          </SummaryMetric>
          <SummaryMetric label="Indications B / S / N">
            {formatCount(summary.indications.buy)} / {formatCount(summary.indications.sell)} / {formatCount(summary.indications.neutral)}
          </SummaryMetric>
          <SummaryMetric label="Set results C / O">
            {formatCount(summary.setResults.closed)} / {formatCount(summary.setResults.open)}
          </SummaryMetric>
          <SummaryMetric label="PF coordinate">
            <CoordinateBadge metrics={summary} />
          </SummaryMetric>
          <SummaryMetric label="Realised PF">{formatRealizedPf(summary)}</SummaryMetric>
        </div>
      )}

      {!stats || stats.buckets.length === 0 ? (
        <div className="mt-2 rounded-md border border-dashed px-3 py-4 text-center text-[10px] text-muted-foreground">
          No completed four-hour historic calculation windows are available yet.
        </div>
      ) : (
        <div className="mt-2 max-h-[32rem] overflow-auto rounded-md border">
          <table className="w-full min-w-[1180px] border-collapse text-[10px] tabular-nums">
            <caption className="sr-only">
              Complete historic config, indication, set-result and profit-factor statistics for every four-hour UTC window
            </caption>
            <thead className="sticky top-0 z-10 bg-background text-muted-foreground shadow-sm">
              <tr className="border-b text-left">
                <th scope="col" className="whitespace-nowrap px-2 py-2 font-medium">Window</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Symbols</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Config evals I / S</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Indications T · B / S / N</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Set results T · C / O</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">W / L / BE</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Net PnL</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Avg Cost / Net</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">PF coord.</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Realised PF</th>
              </tr>
            </thead>
            <tbody>
              {stats.buckets.map((bucket) => (
                <tr
                  key={bucket.bucketStartMs}
                  className="border-b last:border-b-0 odd:bg-muted/10"
                  style={{ contentVisibility: "auto", containIntrinsicSize: "36px" }}
                >
                  <th
                    scope="row"
                    className="whitespace-nowrap px-2 py-2 text-left font-medium"
                    title={`${bucket.bucketStart} – ${bucket.bucketEnd}`}
                  >
                    {formatUtcWindow(bucket)}
                  </th>
                  <td className="px-2 py-2 text-right">{formatCount(bucket.symbols)}</td>
                  <td className="px-2 py-2 text-right">
                    {formatCount(bucket.indicationConfigs)} / {formatCount(bucket.strategyConfigs)}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {formatCount(bucket.indications.total)} · {formatCount(bucket.indications.buy)} / {formatCount(bucket.indications.sell)} / {formatCount(bucket.indications.neutral)}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {formatCount(bucket.setResults.total)} · {formatCount(bucket.setResults.closed)} / {formatCount(bucket.setResults.open)}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {formatCount(bucket.performance.wins)} / {formatCount(bucket.performance.losses)} / {formatCount(bucket.performance.breakeven)}
                  </td>
                  <td className="px-2 py-2 text-right font-medium">
                    {formatSignedPercent(bucket.performance.netPnlPct)}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {formatSignedPercent(bucket.performance.averagePositionCostPct)} / {formatSignedPercent(bucket.performance.averageNetPnlPct)}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <CoordinateBadge metrics={bucket} />
                  </td>
                  <td className="px-2 py-2 text-right font-medium">{formatRealizedPf(bucket)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-muted-foreground">
        {historicRange && <span>Calculated range: {historicRange}</span>}
        <span>I/S = indication/strategy config evaluations per symbol-window</span>
        <span>C/O = closed/open set results</span>
        <span>BE = breakeven</span>
        <span>Minimum PF coordinate: {stats?.minimumPf?.toFixed(2) ?? "1.10"}</span>
      </div>
    </section>
  )
})

HistoricFourHourStatsPanel.displayName = "HistoricFourHourStatsPanel"

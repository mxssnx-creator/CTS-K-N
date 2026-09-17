"use client"

import { useCallback, useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { RefreshCw } from "lucide-react"

/**
 * Historic Test statistics.
 *
 * Shows what the last validation pass measured per strategy family. Two states
 * are kept visibly distinct because they mean opposite things to an operator:
 * a family that was measured and produced no valid config, and a family that
 * was never measured at all (the replay cannot model it yet, or nothing was
 * scored). A single "no result" would hide whether the system has an opinion.
 */
interface FamilySummary {
  family: string
  combinations: number
  validCombinations: number
  trades: number
  profitFactor: number
  netResultR: number
  averageDrawdownTimeMin: number
  maxDrawdownTimeMin: number
}

interface HistoricTestStats {
  success: boolean
  enabled: boolean
  ranAt: number | null
  window: { fromMs: number; toMs: number; hours: number } | null
  symbols: string[]
  summaries: FamilySummary[]
  validated: { count: number; combinations: Array<Record<string, unknown>> }
  rejected: { count: number; byReason: Record<string, number> }
  scoredCombinations: number
  simulationErrors: number
  settings?: { minProfitFactor: number; periodHours: number }
}

const FAMILY_LABEL: Record<string, string> = {
  normal: "Normal",
  trailing: "Trailing",
  axis: "Axis",
  block: "Block",
  dca: "DCA",
  overall: "Overall",
}

const REASON_LABEL: Record<string, string> = {
  no_trades: "no trades",
  not_positive: "not positive",
  below_min_profit_factor: "below minimum PF",
  unknown: "unknown",
}

function formatPf(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "—"
}

/** PF is PositionCost-relative: 1.00 neutral, every 0.10 one PositionCost. */
function positionCosts(value: number): string {
  if (!Number.isFinite(value)) return "—"
  const costs = (value - 1) / 0.1
  return `${costs >= 0 ? "+" : ""}${costs.toFixed(1)}×`
}

export function HistoricTestStatsPanel({ connectionId }: { connectionId: string }) {
  const [stats, setStats] = useState<HistoricTestStats | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch(`/api/connections/${connectionId}/historic-test`)
      const body = await response.json()
      setStats(body?.success ? body : null)
    } catch {
      setStats(null)
    } finally {
      setLoading(false)
    }
  }, [connectionId])

  useEffect(() => { void load() }, [load])

  const summaries = stats?.summaries ?? []
  const ordered = ["normal", "trailing", "axis", "block", "dca", "overall"]
    .map((family) => summaries.find((row) => row.family === family))
    .filter(Boolean) as FamilySummary[]

  return (
    <Card data-testid="historic-test-stats">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm">Historic Test results</CardTitle>
            <CardDescription className="text-xs">
              {stats?.ranAt
                ? `Last pass ${new Date(stats.ranAt).toLocaleString()} over ${stats.window?.hours ?? "—"} h and ${stats.symbols?.length ?? 0} symbols.`
                : "No pass has completed yet."}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge variant={stats?.enabled ? "default" : "secondary"} className="text-[10px]">
              {stats?.enabled ? "enabled" : "disabled"}
            </Badge>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => void load()} aria-label="Reload Historic Test results">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {ordered.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No results yet. The pass runs on its recalc interval once the Historic Test is enabled.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border/60">
                  <th className="py-1.5 text-left font-medium">Family</th>
                  <th className="py-1.5 text-right font-medium">PF</th>
                  <th className="py-1.5 text-right font-medium">PositionCosts</th>
                  <th className="py-1.5 text-right font-medium">Valid / scored</th>
                  <th className="py-1.5 text-right font-medium">Trades</th>
                  <th className="py-1.5 text-right font-medium">Ø DDT</th>
                  <th className="py-1.5 text-right font-medium">Max DDT</th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((row) => {
                  const measured = row.combinations > 0
                  return (
                    <tr key={row.family} className={`border-b border-border/30 ${row.family === "overall" ? "font-semibold" : ""}`}>
                      <td className="py-1.5">{FAMILY_LABEL[row.family] ?? row.family}</td>
                      <td className="py-1.5 text-right tabular-nums">{measured ? formatPf(row.profitFactor) : "not measured"}</td>
                      <td className="py-1.5 text-right tabular-nums text-muted-foreground">{measured ? positionCosts(row.profitFactor) : "—"}</td>
                      <td className="py-1.5 text-right tabular-nums">{row.validCombinations} / {row.combinations}</td>
                      <td className="py-1.5 text-right tabular-nums">{row.trades}</td>
                      <td className="py-1.5 text-right tabular-nums">{measured ? `${row.averageDrawdownTimeMin.toFixed(0)}m` : "—"}</td>
                      <td className="py-1.5 text-right tabular-nums">{measured ? `${row.maxDrawdownTimeMin.toFixed(0)}m` : "—"}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          <span>Validated configs: <span className="tabular-nums text-foreground">{stats?.validated?.count ?? 0}</span></span>
          <span>Scored: <span className="tabular-nums">{stats?.scoredCombinations ?? 0}</span></span>
          {Object.entries(stats?.rejected?.byReason ?? {}).map(([reason, count]) => (
            <span key={reason}>{REASON_LABEL[reason] ?? reason}: <span className="tabular-nums">{count}</span></span>
          ))}
          {(stats?.simulationErrors ?? 0) > 0 && (
            <span className="text-amber-600 dark:text-amber-400">
              not simulated: <span className="tabular-nums">{stats?.simulationErrors}</span>
            </span>
          )}
          {stats?.settings?.minProfitFactor ? (
            <span>Minimum PF: <span className="tabular-nums">{stats.settings.minProfitFactor.toFixed(2)}</span></span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

"use client"

import { useCallback, useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { RefreshCw } from "lucide-react"

interface FamilyRow {
  family: string
  trades: number
  wins: number
  losses: number
  breakEven: number
  profitFactor: number
  netPnl: number
  netResultR: number
  averageDrawdownTimeMin: number
  maxDrawdownTimeMin: number
}

interface FamilyReport {
  positionCostPercent: number
  families: FamilyRow[]
  overall: FamilyRow
  foreign: { trades: number; netPnl: number }
  connectionIds: string[]
}

const FAMILY_LABEL: Record<string, string> = {
  normal: "Normal",
  trailing: "Trailing",
  axis: "Axis",
  block: "Block",
  dca: "DCA",
  signal: "Signal",
  other: "Other",
  overall: "Overall",
}

function pfTone(row: FamilyRow): string {
  // A family that never traded carries no verdict — colouring it would invent
  // one. 1.00 is the neutral PositionCost coordinate, not a win.
  if (row.trades === 0) return "text-muted-foreground"
  if (row.profitFactor > 1) return "text-emerald-600 dark:text-emerald-400"
  if (row.profitFactor < 1) return "text-red-600 dark:text-red-400"
  return "text-muted-foreground"
}

function minutes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—"
  if (value < 60) return `${value.toFixed(0)} min`
  return `${(value / 60).toFixed(1)} h`
}

export function FamilyPerformancePanel({ connectionId }: { connectionId?: string }) {
  const [report, setReport] = useState<FamilyReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const query = connectionId ? `?connection_id=${encodeURIComponent(connectionId)}` : ""
      const response = await fetch(`/api/statistics/families${query}`, { cache: "no-store" })
      if (!response.ok) throw new Error(`Request failed (${response.status})`)
      const payload = await response.json()
      if (!payload?.success) throw new Error(payload?.error || "Statistics unavailable")
      setReport(payload as FamilyReport)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [connectionId])

  useEffect(() => { void load() }, [load])

  const rows = report ? [...report.families, report.overall] : []

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm">Realised performance by strategy family</CardTitle>
            <CardDescription className="text-xs">
              ProfitFactor on the PositionCost-relative coordinate (1.00 neutral, every 0.10 one
              PositionCost) — the same axis the Historic Test reports, so expectation and outcome
              compare directly. Own trades only; another system&apos;s rows on a shared account are
              counted separately and never mixed into a family.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
        )}
        {!error && !report && (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
        {report && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="py-1.5 text-left font-medium">Family</th>
                    <th className="py-1.5 text-right font-medium">Trades</th>
                    <th className="py-1.5 text-right font-medium">W / L</th>
                    <th className="py-1.5 text-right font-medium">PF</th>
                    <th className="py-1.5 text-right font-medium">Net (PC)</th>
                    <th className="py-1.5 text-right font-medium">Ø DDT</th>
                    <th className="py-1.5 text-right font-medium">Max DDT</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.family}
                      className={`border-b border-border/50 ${row.family === "overall" ? "font-semibold" : ""}`}
                    >
                      <td className="py-1.5">{FAMILY_LABEL[row.family] ?? row.family}</td>
                      <td className="py-1.5 text-right tabular-nums">{row.trades}</td>
                      <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                        {row.trades === 0 ? "—" : `${row.wins} / ${row.losses}`}
                      </td>
                      <td className={`py-1.5 text-right tabular-nums ${pfTone(row)}`}>
                        {row.trades === 0 ? "—" : row.profitFactor.toFixed(4)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {row.trades === 0 ? "—" : row.netResultR.toFixed(2)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{minutes(row.averageDrawdownTimeMin)}</td>
                      <td className="py-1.5 text-right tabular-nums">{minutes(row.maxDrawdownTimeMin)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <Badge variant="secondary" className="text-[10px]">
                PositionCost {report.positionCostPercent}%
              </Badge>
              {report.foreign.trades > 0 && (
                <Badge variant="outline" className="text-[10px]">
                  {report.foreign.trades} foreign row(s) excluded
                </Badge>
              )}
              {report.overall.trades === 0 && (
                <span>No realised own trades yet — every family reads &quot;—&quot; rather than a neutral 1.00.</span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

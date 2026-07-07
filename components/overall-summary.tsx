"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Activity, Database, Wifi, BarChart3, Layers, AlertCircle } from "lucide-react"

interface OverallSummaryProps {
  data: {
    symbolCount: number
    prehistoricLoadedSymbols: number
    prehistoricTotalSymbols: number
    prehistoricTotalCandles: number
    prehistoricCompleted: boolean
    wsSymbolsConnected: number
    wsTotalSymbols: number
    wsMessagesTotal: number
    totalIndicationCycles: number
    totalStrategyCycles: number
    totalRealtimeCycles: number
    indicationSummary: {
      totalEvaluations: number
      overallPassRate: number
      typesTracked: number
    }
    strategySummary: {
      totalEvaluated: number
      overallPassRate: number
      avgProfitFactor: number
      avgDrawdownTime: number
    }
    errorCount: number
    logCount: number
    // ── Spec-mandated overview metrics ─────────────────────────────────
    // Both fields are optional so existing callers (dashboards that
    // pre-date the spec change) continue to render. When provided the
    // dedicated tiles surface them in the metrics grid below.
    //   * executedPositions — cumulative live-exchange-position count
    //     since engine start (canonical "Executed Positions" metric).
    //   * historicAvgProfitFactor — aggregate profit factor across every
    //     closed prehistoric position (sum(+pct)/|sum(-pct)|, 0 ⇒ no
    //     closed positions yet so the tile renders "—").
    executedPositions?: number
    historicAvgProfitFactor?: number
  }
}

export function OverallSummary({ data }: OverallSummaryProps) {
  const totalCycles = data.totalIndicationCycles + data.totalStrategyCycles + data.totalRealtimeCycles
  const prehistoricPercent = data.prehistoricTotalSymbols > 0 
    ? (data.prehistoricLoadedSymbols / data.prehistoricTotalSymbols) * 100 
    : 0

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Activity className="h-4 w-4" />
          Overall Summary
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {/* Symbols */}
          <div className="text-center p-3 bg-blue-50 dark:bg-blue-950/20 rounded-lg">
            <Database className="h-5 w-5 mx-auto mb-1 text-blue-600" />
            <div className="text-2xl font-bold">{data.symbolCount}</div>
            <div className="text-xs text-muted-foreground">Symbols</div>
          </div>

          {/* Prehistoric */}
          <div className="text-center p-3 bg-purple-50 dark:bg-purple-950/20 rounded-lg">
            <Database className="h-5 w-5 mx-auto mb-1 text-purple-600" />
            <div className="text-2xl font-bold">{data.prehistoricTotalCandles}</div>
            <div className="text-xs text-muted-foreground">Candles</div>
            <Progress value={prehistoricPercent} className="h-1 mt-1" />
          </div>

          {/* Processing */}
          <div className="text-center p-3 bg-green-50 dark:bg-green-950/20 rounded-lg">
            <BarChart3 className="h-5 w-5 mx-auto mb-1 text-green-600" />
            <div className="text-2xl font-bold">{totalCycles}</div>
            <div className="text-xs text-muted-foreground">Total Cycles</div>
          </div>

          {/* Errors */}
          <div className="text-center p-3 bg-red-50 dark:bg-red-950/20 rounded-lg">
            <AlertCircle className="h-5 w-5 mx-auto mb-1 text-red-600" />
            <div className="text-2xl font-bold">{data.errorCount}</div>
            <div className="text-xs text-muted-foreground">Errors</div>
          </div>
        </div>

        {/* ── Spec-mandated overview metrics ─────────────────────────────
            Two tiles surfaced alongside the primary grid above when the
            data payload supplies them. Both fall back gracefully when the
            engine has yet to produce any executed positions / closed
            prehistoric positions — the tile renders a placeholder so the
            row stays visually balanced rather than collapsing the layout. */}
        {(typeof data.executedPositions === "number" || typeof data.historicAvgProfitFactor === "number") && (
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="text-center p-3 bg-amber-50 dark:bg-amber-950/20 rounded-lg">
              <BarChart3 className="h-5 w-5 mx-auto mb-1 text-amber-600" />
              <div className="text-2xl font-bold tabular-nums">
                {typeof data.executedPositions === "number"
                  ? data.executedPositions
                  : "—"}
              </div>
              <div className="text-xs text-muted-foreground">Executed Positions</div>
            </div>
            <div className="text-center p-3 bg-emerald-50 dark:bg-emerald-950/20 rounded-lg">
              <Activity className="h-5 w-5 mx-auto mb-1 text-emerald-600" />
              <div className="text-2xl font-bold tabular-nums">
                {typeof data.historicAvgProfitFactor === "number" && data.historicAvgProfitFactor > 0
                  ? data.historicAvgProfitFactor.toFixed(2)
                  : "—"}
              </div>
              <div className="text-xs text-muted-foreground">Avg R</div>
            </div>
          </div>
        )}

        {/* Detailed Metrics */}
        <div className="grid grid-cols-2 gap-3 text-xs">
          {/* WebSocket */}
          <div className="flex items-center gap-2 p-2 bg-muted/30 rounded">
            <Wifi className="h-4 w-4 text-muted-foreground" />
            <div>
              <span className="text-muted-foreground">WS:</span>{" "}
              <Badge variant={data.wsSymbolsConnected > 0 ? "default" : "secondary"} className="text-xs">
                {data.wsSymbolsConnected}/{data.wsTotalSymbols}
              </Badge>
              <span className="ml-2 text-muted-foreground">Msgs:</span> {data.wsMessagesTotal}
            </div>
          </div>

          {/* Indications */}
          <div className="flex items-center gap-2 p-2 bg-muted/30 rounded">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            <div>
              <span className="text-muted-foreground">Indications:</span>{" "}
              <Badge variant="secondary" className="text-xs">
                {data.indicationSummary.totalEvaluations} evals
              </Badge>
              <span className="ml-2 text-muted-foreground">Pass:</span>{" "}
              <span className="text-green-600 font-medium">{Math.round(data.indicationSummary.overallPassRate)}%</span>
            </div>
          </div>

          {/* Strategies */}
          <div className="flex items-center gap-2 p-2 bg-muted/30 rounded">
            <Layers className="h-4 w-4 text-muted-foreground" />
            <div>
              <span className="text-muted-foreground">Strategies:</span>{" "}
              <Badge variant="secondary" className="text-xs">
                {data.strategySummary.totalEvaluated} evals
              </Badge>
              <span className="ml-2 text-muted-foreground">Avg R:</span>{" "}
              <span className="font-medium">{data.strategySummary.totalEvaluated > 0 ? data.strategySummary.avgProfitFactor.toFixed(2) : "—"}</span>
            </div>
          </div>

          {/* Processing Cycles */}
          <div className="flex items-center gap-2 p-2 bg-muted/30 rounded">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <div>
              <span className="text-muted-foreground">Cycles:</span>{" "}
              <span className="font-medium">{data.totalIndicationCycles}</span> ind,{" "}
              <span className="font-medium">{data.totalStrategyCycles}</span> strat,{" "}
              <span className="font-medium">{data.totalRealtimeCycles}</span> rt
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

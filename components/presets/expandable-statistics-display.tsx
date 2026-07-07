"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { ChevronDown, ChevronRight, TrendingUp, TrendingDown, BarChart3, Clock, Target, Zap } from "lucide-react"
import type { PresetCoordinationResult } from "@/lib/types-preset-coordination"

interface ExpandableStatisticsDisplayProps {
  results: PresetCoordinationResult[]
  minProfitFactor: number
  maxDrawdownHours: number
}

interface GroupedResults {
  majorRange: string
  minorRanges: {
    range: string
    tpSteps: {
      tp: number
      slRatios: {
        sl: number
        trailings: {
          enabled: boolean
          start: number | null
          stop: number | null
          results: PresetCoordinationResult[]
        }[]
      }[]
    }[]
  }[]
}

export function ExpandableStatisticsDisplay({
  results,
  minProfitFactor,
  maxDrawdownHours,
}: ExpandableStatisticsDisplayProps) {
  const [expandedMajor, setExpandedMajor] = useState<Set<string>>(new Set())
  const [expandedMinor, setExpandedMinor] = useState<Set<string>>(new Set())
  const [expandedTP, setExpandedTP] = useState<Set<string>>(new Set())
  const [expandedSL, setExpandedSL] = useState<Set<string>>(new Set())
  const [groupedData, setGroupedData] = useState<GroupedResults[]>([])

  useEffect(() => {
    // Group results by hierarchical levels
    const grouped = groupResultsByLevels(results, minProfitFactor, maxDrawdownHours)
    setGroupedData(grouped)
  }, [results, minProfitFactor, maxDrawdownHours])

  const toggleMajor = (key: string) => {
    const newSet = new Set(expandedMajor)
    if (newSet.has(key)) {
      newSet.delete(key)
    } else {
      newSet.add(key)
    }
    setExpandedMajor(newSet)
  }

  const toggleMinor = (key: string) => {
    const newSet = new Set(expandedMinor)
    if (newSet.has(key)) {
      newSet.delete(key)
    } else {
      newSet.add(key)
    }
    setExpandedMinor(newSet)
  }

  const toggleTP = (key: string) => {
    const newSet = new Set(expandedTP)
    if (newSet.has(key)) {
      newSet.delete(key)
    } else {
      newSet.add(key)
    }
    setExpandedTP(newSet)
  }

  const toggleSL = (key: string) => {
    const newSet = new Set(expandedSL)
    if (newSet.has(key)) {
      newSet.delete(key)
    } else {
      newSet.add(key)
    }
    setExpandedSL(newSet)
  }

  const calculateMetrics = (results: PresetCoordinationResult[]) => {
    if (results.length === 0) return null

    const avgPF = results.reduce((sum, r) => sum + r.profit_factor, 0) / results.length
    const avgWR = results.reduce((sum, r) => sum + r.win_rate, 0) / results.length
    const avgDrawdown = results.reduce((sum, r) => sum + r.drawdown_time_hours, 0) / results.length
    const totalTrades = results.reduce((sum, r) => sum + r.total_trades, 0)
    const validCount = results.filter((r) => r.is_valid).length

    return {
      avgProfitFactor: avgPF,
      avgWinRate: avgWR,
      avgDrawdown,
      totalTrades,
      validCount,
      totalConfigs: results.length,
    }
  }

  if (groupedData.length === 0) {
    return (
      <Card>
        <CardContent className="p-12 text-center">
          <BarChart3 className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
          <h3 className="text-lg font-semibold mb-2">No statistics available</h3>
          <p className="text-muted-foreground">Run evaluations to generate detailed statistics</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-2">
      {groupedData.map((major, majorIdx) => {
        const majorKey = `major-${majorIdx}`
        const isMajorExpanded = expandedMajor.has(majorKey)
        const majorMetrics = calculateMetrics(
          major.minorRanges.flatMap((minor) =>
            minor.tpSteps.flatMap((tp) => tp.slRatios.flatMap((sl) => sl.trailings.flatMap((trail) => trail.results))),
          ),
        )

        return (
          <Card key={majorKey} className="overflow-hidden">
            <CardHeader
              className="cursor-pointer hover:bg-accent/50 transition-colors p-4"
              onClick={() => toggleMajor(majorKey)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {isMajorExpanded ? (
                    <ChevronDown className="h-5 w-5 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-5 w-5 text-muted-foreground" />
                  )}
                  <div>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Target className="h-4 w-4" />
                      {major.majorRange}
                      <Badge variant={majorMetrics && majorMetrics.avgProfitFactor >= 1 ? "default" : "secondary"}>
                        {majorMetrics?.totalConfigs || 0} configs
                      </Badge>
                      <Badge variant="outline">{majorMetrics?.validCount || 0} valid</Badge>
                    </CardTitle>
                    {majorMetrics && (
                      <CardDescription className="text-xs mt-1">
                        Avg R: {majorMetrics.totalTrades > 0 ? majorMetrics.avgProfitFactor.toFixed(2) : "—"} • Win Rate:{" "}
                        {(majorMetrics.avgWinRate * 100).toFixed(1)}% • Drawdown: {majorMetrics.avgDrawdown.toFixed(1)}h
                      </CardDescription>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  {majorMetrics && (
                    <>
                      <div className="text-right">
                        <div className="text-sm font-medium flex items-center gap-1">
                          {majorMetrics.avgProfitFactor >= 1 ? (
                            <TrendingUp className="h-4 w-4 text-green-500" />
                          ) : (
                            <TrendingDown className="h-4 w-4 text-red-500" />
                          )}
                          {majorMetrics.totalTrades > 0 ? majorMetrics.avgProfitFactor.toFixed(2) : "—"}
                        </div>
                        <div className="text-xs text-muted-foreground">{majorMetrics.totalTrades} trades</div>
                      </div>
                      <Progress value={(majorMetrics.validCount / majorMetrics.totalConfigs) * 100} className="w-24" />
                    </>
                  )}
                </div>
              </div>
            </CardHeader>

            {isMajorExpanded && (
              <CardContent className="p-0 border-t">
                <div className="space-y-1">
                  {major.minorRanges.map((minor, minorIdx) => {
                    const minorKey = `${majorKey}-minor-${minorIdx}`
                    const isMinorExpanded = expandedMinor.has(minorKey)
                    const minorMetrics = calculateMetrics(
                      minor.tpSteps.flatMap((tp) =>
                        tp.slRatios.flatMap((sl) => sl.trailings.flatMap((trail) => trail.results)),
                      ),
                    )

                    return (
                      <div key={minorKey} className="border-b last:border-b-0">
                        <div
                          className="cursor-pointer hover:bg-accent/30 transition-colors p-3 pl-12"
                          onClick={() => toggleMinor(minorKey)}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              {isMinorExpanded ? (
                                <ChevronDown className="h-4 w-4 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="h-4 w-4 text-muted-foreground" />
                              )}
                              <span className="text-sm font-medium">{minor.range}</span>
                              <Badge variant="outline" className="text-xs">
                                {minorMetrics?.totalConfigs || 0}
                              </Badge>
                            </div>
                            {minorMetrics && (
                              <div className="flex items-center gap-3 text-sm">
                                <span className={minorMetrics.avgProfitFactor >= 1 ? "text-green-600" : "text-red-600"}>
                                  Avg R: {minorMetrics.totalTrades > 0 ? minorMetrics.avgProfitFactor.toFixed(2) : "—"}
                                </span>
                                <span className="text-muted-foreground">
                                  WR: {(minorMetrics.avgWinRate * 100).toFixed(0)}%
                                </span>
                              </div>
                            )}
                          </div>
                        </div>

                        {isMinorExpanded && (
                          <div className="bg-accent/10 space-y-1">
                            {minor.tpSteps.map((tp, tpIdx) => {
                              const tpKey = `${minorKey}-tp-${tpIdx}`
                              const isTPExpanded = expandedTP.has(tpKey)
                              const tpMetrics = calculateMetrics(
                                tp.slRatios.flatMap((sl) => sl.trailings.flatMap((trail) => trail.results)),
                              )

                              return (
                                <div key={tpKey} className="border-b last:border-b-0">
                                  <div
                                    className="cursor-pointer hover:bg-accent/40 transition-colors p-2 pl-20"
                                    onClick={() => toggleTP(tpKey)}
                                  >
                                    <div className="flex items-center justify-between">
                                      <div className="flex items-center gap-2">
                                        {isTPExpanded ? (
                                          <ChevronDown className="h-3 w-3 text-muted-foreground" />
                                        ) : (
                                          <ChevronRight className="h-3 w-3 text-muted-foreground" />
                                        )}
                                        <span className="text-xs font-medium">TP: {tp.tp}x</span>
                                        <Badge variant="secondary" className="text-xs h-5">
                                          {tpMetrics?.totalConfigs || 0}
                                        </Badge>
                                      </div>
                                      {tpMetrics && (
                                        <span className="text-xs text-muted-foreground">
                                          {tpMetrics.totalTrades > 0 ? tpMetrics.avgProfitFactor.toFixed(2) : "—"}
                                        </span>
                                      )}
                                    </div>
                                  </div>

                                  {isTPExpanded && (
                                    <div className="bg-accent/20 space-y-0.5">
                                      {tp.slRatios.map((sl, slIdx) => {
                                        const slKey = `${tpKey}-sl-${slIdx}`
                                        const isSLExpanded = expandedSL.has(slKey)
                                        const slMetrics = calculateMetrics(
                                          sl.trailings.flatMap((trail) => trail.results),
                                        )

                                        return (
                                          <div key={slKey}>
                                            <div
                                              className="cursor-pointer hover:bg-accent/50 transition-colors p-2 pl-28"
                                              onClick={() => toggleSL(slKey)}
                                            >
                                              <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-2">
                                                  {isSLExpanded ? (
                                                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                                                  ) : (
                                                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                                                  )}
                                                  <span className="text-xs">SL: {sl.sl.toFixed(2)}</span>
                                                  <Badge variant="secondary" className="text-xs h-4">
                                                    {slMetrics?.totalConfigs || 0}
                                                  </Badge>
                                                </div>
                                                {slMetrics && (
                                                  <span className="text-xs text-muted-foreground">
                                                    {slMetrics.totalTrades > 0 ? slMetrics.avgProfitFactor.toFixed(2) : "—"}
                                                  </span>
                                                )}
                                              </div>
                                            </div>

                                            {isSLExpanded && (
                                              <div className="bg-accent/30 p-2 pl-36 space-y-1">
                                                {sl.trailings.map((trail, trailIdx) => {
                                                  const trailMetrics = calculateMetrics(trail.results)
                                                  if (!trailMetrics) return null

                                                  return (
                                                    <div
                                                      key={trailIdx}
                                                      className="flex items-center justify-between p-2 bg-background rounded text-xs hover:bg-accent/20 transition-colors"
                                                    >
                                                      <div className="flex items-center gap-2">
                                                        <Zap className="h-3 w-3 text-muted-foreground" />
                                                        <span>
                                                          {trail.enabled
                                                            ? `Trail: ${trail.start}% → ${trail.stop}%`
                                                            : "No Trailing"}
                                                        </span>
                                                        <Badge
                                                          variant={
                                                            trailMetrics.avgProfitFactor >= minProfitFactor
                                                              ? "default"
                                                              : "secondary"
                                                          }
                                                          className="text-xs h-4"
                                                        >
                                                          {trail.results.length}
                                                        </Badge>
                                                      </div>
                                                      <div className="flex items-center gap-3">
                                                        <span
                                                          className={
                                                            trailMetrics.avgProfitFactor >= 1
                                                              ? "text-green-600 font-medium"
                                                              : "text-red-600"
                                                          }
                                                        >
                                                          Avg R: {trailMetrics.totalTrades > 0 ? trailMetrics.avgProfitFactor.toFixed(2) : "—"}
                                                        </span>
                                                        <span className="text-muted-foreground">
                                                          WR: {(trailMetrics.avgWinRate * 100).toFixed(0)}%
                                                        </span>
                                                        <div className="flex items-center gap-1">
                                                          <Clock className="h-3 w-3" />
                                                          <span>{trailMetrics.avgDrawdown.toFixed(1)}h</span>
                                                        </div>
                                                        <span className="text-muted-foreground">
                                                          {trailMetrics.totalTrades} trades
                                                        </span>
                                                      </div>
                                                    </div>
                                                  )
                                                })}
                                              </div>
                                            )}
                                          </div>
                                        )
                                      })}
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            )}
          </Card>
        )
      })}
    </div>
  )
}

// Helper function to group results by hierarchical levels
function groupResultsByLevels(
  results: PresetCoordinationResult[],
  minProfitFactor: number,
  maxDrawdownHours: number,
): GroupedResults[] {
  // Filter results by criteria
  const filtered = results.filter(
    (r) => r.profit_factor >= minProfitFactor && r.drawdown_time_hours <= maxDrawdownHours,
  )

  // Group by major range (indication type + major param ranges)
  const majorGroups = new Map<string, PresetCoordinationResult[]>()

  for (const result of filtered) {
    const params = result.indication_params as any
    const majorKey = `${result.indication_type}-${getMajorRangeKey(params)}`

    if (!majorGroups.has(majorKey)) {
      majorGroups.set(majorKey, [])
    }
    majorGroups.get(majorKey)!.push(result)
  }

  // Build hierarchical structure
  const grouped: GroupedResults[] = []

  for (const [majorKey, majorResults] of majorGroups) {
    // Group by minor ranges (specific parameter variations)
    const minorGroups = new Map<string, PresetCoordinationResult[]>()

    for (const result of majorResults) {
      const params = result.indication_params as any
      const minorKey = getMinorRangeKey(params)

      if (!minorGroups.has(minorKey)) {
        minorGroups.set(minorKey, [])
      }
      minorGroups.get(minorKey)!.push(result)
    }

    const minorRanges = Array.from(minorGroups.entries()).map(([minorKey, minorResults]) => {
      // Group by TP factor
      const tpGroups = new Map<number, PresetCoordinationResult[]>()

      for (const result of minorResults) {
        if (!tpGroups.has(result.takeprofit_factor)) {
          tpGroups.set(result.takeprofit_factor, [])
        }
        tpGroups.get(result.takeprofit_factor)!.push(result)
      }

      const tpSteps = Array.from(tpGroups.entries()).map(([tp, tpResults]) => {
        // Group by SL ratio
        const slGroups = new Map<number, PresetCoordinationResult[]>()

        for (const result of tpResults) {
          if (!slGroups.has(result.stoploss_ratio)) {
            slGroups.set(result.stoploss_ratio, [])
          }
          slGroups.get(result.stoploss_ratio)!.push(result)
        }

        const slRatios = Array.from(slGroups.entries()).map(([sl, slResults]) => {
          // Group by trailing config
          const trailingGroups = new Map<string, PresetCoordinationResult[]>()

          for (const result of slResults) {
            const trailKey = result.trailing_enabled ? `${result.trail_start}-${result.trail_stop}` : "no-trailing"

            if (!trailingGroups.has(trailKey)) {
              trailingGroups.set(trailKey, [])
            }
            trailingGroups.get(trailKey)!.push(result)
          }

          const trailings = Array.from(trailingGroups.entries()).map(([trailKey, trailResults]) => {
            const firstResult = trailResults[0]
            return {
              enabled: firstResult.trailing_enabled,
              start: firstResult.trail_start ?? null,
              stop: firstResult.trail_stop ?? null,
              results: trailResults,
            }
          })

          return { sl, trailings }
        })

        return { tp, slRatios }
      })

      return { range: minorKey, tpSteps }
    })

    grouped.push({
      majorRange: majorKey,
      minorRanges,
    })
  }

  return grouped
}

function getMajorRangeKey(params: any): string {
  // Extract major parameter ranges (e.g., RSI 10-20, MACD 12-26-9)
  if (params.period) {
    return `Period ${params.period}`
  }
  if (params.fastPeriod && params.slowPeriod && params.signalPeriod) {
    return `${params.fastPeriod}-${params.slowPeriod}-${params.signalPeriod}`
  }
  return JSON.stringify(params)
}

function getMinorRangeKey(params: any): string {
  // Extract specific parameter values
  return JSON.stringify(params)
}

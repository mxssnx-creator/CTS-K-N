"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import type { PseudoPosition } from "@/lib/types"
import {
  resolvePseudoPositionNetPnl,
  resolvePseudoPositionSignedResultR,
} from "@/lib/profit-factor"
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts"
import { TrendingUp, TrendingDown, Activity, CheckCircle2, XCircle } from "lucide-react"

interface BlockStrategyStatsProps {
  positions: PseudoPosition[]
  comparisonWindow?: number
}

interface BlockPerformance {
  blockSize: number
  withBlockStrategy: {
    avgPnL: number
    positionCount: number
    winRate: number
  }
  withoutBlockStrategy: {
    avgPnL: number
    positionCount: number
    winRate: number
  }
  performanceDiff: number
  favorable: boolean
}

export function BlockStrategyStats({ positions, comparisonWindow = 50 }: BlockStrategyStatsProps) {
  const [blockPerformances, setBlockPerformances] = useState<BlockPerformance[]>([])
  const [settings, setSettings] = useState<any>(null)

  // Load settings
  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => setSettings(data?.settings || data))
      .catch((err) => console.error("Failed to load settings:", err))
  }, [])

  // Calculate block strategy performance
  useEffect(() => {
    if (positions.length === 0) {
      setBlockPerformances([])
      return
    }

    const blockSizes = [2, 4, 6, 8]
    const performances: BlockPerformance[] = []

    // Get the last N positions for comparison
    const recentPositions = [...positions]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, comparisonWindow)

    blockSizes.forEach((blockSize) => {
      // Group positions into blocks
      const blocks: PseudoPosition[][] = []
      for (let i = 0; i < recentPositions.length; i += blockSize) {
        blocks.push(recentPositions.slice(i, i + blockSize))
      }

      // Determine which blocks were processed with adjustment
      // A block is considered "with adjustment" if the previous block had negative profit
      const withAdjustment: PseudoPosition[] = []
      const withoutAdjustment: PseudoPosition[] = []

      blocks.forEach((block, index) => {
        if (index === 0) {
          // First block is always without adjustment
          withoutAdjustment.push(...block)
        } else {
          const prevBlock = blocks[index - 1]
          const prevBlockProfit = prevBlock.reduce((sum, p) => sum + resolvePseudoPositionNetPnl(p), 0)

          if (prevBlockProfit < 0) {
            // Previous block was negative, so this block would have adjustment
            withAdjustment.push(...block)
          } else {
            withoutAdjustment.push(...block)
          }
        }
      })

      // Calculate statistics for WITH adjustment
      const withStats = {
        avgPnL:
          withAdjustment.length > 0
            ? withAdjustment.reduce((sum, p) => sum + resolvePseudoPositionNetPnl(p), 0) /
              withAdjustment.length
            : 0,
        positionCount: withAdjustment.length,
        winRate:
          withAdjustment.length > 0
            ? withAdjustment.filter((p) => resolvePseudoPositionSignedResultR(p) > 0).length / withAdjustment.length
            : 0,
      }

      // Calculate statistics for WITHOUT adjustment
      const withoutStats = {
        avgPnL:
          withoutAdjustment.length > 0
            ? withoutAdjustment.reduce((sum, p) => sum + resolvePseudoPositionNetPnl(p), 0) /
              withoutAdjustment.length
            : 0,
        positionCount: withoutAdjustment.length,
        winRate:
          withoutAdjustment.length > 0
            ? withoutAdjustment.filter((p) => resolvePseudoPositionSignedResultR(p) > 0).length / withoutAdjustment.length
            : 0,
      }

      const performanceDiff = withStats.avgPnL - withoutStats.avgPnL
      const favorable =
        withStats.positionCount >= 5 &&
        withStats.avgPnL >= withoutStats.avgPnL

      performances.push({
        blockSize,
        withBlockStrategy: withStats,
        withoutBlockStrategy: withoutStats,
        performanceDiff,
        favorable,
      })
    })

    setBlockPerformances(performances)
  }, [positions, comparisonWindow])

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(amount)
  }

  // Prepare chart data
  const chartData = blockPerformances.map((perf) => ({
    blockSize: `Block ${perf.blockSize}`,
    with: perf.withBlockStrategy.avgPnL,
    without: perf.withoutBlockStrategy.avgPnL,
    diff: perf.performanceDiff,
  }))

  const totalWithBlock = blockPerformances.reduce((sum, p) => sum + p.withBlockStrategy.avgPnL, 0)
  const totalWithoutBlock = blockPerformances.reduce((sum, p) => sum + p.withoutBlockStrategy.avgPnL, 0)
  const favorableCount = blockPerformances.filter((p) => p.favorable).length
  const belowBaselineCount = blockPerformances.filter(
    (p) => p.withBlockStrategy.positionCount >= 5 && !p.favorable,
  ).length

  return (
    <div className="space-y-6">
      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-blue-500" />
              <div>
                <div className="text-2xl font-bold">{comparisonWindow}</div>
                <div className="text-sm text-muted-foreground">Comparison Window</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
              <div>
                <div className="text-2xl font-bold">{favorableCount}</div>
                <div className="text-sm text-muted-foreground">Favorable Windows</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-red-500" />
              <div>
                <div className="text-2xl font-bold">{belowBaselineCount}</div>
                <div className="text-sm text-muted-foreground">Below Baseline</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-green-500" />
              <div>
                <div className={`text-xl font-bold ${totalWithBlock >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {formatCurrency(totalWithBlock)}
                </div>
                <div className="text-sm text-muted-foreground">Avg Post-Loss Window</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <TrendingDown className="h-5 w-5 text-orange-500" />
              <div>
                <div className={`text-xl font-bold ${totalWithoutBlock >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {formatCurrency(totalWithoutBlock)}
                </div>
                <div className="text-sm text-muted-foreground">Avg Baseline Window</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Block Strategy Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {blockPerformances.map((perf) => (
          <Card key={perf.blockSize} className={perf.favorable ? "border-green-500" : "border-border"}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">Block Size {perf.blockSize}</CardTitle>
                <Badge variant={perf.favorable ? "default" : "secondary"}>
                  {perf.favorable ? <CheckCircle2 className="h-3 w-3 mr-1" /> : <XCircle className="h-3 w-3 mr-1" />}
                  {perf.favorable ? "Favorable" : "Below baseline"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* WITH Block Strategy */}
              <div className="p-3 bg-green-50 dark:bg-green-950 rounded-lg">
                <div className="text-xs text-muted-foreground mb-1">After a Negative Prior Block</div>
                <div className="flex items-center justify-between">
                  <div className="text-lg font-bold text-green-600">
                    {formatCurrency(perf.withBlockStrategy.avgPnL)}
                  </div>
                  <Badge variant="outline" className="text-xs">
                    {perf.withBlockStrategy.positionCount} pos
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  Win Rate: {(perf.withBlockStrategy.winRate * 100).toFixed(1)}%
                </div>
              </div>

              {/* WITHOUT Block Strategy */}
              <div className="p-3 bg-orange-50 dark:bg-orange-950 rounded-lg">
                <div className="text-xs text-muted-foreground mb-1">Other Baseline Windows</div>
                <div className="flex items-center justify-between">
                  <div className="text-lg font-bold text-orange-600">
                    {formatCurrency(perf.withoutBlockStrategy.avgPnL)}
                  </div>
                  <Badge variant="outline" className="text-xs">
                    {perf.withoutBlockStrategy.positionCount} pos
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  Win Rate: {(perf.withoutBlockStrategy.winRate * 100).toFixed(1)}%
                </div>
              </div>

              {/* Performance Difference */}
              <div className="pt-2 border-t">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-muted-foreground">Difference:</div>
                  <div className={`text-sm font-bold ${perf.performanceDiff >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {perf.performanceDiff >= 0 ? "+" : ""}
                    {formatCurrency(perf.performanceDiff)}
                  </div>
                </div>
                {!perf.favorable && perf.withBlockStrategy.positionCount >= 5 && (
                  <div className="text-xs text-red-600 mt-1">Performance below baseline</div>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Performance Comparison Chart */}
      <Card>
        <CardHeader>
          <CardTitle>Observed Post-Loss vs Baseline Windows</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="blockSize" />
              <YAxis tickFormatter={(value) => formatCurrency(value)} />
              <Tooltip
                formatter={(value: number, name: string) => {
                  const label = name === "with" ? "Post-loss" : name === "without" ? "Baseline" : "Difference"
                  return [formatCurrency(value), label]
                }}
              />
              <Bar dataKey="with" fill="#10b981" name="Post-loss windows" />
              <Bar dataKey="without" fill="#f59e0b" name="Baseline windows" />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Performance Difference Chart */}
      <Card>
        <CardHeader>
          <CardTitle>Observed Difference (Post-Loss - Baseline)</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="blockSize" />
              <YAxis tickFormatter={(value) => formatCurrency(value)} />
              <Tooltip formatter={(value: number) => [formatCurrency(value), "Difference"]} />
              <Bar dataKey="diff" name="Performance Difference">
                {chartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.diff >= 0 ? "#10b981" : "#ef4444"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Settings Info */}
      {settings && (
        <Card>
          <CardHeader>
            <CardTitle>Block Strategy Settings</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <div className="text-sm text-muted-foreground">Execution Mode</div>
                <div className="text-lg font-bold">
                  {(settings.blockAdjustment ?? settings.variantBlockEnabled) !== false
                    ? settings.blockOnly !== false
                      ? "Block-only"
                      : "Standard + Block"
                    : "Standard only"}
                </div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Volume / PF Ratios</div>
                <div className="text-lg font-bold">
                  {Number(settings.blockVolumeRatio ?? 1).toFixed(2)}× /{" "}
                  {Number(settings.blockProfitFactorRatio ?? 0.8).toFixed(2)}×
                </div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Max Stack / Analysis Window</div>
                <div className="text-lg font-bold">
                  {Number(settings.blockMaxStack ?? 12)} / {comparisonWindow} positions
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

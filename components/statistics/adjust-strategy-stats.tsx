"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import type { PseudoPosition } from "@/lib/types"
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line } from "recharts"
import { TrendingUp, TrendingDown, Clock, Activity } from "lucide-react"

interface AdjustStrategyStatsProps {
  positions: PseudoPosition[]
  timeIntervals?: number[] // hours
  drawdownPositionCount?: number
}

interface BlockStats {
  blockSize: number
  blockNumber: number
  profitFactor: number
  positionCount: number
  avgProfit: number
  startTime: Date
  endTime: Date
}

interface TimeIntervalStats {
  interval: number // hours
  blocks: BlockStats[]
  avgProfitFactor: number
  totalBlocks: number
}

interface DrawdownPeriod {
  startIndex: number
  endIndex: number
  duration: number // in hours
  maxDrawdown: number
  positionCount: number
}

export function AdjustStrategyStats({
  positions,
  timeIntervals = [4, 12, 24, 48],
  drawdownPositionCount = 80,
}: AdjustStrategyStatsProps) {
  // Calculate block statistics for different time intervals
  const calculateBlockStats = (blockSize: number, timeWindowHours: number): BlockStats[] => {
    const now = new Date()
    const timeWindowMs = timeWindowHours * 60 * 60 * 1000
    const cutoffTime = new Date(now.getTime() - timeWindowMs)

    // Filter positions within time window and sort by time
    const recentPositions = positions
      .filter((p) => new Date(p.created_at) >= cutoffTime)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

    const blocks: BlockStats[] = []
    for (let i = 0; i < recentPositions.length; i += blockSize) {
      const blockPositions = recentPositions.slice(i, i + blockSize)
      if (blockPositions.length === 0) continue

      const profitFactors = blockPositions.map((p) => p.profit_factor)
      const avgProfitFactor = profitFactors.reduce((sum, pf) => sum + pf, 0) / profitFactors.length
      const avgProfit =
        blockPositions.reduce((sum, p) => sum + (p.profit_factor - 1) * p.position_cost, 0) / blockPositions.length

      blocks.push({
        blockSize,
        blockNumber: Math.floor(i / blockSize) + 1,
        profitFactor: avgProfitFactor,
        positionCount: blockPositions.length,
        avgProfit,
        startTime: new Date(blockPositions[0].created_at),
        endTime: new Date(blockPositions[blockPositions.length - 1].created_at),
      })
    }

    return blocks
  }

  // Calculate statistics for each time interval
  const timeIntervalStats: TimeIntervalStats[] = timeIntervals.map((interval) => {
    const blockSizes = [2, 4, 6, 8]
    const allBlocks: BlockStats[] = []

    blockSizes.forEach((size) => {
      const blocks = calculateBlockStats(size, interval)
      allBlocks.push(...blocks)
    })

    const avgProfitFactor =
      allBlocks.length > 0 ? allBlocks.reduce((sum, b) => sum + b.profitFactor, 0) / allBlocks.length : 0

    return {
      interval,
      blocks: allBlocks,
      avgProfitFactor,
      totalBlocks: allBlocks.length,
    }
  })

  // Calculate drawdown periods for last N positions
  const calculateDrawdownPeriods = (): DrawdownPeriod[] => {
    const recentPositions = positions
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, drawdownPositionCount)
      .reverse()

    const drawdownPeriods: DrawdownPeriod[] = []
    let currentDrawdownStart = -1
    let currentDrawdown = 0
    let maxDrawdownInPeriod = 0

    for (let i = 0; i < recentPositions.length; i++) {
      const position = recentPositions[i]
      const profit = (position.profit_factor - 1) * position.position_cost

      if (profit < 0) {
        if (currentDrawdownStart === -1) {
          currentDrawdownStart = i
          currentDrawdown = 0
          maxDrawdownInPeriod = 0
        }
        currentDrawdown += Math.abs(profit)
        maxDrawdownInPeriod = Math.max(maxDrawdownInPeriod, currentDrawdown)
      } else {
        if (currentDrawdownStart !== -1) {
          // Drawdown period ended
          const startTime = new Date(recentPositions[currentDrawdownStart].created_at)
          const endTime = new Date(recentPositions[i - 1].created_at)
          const durationHours = (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60)

          drawdownPeriods.push({
            startIndex: currentDrawdownStart,
            endIndex: i - 1,
            duration: durationHours,
            maxDrawdown: maxDrawdownInPeriod,
            positionCount: i - currentDrawdownStart,
          })

          currentDrawdownStart = -1
          currentDrawdown = 0
        }
      }
    }

    // Handle ongoing drawdown
    if (currentDrawdownStart !== -1) {
      const startTime = new Date(recentPositions[currentDrawdownStart].created_at)
      const endTime = new Date(recentPositions[recentPositions.length - 1].created_at)
      const durationHours = (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60)

      drawdownPeriods.push({
        startIndex: currentDrawdownStart,
        endIndex: recentPositions.length - 1,
        duration: durationHours,
        maxDrawdown: maxDrawdownInPeriod,
        positionCount: recentPositions.length - currentDrawdownStart,
      })
    }

    return drawdownPeriods
  }

  const drawdownPeriods = calculateDrawdownPeriods()
  const avgDrawdownDuration =
    drawdownPeriods.length > 0 ? drawdownPeriods.reduce((sum, d) => sum + d.duration, 0) / drawdownPeriods.length : 0
  const maxDrawdownDuration = drawdownPeriods.length > 0 ? Math.max(...drawdownPeriods.map((d) => d.duration)) : 0
  const totalDrawdownTime = drawdownPeriods.reduce((sum, d) => sum + d.duration, 0)

  // Prepare chart data for block profit factors
  const blockChartData = timeIntervalStats.flatMap((stat) =>
    stat.blocks
      .filter((b) => b.blockSize === 4) // Show only size 4 blocks for clarity
      .map((block) => ({
        blockNumber: `B${block.blockNumber}`,
        profitFactor: block.profitFactor,
        interval: `${stat.interval}h`,
        blockSize: block.blockSize,
      })),
  )

  // Prepare chart data for drawdown timeline
  const drawdownChartData = drawdownPeriods.map((period, index) => ({
    period: `Period ${index + 1}`,
    duration: period.duration,
    maxDrawdown: period.maxDrawdown,
    positions: period.positionCount,
  }))

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
    }).format(amount)
  }

  return (
    <div className="space-y-6">
      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="py-2 px-4">
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-blue-500" />
              <div>
                <div className="text-2xl font-bold">{positions.length}</div>
                <div className="text-sm text-muted-foreground">Total Positions</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="py-2 px-4">
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-orange-500" />
              <div>
                <div className="text-2xl font-bold">{avgDrawdownDuration.toFixed(1)}h</div>
                <div className="text-sm text-muted-foreground">Avg Drawdown Time</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="py-2 px-4">
            <div className="flex items-center gap-2">
              <TrendingDown className="h-5 w-5 text-red-500" />
              <div>
                <div className="text-2xl font-bold">{maxDrawdownDuration.toFixed(1)}h</div>
                <div className="text-sm text-muted-foreground">Max Drawdown Time</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="py-2 px-4">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-green-500" />
              <div>
                <div className="text-2xl font-bold">{drawdownPeriods.length}</div>
                <div className="text-sm text-muted-foreground">Drawdown Periods</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Block Profit Factor Analysis by Time Interval */}
      <Card>
        <CardHeader>
          <CardTitle>Block Avg R by Time Interval</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {timeIntervalStats.map((stat) => {
              const blocksBySize = [2, 4, 6, 8].map((size) => {
                const blocks = stat.blocks.filter((b) => b.blockSize === size)
                const avgPF = blocks.length > 0 ? blocks.reduce((sum, b) => sum + b.profitFactor, 0) / blocks.length : 0
                return { size, avgPF, count: blocks.length }
              })

              return (
                <Card key={stat.interval}>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-lg">{stat.interval} Hours</CardTitle>
                      <Badge variant={stat.avgProfitFactor >= 1 ? "default" : "destructive"}>
                        Avg R: {stat.blocks.length > 0 ? stat.avgProfitFactor.toFixed(2) : "—"}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {blocksBySize.map((block) => (
                        <div key={block.size} className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="text-sm font-medium">Block Size {block.size}</div>
                            <Badge variant="outline" className="text-xs">
                              {block.count} blocks
                            </Badge>
                          </div>
                          <div className="flex items-center gap-2">
                            <div
                              className={`text-sm font-bold ${block.avgPF >= 1 ? "text-green-600" : "text-red-600"}`}
                            >
                              {block.count > 0 ? block.avgPF.toFixed(2) : "—"}
                            </div>
                            {block.avgPF >= 1 ? (
                              <TrendingUp className="h-4 w-4 text-green-600" />
                            ) : (
                              <TrendingDown className="h-4 w-4 text-red-600" />
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Block Profit Factor Chart */}
      {blockChartData.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Block Avg R Trend (Block Size 4)</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={blockChartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="blockNumber" />
                <YAxis />
                <Tooltip formatter={(value: number) => [value.toFixed(2), "Avg R"]} />
                <Bar dataKey="profitFactor" fill="#3b82f6" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Drawdown Analysis */}
      <Card>
        <CardHeader>
          <CardTitle>Drawdown Time Analysis (Last {drawdownPositionCount} Positions)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4 py-2 px-4 bg-muted rounded-lg">
              <div>
                <div className="text-sm text-muted-foreground">Total Drawdown Time</div>
                <div className="text-2xl font-bold">{totalDrawdownTime.toFixed(1)}h</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Average Duration</div>
                <div className="text-2xl font-bold">{avgDrawdownDuration.toFixed(1)}h</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Max Duration</div>
                <div className="text-2xl font-bold">{maxDrawdownDuration.toFixed(1)}h</div>
              </div>
            </div>

            {drawdownChartData.length > 0 && (
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={drawdownChartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="period" />
                  <YAxis />
                  <Tooltip
                    formatter={(value: number, name: string) => {
                      if (name === "duration") return [`${value.toFixed(1)}h`, "Duration"]
                      if (name === "maxDrawdown") return [formatCurrency(value), "Max Drawdown"]
                      return [value, name]
                    }}
                  />
                  <Line type="monotone" dataKey="duration" stroke="#ef4444" strokeWidth={2} name="Duration (hours)" />
                </LineChart>
              </ResponsiveContainer>
            )}

            {/* Drawdown Periods Table */}
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted">
                  <tr>
                    <th className="p-2 text-left">Period</th>
                    <th className="p-2 text-right">Duration</th>
                    <th className="p-2 text-right">Max Drawdown</th>
                    <th className="p-2 text-right">Positions</th>
                  </tr>
                </thead>
                <tbody>
                  {drawdownPeriods.map((period, index) => (
                    <tr key={index} className="border-t">
                      <td className="p-2">Period {index + 1}</td>
                      <td className="p-2 text-right font-medium">{period.duration.toFixed(1)}h</td>
                      <td className="p-2 text-right text-red-600 font-medium">{formatCurrency(period.maxDrawdown)}</td>
                      <td className="p-2 text-right">{period.positionCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

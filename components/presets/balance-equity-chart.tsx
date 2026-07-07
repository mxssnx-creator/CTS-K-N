"use client"

import { useMemo } from "react"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts"

interface BalanceEquityChartProps {
  data: Array<{
    timestamp: string
    balance: number
    equity: number
  }>
}

export function BalanceEquityChart({ data }: BalanceEquityChartProps) {
  const chartData = useMemo(() => {
    if (!data || !Array.isArray(data)) return []

    return data.map((item) => {
      try {
        const date = new Date(item.timestamp)
        const month = date.toLocaleString("default", { month: "short" })
        const day = date.getDate()
        const hours = date.getHours().toString().padStart(2, "0")
        const minutes = date.getMinutes().toString().padStart(2, "0")

        return {
          balance: item.balance || 0,
          equity: item.equity || 0,
          timestamp: date.getTime(),
          formattedDate: `${month} ${day} ${hours}:${minutes}`,
        }
      } catch (error) {
        console.error("[v0] Error formatting chart data:", error)
        return {
          balance: 0,
          equity: 0,
          timestamp: 0,
          formattedDate: "Invalid",
        }
      }
    })
  }, [data])

  if (!data || !Array.isArray(data) || data.length === 0 || chartData.length === 0) {
    return (
      <div className="h-32 bg-muted rounded flex items-center justify-center">
        <p className="text-sm text-muted-foreground">No chart data available</p>
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis
          dataKey="formattedDate"
          tick={{ fontSize: 11 }}
          className="text-muted-foreground"
          interval="preserveStartEnd"
        />
        <YAxis tick={{ fontSize: 11 }} className="text-muted-foreground" />
        <Tooltip
          contentStyle={{
            backgroundColor: "hsl(var(--background))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "6px",
          }}
          labelStyle={{ color: "hsl(var(--foreground))" }}
        />
        <Legend wrapperStyle={{ fontSize: "12px" }} />
        <Line
          type="monotone"
          dataKey="balance"
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          dot={false}
          name="Balance"
        />
        <Line type="monotone" dataKey="equity" stroke="hsl(var(--chart-2))" strokeWidth={2} dot={false} name="Equity" />
      </LineChart>
    </ResponsiveContainer>
  )
}

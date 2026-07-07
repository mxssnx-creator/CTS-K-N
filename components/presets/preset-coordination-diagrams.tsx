"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts"
import type { PresetCoordinationResult } from "@/lib/types-preset-coordination"

interface PresetCoordinationDiagramsProps {
  results: PresetCoordinationResult[]
}

export function PresetCoordinationDiagrams({ results }: PresetCoordinationDiagramsProps) {
  // Prepare data for overall performance chart
  const overallData = results.map((result, index) => ({
    name: `Config ${index + 1}`,
    profitFactor: result.profit_factor,
    winRate: result.win_rate * 100,
    totalTrades: result.total_trades,
  }))

  // Prepare data for last 50 positions evaluation
  const last50Data = results.map((result, index) => ({
    name: `Config ${index + 1}`,
    profitFactor: result.profit_factor_last_50,
    positions: 50,
  }))

  // Prepare data for last 25 positions evaluation
  const last25Data = results.map((result, index) => ({
    name: `Config ${index + 1}`,
    profitFactor: result.profit_factor_last_25,
    positions: 25,
  }))

  return (
    <Tabs defaultValue="overall" className="w-full">
      <TabsList className="grid w-full grid-cols-3">
        <TabsTrigger value="overall">Overall Performance</TabsTrigger>
        <TabsTrigger value="last50">Last 50 Positions</TabsTrigger>
        <TabsTrigger value="last25">Last 25 Positions</TabsTrigger>
      </TabsList>

      <TabsContent value="overall" className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Profit Factor & Win Rate</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={overallData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" />
                <YAxis yAxisId="left" />
                <YAxis yAxisId="right" orientation="right" />
                <Tooltip />
                <Legend />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="profitFactor"
                  stroke="hsl(var(--chart-1))"
                  name="Profit Factor"
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="winRate"
                  stroke="hsl(var(--chart-2))"
                  name="Win Rate %"
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Total Trades per Configuration</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={overallData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" />
                <YAxis />
                <Tooltip />
                <Bar dataKey="totalTrades" fill="hsl(var(--chart-3))" name="Total Trades" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="last50">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Profit Factor - Last 50 Positions</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={last50Data}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="profitFactor" fill="hsl(var(--chart-4))" name="Profit Factor (Last 50)" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="last25">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Profit Factor - Last 25 Positions</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={last25Data}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="profitFactor" fill="hsl(var(--chart-5))" name="Profit Factor (Last 25)" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  )
}

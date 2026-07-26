"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Calculator } from "lucide-react"

export default function VolumeCalculatorWidget() {
  // Default 300 mirrors the global Settings default in
  // components/settings/utils.ts — keeps the standalone calculator
  // widget showing the same per-position size the real engine uses.
  const [positionsAverage, setPositionsAverage] = useState(300)
  const [riskPercentage, setRiskPercentage] = useState(20)
  const [maxLeverage, setMaxLeverage] = useState(125)
  const [currentPrice, setCurrentPrice] = useState(50000)
  const [accountBalance, setAccountBalance] = useState(10000)

  const [result, setResult] = useState<any>(null)

  const calculateVolume = () => {
    // The shared Base coordination ratio is immutable identity 1. Channel and
    // strategy adjustment ratios are applied later at their explicit Live
    // boundaries and are intentionally not simulated by this Base preview.
    const leverage = Math.max(1, maxLeverage)

    // Calculate risk per position
    const totalRiskAmount = accountBalance * (riskPercentage / 100)
    const riskPerPosition = totalRiskAmount / positionsAverage

    // Calculate position size
    const positionSize = riskPerPosition / (riskPercentage / 100)

    // Calculate volume
    const calculatedVolume = positionSize / (currentPrice * leverage)

    setResult({
      leverage: leverage.toFixed(2),
      riskPerPosition: riskPerPosition.toFixed(2),
      positionSize: positionSize.toFixed(2),
      volume: calculatedVolume.toFixed(6),
      positionValue: (calculatedVolume * currentPrice).toFixed(2),
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calculator className="h-5 w-5" />
          Volume Calculator
        </CardTitle>
        <CardDescription>Calculate position volume based on risk management parameters</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/40 p-3">
            <Label>Base Coordination Ratio: 1.0x</Label>
            <p className="mt-1 text-xs text-muted-foreground">
              Fixed identity basis. Main, Preset, Signal, Position-count, DCA
              and Block ratios are applied independently at their own stages.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="positions-avg">Target Positions</Label>
              <Input
                id="positions-avg"
                type="number"
                value={positionsAverage}
                onChange={(e) => setPositionsAverage(Number.parseInt(e.target.value))}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="risk-pct">Risk %</Label>
              <Input
                id="risk-pct"
                type="number"
                value={riskPercentage}
                onChange={(e) => setRiskPercentage(Number.parseInt(e.target.value))}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="max-leverage">Max Leverage</Label>
              <Input
                id="max-leverage"
                type="number"
                value={maxLeverage}
                onChange={(e) => setMaxLeverage(Number.parseInt(e.target.value))}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="current-price">Current Price</Label>
              <Input
                id="current-price"
                type="number"
                value={currentPrice}
                onChange={(e) => setCurrentPrice(Number.parseFloat(e.target.value))}
              />
            </div>

            <div className="space-y-2 col-span-2">
              <Label htmlFor="account-balance">Account Balance</Label>
              <Input
                id="account-balance"
                type="number"
                value={accountBalance}
                onChange={(e) => setAccountBalance(Number.parseFloat(e.target.value))}
              />
            </div>
          </div>

          <Button onClick={calculateVolume} className="w-full">
            Calculate Volume
          </Button>
        </div>

        {result && (
          <div className="space-y-3 border-t pt-4">
            <h4 className="font-semibold">Calculation Results</h4>

            <div className="grid grid-cols-2 gap-3">
              <div className="bg-muted p-3 rounded-lg">
                <p className="text-xs text-muted-foreground">Leverage</p>
                <p className="text-lg font-bold">{result.leverage}x</p>
              </div>

              <div className="bg-muted p-3 rounded-lg">
                <p className="text-xs text-muted-foreground">Risk per Position</p>
                <p className="text-lg font-bold">${result.riskPerPosition}</p>
              </div>

              <div className="bg-muted p-3 rounded-lg">
                <p className="text-xs text-muted-foreground">Position Size</p>
                <p className="text-lg font-bold">${result.positionSize}</p>
              </div>

              <div className="bg-muted p-3 rounded-lg">
                <p className="text-xs text-muted-foreground">Volume (Quantity)</p>
                <p className="text-lg font-bold">{result.volume}</p>
              </div>

              <div className="bg-primary/10 p-3 rounded-lg col-span-2">
                <p className="text-xs text-muted-foreground">Position Value</p>
                <p className="text-xl font-bold text-primary">${result.positionValue}</p>
              </div>
            </div>

            <div className="bg-blue-50 dark:bg-blue-950 p-3 rounded-lg text-sm">
              <p className="text-blue-800 dark:text-blue-200">
                At the fixed 1.0x Base ratio with {positionsAverage} positions,
                this preview budgets {riskPercentage}% total account risk.
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { calculateIndicationConfigurationCounts } from "@/lib/indication-configuration-counts"

interface CalculationStep {
  category: string
  step: string
  formula: string
  calculation: string
  result: number
  description: string
}

export function CalculationDemo() {
  const [currentStep, setCurrentStep] = useState(0)
  const [isCalculating, setIsCalculating] = useState(false)
  const [completedSteps, setCompletedSteps] = useState<CalculationStep[]>([])

  const indicationCounts = calculateIndicationConfigurationCounts({}, undefined)
  const typeCount = (type: string) =>
    indicationCounts.types.find((row) => row.type === type)?.possibleSets ?? 0
  const calculationSteps: CalculationStep[] = [
    {
      category: "Indications",
      step: "Default Direction Sets",
      formula: indicationCounts.types.find((row) => row.type === "direction")?.formula ?? "",
      calculation: "complete Cartesian product × Long/Short",
      result: typeCount("direction"),
      description: "Every range, drawdown, latest-window and factor tuple is an independent Set.",
    },
    {
      category: "Indications",
      step: "Default Move + Active Sets",
      formula: "Move exhaustive grid + Active exhaustive grid",
      calculation: `${typeCount("move")} + ${typeCount("active")}`,
      result: typeCount("move") + typeCount("active"),
      description: "Move and Active retain separate configuration and direction identities.",
    },
    {
      category: "Indications",
      step: "Additional Trend / Optimal / Auto",
      formula: "Trend + Optimal + Auto durable Sets",
      calculation: `${typeCount("trend")} + ${typeCount("optimal")} + ${typeCount("auto")}`,
      result: typeCount("trend") + typeCount("optimal") + typeCount("auto"),
      description: "Trend uses independent 1/5/15/30-minute situations; Auto remains a runtime coordinator.",
    },
    {
      category: "Indications",
      step: "Common Indicator Sets",
      formula: "17 indicator parameter grids × 1/5/15/30m × Long/Short",
      calculation: "all valid parameter tuples; no representative sampling",
      result: typeCount("common"),
      description: "MA, SMA, EMA, MACD, RSI, Bollinger, Stochastic, ADX/ADI, ATR, PSAR, CCI/CCX, ADL, Fibonacci, ROC, Williams %R, OBV and VWAP.",
    },
    {
      category: "Indications",
      step: "Signal Sets",
      formula: "source / consensus inputs × TP/SL/Trailing configs × Long/Short",
      calculation: "source, symbol, direction and config are independent",
      result: typeCount("signal"),
      description: "12/10 are performance lookbacks, while physical Signal capacity is separately 120.",
    },
    {
      category: "Summary",
      step: "Total Independent Indication Sets",
      formula: "sum of every enabled family",
      calculation: indicationCounts.types.map((row) => row.possibleSets).join(" + "),
      result: indicationCounts.totalPossibleSets,
      description: "No minStep, top-K, timeout or storage-retention value truncates this configuration space.",
    },
    {
      category: "Strategies",
      step: "Main Row Evaluation",
      formula: "latest N completed positions per exact Base lineage",
      calculation: "default N = 25",
      result: 25,
      description: "Main Valid is evaluated from Base; Main Overall also includes valid Pos-Count, Block and DCA descendants.",
    },
    {
      category: "Strategies",
      step: "Row-Real → Row-Live",
      formula: "latest Real N → validated Row-Real → direct Row-Live mirror",
      calculation: "default N = 20",
      result: 20,
      description: "Live does not re-evaluate a validated Real row through an accidental second PF/DDT gate.",
    },
  ]

  const runCalculation = async () => {
    setIsCalculating(true)
    setCompletedSteps([])
    setCurrentStep(0)

    for (let i = 0; i < calculationSteps.length; i++) {
      setCurrentStep(i)
      await new Promise((resolve) => setTimeout(resolve, 800)) // Simulate calculation time
      setCompletedSteps((prev) => [...prev, calculationSteps[i]])
    }

    setIsCalculating(false)
  }

  const getCategoryColor = (category: string) => {
    switch (category) {
      case "Indications":
        return "bg-blue-500"
      case "Strategies":
        return "bg-green-500"
      case "Summary":
        return "bg-purple-500"
      case "Database":
        return "bg-orange-500"
      case "Scaling":
        return "bg-red-500"
      default:
        return "bg-gray-500"
    }
  }

  const formatNumber = (num: number) => {
    return new Intl.NumberFormat().format(num)
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Set Topology &amp; DB-Capacity Calculator</CardTitle>
          <CardDescription>
            How Independent Sets are enumerated (Indications) and cascade-filtered (Strategies: Base → Main → Real),
            and what the 250 per-Set DB capacity actually represents
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4 mb-6">
            <Button onClick={runCalculation} disabled={isCalculating} className="min-w-32">
              {isCalculating ? "Calculating..." : "Run Demo"}
            </Button>
            {isCalculating && (
              <div className="flex-1">
                <Progress value={(currentStep / calculationSteps.length) * 100} className="h-2" />
                <p className="text-sm text-muted-foreground mt-1">
                  Step {currentStep + 1} of {calculationSteps.length}
                </p>
              </div>
            )}
          </div>

          <div className="space-y-4 max-h-96 overflow-y-auto">
            {completedSteps.map((step, index) => (
              <div key={index} className="flex items-center gap-4 py-2 px-4 border rounded-lg bg-muted/30">
                <Badge className={getCategoryColor(step.category)}>{step.category}</Badge>
                <div className="flex-1">
                  <div className="font-semibold">{step.step}</div>
                  <div className="text-sm text-muted-foreground">{step.description}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-sm text-muted-foreground">{step.formula}</div>
                  <div className="font-mono text-sm">{step.calculation}</div>
                  <div className="font-bold text-lg">{formatNumber(step.result)}</div>
                </div>
              </div>
            ))}

            {isCalculating && currentStep < calculationSteps.length && (
              <div className="flex items-center gap-4 py-2 px-4 border rounded-lg bg-primary/10 animate-pulse">
                <Badge className={getCategoryColor(calculationSteps[currentStep].category)}>
                  {calculationSteps[currentStep].category}
                </Badge>
                <div className="flex-1">
                  <div className="font-semibold">{calculationSteps[currentStep].step}</div>
                  <div className="text-sm text-muted-foreground">Calculating...</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-sm text-muted-foreground">{calculationSteps[currentStep].formula}</div>
                  <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full"></div>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {completedSteps.length === calculationSteps.length && (
        <Card>
          <CardHeader>
            <CardTitle>Key Insights — 250, Sets, and the Pipeline</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-3">
                <h4 className="font-semibold text-green-600">What 250 Actually Means</h4>
                <ul className="space-y-2 text-sm">
                  <li className="flex items-start gap-2">
                    <span className="w-2 h-2 bg-blue-500 rounded-full mt-2 flex-shrink-0"></span>
                    <span>
                      <strong>250 = per-Set database length (position-history capacity):</strong> Each Independent Set
                      stores up to 250 pseudo-positions. It is NOT an indication count limit, NOT a strategy count
                      limit, NOT a per-cycle throughput target.
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-2 h-2 bg-green-500 rounded-full mt-2 flex-shrink-0"></span>
                    <span>
                      <strong>Each Set is independent:</strong> Sets have their own position DB (capacity 250 by
                      default, tunable 50–750 in Settings). Sets are never pooled into a shared 250-slot cap.
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-2 h-2 bg-purple-500 rounded-full mt-2 flex-shrink-0"></span>
                    <span>
                      <strong>Strategy pipeline outputs are related, not additive:</strong> Main can materialise
                      several position-axis/variant Sets from one Base parent; Real filters and adjusts that pool.
                      The canonical final count is Real — never Base+Main+Real added together.
                    </span>
                  </li>
                </ul>
              </div>

              <div className="space-y-3">
                <h4 className="font-semibold text-orange-600">Counts vs Capacity</h4>
                <ul className="space-y-2 text-sm">
                  <li className="flex items-start gap-2">
                    <span className="w-2 h-2 bg-orange-500 rounded-full mt-2 flex-shrink-0"></span>
                    <span>
                      <strong>Indication / strategy counts</strong> live in the progression hash
                      (<code className="text-xs">indications_count</code>, <code className="text-xs">strategies_count</code>).
                      These track CYCLE OUTPUT, not DB capacity.
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-2 h-2 bg-red-500 rounded-full mt-2 flex-shrink-0"></span>
                    <span>
                      <strong>Set DB capacity (250)</strong> is a ceiling on position history per Set. Live usage is
                      usually far lower — old entries are pruned by rearrangement when PF improves.
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-2 h-2 bg-gray-500 rounded-full mt-2 flex-shrink-0"></span>
                    <span>
                      <strong>20% rearrangement:</strong> Sets automatically repack position history when 20% become
                      profitable, keeping the most informative entries within the 250 slots.
                    </span>
                  </li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

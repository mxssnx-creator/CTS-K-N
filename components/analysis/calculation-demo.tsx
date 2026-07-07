"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"

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

  const calculationSteps: CalculationStep[] = [
    {
      category: "Indications",
      step: "Direction Indication Sets",
      formula: "6 ranges × 5 price_ratios × 2 variations",
      calculation: "6 × 5 × 2",
      result: 60,
      description: "Independent Sets — each has its own position DB (capacity 250)",
    },
    {
      category: "Indications",
      step: "Direction Set DB Capacity",
      formula: "60 Sets × 250 DB slots per Set",
      calculation: "60 × 250",
      result: 15000,
      description: "Max positions STORABLE across all Direction Sets (250 = per-Set DB length, NOT an indication count limit)",
    },
    {
      category: "Indications",
      step: "Move Indication Sets",
      formula: "6 ranges × 5 price_ratios × 2 variations",
      calculation: "6 × 5 × 2",
      result: 60,
      description: "Independent Move-detection Sets",
    },
    {
      category: "Indications",
      step: "Move Set DB Capacity",
      formula: "60 Sets × 250 DB slots per Set",
      calculation: "60 × 250",
      result: 15000,
      description: "Max storable positions across all Move Sets",
    },
    {
      category: "Indications",
      step: "Active Indication Sets",
      formula: "5 thresholds × 3 time_variations",
      calculation: "5 × 3",
      result: 15,
      description: "Active trading threshold Sets",
    },
    {
      category: "Indications",
      step: "Active Set DB Capacity",
      formula: "15 Sets × 250 DB slots per Set",
      calculation: "15 × 250",
      result: 3750,
      description: "Max storable positions across all Active Sets",
    },
    {
      category: "Strategies",
      step: "Base Sets (stage 1: eval)",
      formula: "21 TP × 21 SL × 10 trailing (capped at 50)",
      calculation: "min(21 × 21 × 10, 50)",
      result: 50,
      description: "Stage 1 of the cascade filter — Base Sets enter evaluation",
    },
    {
      category: "Strategies",
      step: "Main Sets (stage 2: filter)",
      formula: "Base Sets that passed PF & drawdown filters",
      calculation: "≈ 50 → 25 (50% pass rate)",
      result: 25,
      description: "Stage 2 — same Sets, filtered. NOT added to Base — they ARE the Base survivors",
    },
    {
      category: "Strategies",
      step: "Real Sets (stage 3: adjust)",
      formula: "Main Sets that passed strict PF≥1.4 + confidence≥0.65",
      calculation: "≈ 25 → 10 (40% pass rate)",
      result: 10,
      description: "Stage 3 — final filtered output. This is the canonical strategy count",
    },
    {
      category: "Strategies",
      step: "Set DB Capacity (per Real Set)",
      formula: "10 Real Sets × 250 DB slots per Set",
      calculation: "10 × 250",
      result: 2500,
      description: "Max positions STORABLE per Real Set (250 = Independent Set DB length, per-Set capacity)",
    },
    {
      category: "Summary",
      step: "Total Independent Sets (XRPUSDT)",
      formula: "Indication Sets + Real-stage Strategy Sets",
      calculation: "(60 + 60 + 15) + 10",
      result: 145,
      description: "Sets are independent pipelines. Strategy Sets are the REAL-stage output only (Base/Main are intermediate filter stages of the same pipeline, never summed)",
    },
    {
      category: "Database",
      step: "Max Storable Positions (XRPUSDT)",
      formula: "Sum of (each Set × its 250 DB capacity)",
      calculation: "(60+60+15+10) × 250",
      result: 36250,
      description: "Theoretical DB capacity — NOT throughput, NOT indication count, NOT strategy count. 250 is the per-Set pseudo-position history length.",
    },
    {
      category: "Scaling",
      step: "10 Symbols × Max DB Capacity",
      formula: "36,250 positions × 10 symbols",
      calculation: "36250 × 10",
      result: 362500,
      description: "System-wide pseudo-position DB capacity across symbols. Actual live counts are typically far lower — 250 is a CEILING, not a target.",
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
                      <strong>Strategy pipeline is a cascade, not a sum:</strong> Base → Main → Real are evaluation,
                      filter, and adjust stages of the SAME logical strategy. The canonical &quot;total strategies&quot;
                      count is the Real-stage output only — never Base+Main+Real added together.
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

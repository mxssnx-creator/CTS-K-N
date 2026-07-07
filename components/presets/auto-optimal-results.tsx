"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { ChevronDown, ChevronRight, Save, TrendingUp } from "lucide-react"
import type { AutoOptimalResult, AutoOptimalSymbolSummary } from "@/lib/types-auto-optimal"
import { formatSampledMetric, grossProfitFactorTitle } from "@/lib/metric-formatting"

interface AutoOptimalResultsProps {
  results: AutoOptimalResult[]
  onSaveSet: (selectedResults: string[]) => void
}

export function AutoOptimalResults({ results, onSaveSet }: AutoOptimalResultsProps) {
  const [expandedSymbols, setExpandedSymbols] = useState<Set<string>>(new Set())
  const [expandedConfigs, setExpandedConfigs] = useState<Set<string>>(new Set())
  const [selectedResults, setSelectedResults] = useState<Set<string>>(new Set())

  // Group results by symbol
  const symbolSummaries: AutoOptimalSymbolSummary[] = []
  const symbolMap = new Map<string, AutoOptimalResult[]>()

  results.forEach((result) => {
    if (!symbolMap.has(result.symbol)) {
      symbolMap.set(result.symbol, [])
    }
    symbolMap.get(result.symbol)!.push(result)
  })

  symbolMap.forEach((configs, symbol) => {
    const sortedConfigs = configs.sort((a, b) => b.profit_factor - a.profit_factor)
    const best = sortedConfigs[0]

    symbolSummaries.push({
      symbol,
      total_configurations: configs.length,
      best_profit_factor: best.profit_factor,
      best_configuration_id: best.id,
      avg_positions_per_24h: configs.reduce((sum, c) => sum + c.positions_per_24h, 0) / configs.length,
      configurations: sortedConfigs,
    })
  })

  const toggleSymbol = (symbol: string) => {
    const newExpanded = new Set(expandedSymbols)
    if (newExpanded.has(symbol)) {
      newExpanded.delete(symbol)
    } else {
      newExpanded.add(symbol)
    }
    setExpandedSymbols(newExpanded)
  }

  const toggleConfig = (configId: string) => {
    const newExpanded = new Set(expandedConfigs)
    if (newExpanded.has(configId)) {
      newExpanded.delete(configId)
    } else {
      newExpanded.add(configId)
    }
    setExpandedConfigs(newExpanded)
  }

  const toggleSelection = (resultId: string) => {
    const newSelected = new Set(selectedResults)
    if (newSelected.has(resultId)) {
      newSelected.delete(resultId)
    } else {
      newSelected.add(resultId)
    }
    setSelectedResults(newSelected)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Optimal Configurations</h2>
        <Button onClick={() => onSaveSet(Array.from(selectedResults))} disabled={selectedResults.size === 0}>
          <Save className="h-4 w-4 mr-2" />
          Save Set ({selectedResults.size})
        </Button>
      </div>

      <div className="space-y-2">
        {symbolSummaries.map((summary) => (
          <div key={summary.symbol} className="border rounded-lg overflow-hidden">
            {/* Symbol Summary Bar */}
            <div
              className="flex items-center justify-between p-4 bg-muted/50 cursor-pointer hover:bg-muted"
              onClick={() => toggleSymbol(summary.symbol)}
            >
              <div className="flex items-center gap-4 flex-1">
                {expandedSymbols.has(summary.symbol) ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
                <div className="font-semibold">{summary.symbol}</div>
                <Badge variant="outline">{summary.total_configurations} configs</Badge>
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-green-500" />
                  <span className="text-sm">PF: {formatSampledMetric(summary.best_profit_factor, summary.total_configurations)}</span>
                </div>
                <div className="text-sm text-muted-foreground">{summary.avg_positions_per_24h.toFixed(1)} pos/24h</div>
              </div>
            </div>

            {/* Expanded Symbol Configurations */}
            {expandedSymbols.has(summary.symbol) && (
              <div className="p-2 space-y-1">
                {summary.configurations.map((config) => (
                  <div key={config.id} className="border rounded overflow-hidden">
                    {/* Configuration Bar */}
                    <div
                      className="flex items-center justify-between p-3 bg-background cursor-pointer hover:bg-muted/30"
                      onClick={() => toggleConfig(config.id)}
                    >
                      <div className="flex items-center gap-3 flex-1">
                        {expandedConfigs.has(config.id) ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                        <input
                          type="checkbox"
                          checked={selectedResults.has(config.id)}
                          onChange={(e) => {
                            e.stopPropagation()
                            toggleSelection(config.id)
                          }}
                          className="rounded"
                        />
                        <div className="text-sm font-medium">
                          {config.indication_type || "No Indication"} | TP: {config.takeprofit.toFixed(1)}% | SL:{" "}
                          {config.stoploss.toFixed(1)}%
                        </div>
                        <Badge variant={config.profit_factor >= 1.5 ? "default" : "secondary"}>
                          PF: {formatSampledMetric(config.profit_factor, config.total_trades)}
                        </Badge>
                        <div className="text-xs text-muted-foreground">
                          {config.total_trades} trades | {config.positions_per_24h.toFixed(1)}/24h
                        </div>
                      </div>
                    </div>

                    {/* Expanded Configuration Details */}
                    {expandedConfigs.has(config.id) && (
                      <div className="p-4 bg-muted/20 space-y-4">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                          <div>
                            <div className="text-xs text-muted-foreground">PF</div>
                            <div className="text-lg font-semibold" title={grossProfitFactorTitle(config.profit_factor, config.total_trades)}>{formatSampledMetric(config.profit_factor, config.total_trades)}</div>
                            <div className="text-xs">
                              Last 8: {formatSampledMetric(config.profit_factor_last_8, Math.min(config.total_trades, 8))} | 25:{" "}
                              {formatSampledMetric(config.profit_factor_last_25, Math.min(config.total_trades, 25))} | 50: {formatSampledMetric(config.profit_factor_last_50, Math.min(config.total_trades, 50))}
                            </div>
                          </div>
                          <div>
                            <div className="text-xs text-muted-foreground">Win Rate</div>
                            <div className="text-lg font-semibold">{(config.win_rate * 100).toFixed(1)}%</div>
                            <Progress value={config.win_rate * 100} className="h-2 mt-1" />
                          </div>
                          <div>
                            <div className="text-xs text-muted-foreground">Drawdown Time</div>
                            <div className="text-lg font-semibold">{config.max_drawdown_time_hours.toFixed(1)}h</div>
                          </div>
                          <div>
                            <div className="text-xs text-muted-foreground">Avg Profit/Loss</div>
                            <div className="text-sm">
                              <span className="text-green-500">+{config.avg_profit.toFixed(2)}%</span> /{" "}
                              <span className="text-red-500">{config.avg_loss.toFixed(2)}%</span>
                            </div>
                          </div>
                        </div>

                        {config.indication_params && (
                          <div>
                            <div className="text-xs text-muted-foreground mb-2">Indication Parameters</div>
                            <div className="flex flex-wrap gap-2">
                              {Object.entries(config.indication_params).map(([key, value]) => (
                                <Badge key={key} variant="outline">
                                  {key}: {value}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}

                        {(config.uses_block || config.uses_dca) && (
                          <div>
                            <div className="text-xs text-muted-foreground mb-2">Additional Strategies</div>
                            <div className="flex gap-2">
                              {config.uses_block && <Badge>Block</Badge>}
                              {config.uses_dca && <Badge>DCA</Badge>}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Loader2, Play } from "lucide-react"
import { getIndicatorDefaults } from "@/lib/indication-range-calculator"
import type { AutoOptimalConfiguration } from "@/lib/types-auto-optimal"

interface AutoOptimalConfigurationProps {
  onCalculate: (config: Partial<AutoOptimalConfiguration>) => Promise<void>
}

export function AutoOptimalConfigurationForm({ onCalculate }: AutoOptimalConfigurationProps) {
  const [isCalculating, setIsCalculating] = useState(false)
  const [config, setConfig] = useState<Partial<AutoOptimalConfiguration>>({
    symbol_mode: "main",
    exchange_order_by: "price_change_24h",
    symbol_limit: 5,
    forced_symbols: ["XAGUSD", "XAUUSD"], // Silver and Gold
    indication_type: null,
    takeprofit_min: 0.5,
    takeprofit_max: 3.0,
    stoploss_min: 0.3,
    stoploss_max: 1.5,
    // Trailing on by default — see preset-type-dialog for the rationale.
    trailing_enabled: true,
    trailing_only: false,
    min_profit_factor: 1.0,
    min_profit_factor_positions: 25,
    max_drawdown_time_hours: 10,
    use_block: false,
    use_dca: false,
    additional_strategies_only: false,
    calculation_days: 3,
    max_positions_per_direction: 3,
    max_positions_per_symbol: 3,
  })

  const [indicationRanges, setIndicationRanges] = useState<Record<string, { min: number; max: number; step: number }>>(
    {},
  )

  const handleIndicationTypeChange = (type: string) => {
    if (type === "none") {
      setConfig({ ...config, indication_type: null, indication_params: undefined })
      setIndicationRanges({})
    } else {
      const defaults = getIndicatorDefaults(type)
      const ranges: Record<string, { min: number; max: number; step: number }> = {}

      Object.entries(defaults).forEach(([key, range]) => {
        ranges[key] = { min: range.min, max: range.max, step: range.step }
      })

      setConfig({ ...config, indication_type: type, indication_params: ranges })
      setIndicationRanges(ranges)
    }
  }

  const handleRangeChange = (param: string, field: "min" | "max" | "step", value: number) => {
    setIndicationRanges({
      ...indicationRanges,
      [param]: {
        ...indicationRanges[param],
        [field]: value,
      },
    })
    setConfig({
      ...config,
      indication_params: {
        ...config.indication_params,
        [param]: {
          ...indicationRanges[param],
          [field]: value,
        },
      },
    })
  }

  const handleCalculate = async () => {
    setIsCalculating(true)
    try {
      await onCalculate(config)
    } finally {
      setIsCalculating(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Auto Optimal Configuration</CardTitle>
        <CardDescription>Configure parameters for automatic optimal strategy calculation</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Symbol Selection */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold">Symbol Selection</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Symbol Mode</Label>
              <Select value={config.symbol_mode} onValueChange={(v) => setConfig({ ...config, symbol_mode: v as any })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="main">Main Symbols</SelectItem>
                  <SelectItem value="exchange">Exchange Based</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {config.symbol_mode === "exchange" && (
              <div className="space-y-2">
                <Label>Order By</Label>
                <Select
                  value={config.exchange_order_by}
                  onValueChange={(v) => setConfig({ ...config, exchange_order_by: v as any })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="price_change_24h">Price Change 24h</SelectItem>
                    <SelectItem value="volume_24h">Volume 24h</SelectItem>
                    <SelectItem value="market_cap">Market Cap</SelectItem>
                    <SelectItem value="volatility">Volatility</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-2">
              <Label>Symbol Limit: {config.symbol_limit}</Label>
              <Slider
                value={[config.symbol_limit || 5]}
                onValueChange={([v]) => setConfig({ ...config, symbol_limit: v })}
                min={1}
                max={25}
                step={1}
              />
            </div>
          </div>

          {/* Forced Symbols Display */}
          <div className="p-3 bg-muted rounded-lg">
            <Label className="text-sm font-medium">Forced Symbols (Always Included)</Label>
            <div className="flex gap-2 mt-2">
              {config.forced_symbols?.map((symbol) => (
                <div key={symbol} className="px-3 py-1 bg-primary/10 text-primary rounded-md text-sm font-medium">
                  {symbol}
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Silver (XAGUSD) and Gold (XAUUSD) are always included in calculations
            </p>
          </div>
        </div>

        {/* Indication Selection */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold">Common Indication</h3>
          <div className="space-y-2">
            <Label>Indication Type</Label>
            <Select value={config.indication_type || "none"} onValueChange={handleIndicationTypeChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Without Indication (Market Changes)</SelectItem>
                <SelectItem value="rsi">RSI</SelectItem>
                <SelectItem value="macd">MACD</SelectItem>
                <SelectItem value="bollinger">Bollinger Bands</SelectItem>
                <SelectItem value="ema">EMA</SelectItem>
                <SelectItem value="sma">SMA</SelectItem>
                <SelectItem value="stochastic">Stochastic</SelectItem>
                <SelectItem value="adx">ADX</SelectItem>
                <SelectItem value="sar">Parabolic SAR</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {config.indication_type && Object.keys(indicationRanges).length > 0 && (
            <div className="space-y-4 p-4 border rounded-lg">
              <h4 className="font-medium">Indication Parameter Ranges</h4>
              {Object.entries(indicationRanges).map(([param, range]) => (
                <div key={param} className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label className="text-xs capitalize">{param} Min</Label>
                    <Input
                      type="number"
                      value={range.min}
                      onChange={(e) => handleRangeChange(param, "min", Number.parseFloat(e.target.value))}
                      step={range.step}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs capitalize">{param} Max</Label>
                    <Input
                      type="number"
                      value={range.max}
                      onChange={(e) => handleRangeChange(param, "max", Number.parseFloat(e.target.value))}
                      step={range.step}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs capitalize">{param} Step</Label>
                    <Input
                      type="number"
                      value={range.step}
                      onChange={(e) => handleRangeChange(param, "step", Number.parseFloat(e.target.value))}
                      step={0.01}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Position Ranges */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold">Position Ranges</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Take Profit Min (%)</Label>
              <Input
                type="number"
                value={config.takeprofit_min}
                onChange={(e) => setConfig({ ...config, takeprofit_min: Number.parseFloat(e.target.value) })}
                step={0.1}
              />
            </div>
            <div className="space-y-2">
              <Label>Take Profit Max (%)</Label>
              <Input
                type="number"
                value={config.takeprofit_max}
                onChange={(e) => setConfig({ ...config, takeprofit_max: Number.parseFloat(e.target.value) })}
                step={0.1}
              />
            </div>
            <div className="space-y-2">
              <Label>Stop Loss Min (%)</Label>
              <Input
                type="number"
                value={config.stoploss_min}
                onChange={(e) => setConfig({ ...config, stoploss_min: Number.parseFloat(e.target.value) })}
                step={0.1}
              />
            </div>
            <div className="space-y-2">
              <Label>Stop Loss Max (%)</Label>
              <Input
                type="number"
                value={config.stoploss_max}
                onChange={(e) => setConfig({ ...config, stoploss_max: Number.parseFloat(e.target.value) })}
                step={0.1}
              />
            </div>
          </div>
        </div>

        {/* Performance Filters */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold">Performance Filters</h3>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Minimal Profit Factor: {config.min_profit_factor?.toFixed(1)}</Label>
              <Slider
                value={[config.min_profit_factor || 1.0]}
                onValueChange={([v]) => setConfig({ ...config, min_profit_factor: v })}
                min={0.5}
                max={3.5}
                step={0.1}
              />
            </div>
            <div className="space-y-2">
              <Label>Positions for Profit Factor: {config.min_profit_factor_positions}</Label>
              <Slider
                value={[config.min_profit_factor_positions || 25]}
                onValueChange={([v]) => setConfig({ ...config, min_profit_factor_positions: v })}
                min={10}
                max={60}
                step={1}
              />
            </div>
            <div className="space-y-2">
              <Label>Max Drawdown Time (hours): {config.max_drawdown_time_hours}</Label>
              <Slider
                value={[config.max_drawdown_time_hours || 10]}
                onValueChange={([v]) => setConfig({ ...config, max_drawdown_time_hours: v })}
                min={2}
                max={20}
                step={1}
              />
            </div>
          </div>
        </div>

        {/* Additional Category - Trailing Options */}
        <div className="space-y-4 p-4 border-l-4 border-purple-500 bg-purple-500/5 rounded-r">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-purple-700 dark:text-purple-300">Additional (Enhancement)</h3>
          </div>
          <p className="text-sm text-muted-foreground">Trailing stop enhancement strategies for profit protection</p>
          <div className="flex items-center justify-between">
            <Label>Enable Trailing</Label>
            <Switch
              checked={config.trailing_enabled}
              onCheckedChange={(v) => setConfig({ ...config, trailing_enabled: v })}
            />
          </div>
          <div className="flex items-center justify-between">
            <Label>Trailing Only</Label>
            <Switch
              checked={config.trailing_only}
              onCheckedChange={(v) => setConfig({ ...config, trailing_only: v })}
            />
          </div>
        </div>

        {/* Adjust Category - Block & DCA Strategies */}
        <div className="space-y-4 p-4 border-l-4 border-blue-500 bg-blue-500/5 rounded-r">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-blue-700 dark:text-blue-300">Adjust (Volume/Position)</h3>
          </div>
          <p className="text-sm text-muted-foreground">Volume and position adjustment strategies</p>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Use Block Strategy</Label>
              <Switch checked={config.use_block} onCheckedChange={(v) => setConfig({ ...config, use_block: v })} />
            </div>
            <div className="flex items-center justify-between">
              <Label>Use DCA Strategy</Label>
              <Switch checked={config.use_dca} onCheckedChange={(v) => setConfig({ ...config, use_dca: v })} />
            </div>
            <div className="flex items-center justify-between">
              <Label>Adjust Strategies Only</Label>
              <Switch
                checked={config.additional_strategies_only}
                onCheckedChange={(v) => setConfig({ ...config, additional_strategies_only: v })}
              />
            </div>
          </div>
        </div>

        {/* Calculate Button */}
        <Button onClick={handleCalculate} disabled={isCalculating} className="w-full" size="lg">
          {isCalculating ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Calculating...
            </>
          ) : (
            <>
              <Play className="h-4 w-4 mr-2" />
              Calculate Optimal Configurations
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  )
}

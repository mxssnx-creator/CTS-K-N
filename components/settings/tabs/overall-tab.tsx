"use client"

import { DEFAULT_VOLUME_STEP_RATIO } from "@/lib/constants"

// Settings Overall Tab - manages main configuration, connections, install, logs
import { useState } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { Plus, Settings as SettingsIcon, RefreshCw, Download, Upload, X } from "lucide-react"
import type { ExchangeConnection } from "@/lib/types"
import type { Settings as AppSettings } from "@/lib/file-storage"
import ExchangeConnectionManager from "@/components/settings/exchange-connection-manager"
import InstallManager from "@/components/settings/install-manager"
import { LogsViewer } from "@/components/settings/logs-viewer"
import { StatisticsOverview } from "@/components/settings/statistics-overview"
import { SettingsEditorDialog } from "@/components/settings/settings-editor-dialog"

interface OverallTabProps {
  settings: AppSettings
  handleSettingChange: (key: keyof AppSettings, value: any) => void
  addMainSymbol: () => void
  removeMainSymbol: (symbol: string) => void
  addForcedSymbol: () => void
  removeForcedSymbol: (symbol: string) => void
  newMainSymbol: string
  setNewMainSymbol: (value: string) => void
  exportSettings: () => void
  importSettings: () => void
  exporting: boolean
  importing: boolean
  newForcedSymbol: string
  setNewForcedSymbol: (value: string) => void
  connections: ExchangeConnection[]
}

export function OverallTab({
  settings,
  handleSettingChange,
  addMainSymbol,
  removeMainSymbol,
  addForcedSymbol,
  removeForcedSymbol,
  newMainSymbol,
  setNewMainSymbol,
  newForcedSymbol,
  setNewForcedSymbol,
  connections,
  exportSettings,
  importSettings,
  exporting,
  importing,
}: OverallTabProps) {
  const [overallSubTab, setOverallSubTab] = useState("main")
  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false)

  return (
    <TabsContent value="overall" className="space-y-6 animate-in fade-in duration-300">
      <Tabs value={overallSubTab} onValueChange={setOverallSubTab}>
        <TabsList className="grid grid-cols-5 w-full bg-muted/50 p-1">
          <TabsTrigger value="main" className="settings-tab-trigger">Main</TabsTrigger>
          <TabsTrigger value="connection" className="settings-tab-trigger">Connection</TabsTrigger>
          <TabsTrigger value="monitoring" className="settings-tab-trigger">Monitoring</TabsTrigger>
          <TabsTrigger value="install" className="settings-tab-trigger">Install</TabsTrigger>
          <TabsTrigger value="backup" className="settings-tab-trigger">Backup</TabsTrigger>
        </TabsList>

        <TabsContent value="main" className="space-y-6 mt-6">
          <Card className="settings-card border-2">
            <CardHeader className="settings-card-header">
              <CardTitle className="text-2xl flex items-center gap-2">
                Main Configuration
              </CardTitle>
              <CardDescription className="text-base">Core trading parameters and symbol selection</CardDescription>
            </CardHeader>
            <CardContent className="space-y-8 p-6">
              <div className="settings-section">
                <h3 className="text-xl font-bold text-foreground">Data & Timeframe Configuration</h3>
                <p className="settings-description mt-2">
                  Configure historical data retrieval and market timeframes
                </p>

                <div className="grid md:grid-cols-2 gap-6">
                  {/*
                    Prehistoric range in HOURS (1-50, step 1, default 8).
                    Stored under app_settings.prehistoric_range_hours and read
                    by lib/trade-engine/engine-manager.ts → loadPrehistoricData.
                    Replaces the legacy days slider (1-15 days, default 5).
                  */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Hours of Prehistoric Data</Label>
                      <span className="text-sm font-medium">{settings.prehistoric_range_hours ?? 8} h</span>
                    </div>
                    <Slider
                      min={1}
                      max={50}
                      step={1}
                      value={[settings.prehistoric_range_hours ?? 8]}
                      onValueChange={([value]) => handleSettingChange("prehistoric_range_hours", value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Historical candle range loaded on engine start (1-50 hours, default 8)
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label>Market Timeframe</Label>
                    <Select
                      value={String(settings.marketTimeframe || 1)}
                      onValueChange={(value) => handleSettingChange("marketTimeframe", Number.parseInt(value))}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select timeframe" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">1 second</SelectItem>
                        <SelectItem value="5">5 seconds</SelectItem>
                        <SelectItem value="15">15 seconds</SelectItem>
                        <SelectItem value="30">30 seconds</SelectItem>
                        <SelectItem value="60">1 minute</SelectItem>
                        <SelectItem value="300">5 minutes</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">Market data update interval</p>
                  </div>
                </div>
              </div>

              <Separator className="settings-divider my-8" />

              <div className="settings-section">
                <h3 className="text-xl font-bold text-foreground">Volume Configuration</h3>
                <p className="settings-description mt-2">
                  Trade-engine volume factors and position calculation settings.
                  Strategy / pseudo positions are RATIO-based (count-driven, no
                  volume); only Live Positions on real exchange orders use these
                  factors as a notional multiplier — Main and Preset engines are
                  scaled independently.
                </p>

                <div className="grid md:grid-cols-2 gap-6">
                  {/*
                   * ── Trade-Engine Volume Factors ─────────────────────────
                   *
                   * Per spec: "at Strategies, pseudo pos use ratios for
                   * volume calcs; for Live Positions calculate indeed volume
                   * with specific ratios. At settings dialog remove volume
                   * slider for Strategies — use sliders for Trade Engines:
                   * Main, Preset."
                   *
                   * The previous single `base_volume_factor` slider was
                   * applied universally and conflated Strategy ratios with
                   * Live notional — it was misleading and is therefore gone.
                   * These two replace it: each sets the GLOBAL default
                   * volume multiplier for one Trade Engine, and the dashboard
                   * connection card may override on a per-connection basis.
                   *
                   * Wired into `lib/volume-calculator.ts` via
                   * `VolumeCalculator.resolveLiveEngine` → applied ONLY in
                   * the live-execution `positionCost` branch (Strategy
                   * pseudo-position calls leave `tradeMode` undefined, so
                   * they always see a 1.0 multiplier).
                   */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Main Trade Engine Volume Factor</Label>
                      <span className="text-sm font-medium">
                        {(settings.mainTradeVolumeFactor ?? 1).toFixed(1)}x
                      </span>
                    </div>
                    <Slider
                      min={1}
                      max={10}
                      step={0.1}
                      value={[settings.mainTradeVolumeFactor ?? 1]}
                      onValueChange={([value]) =>
                        handleSettingChange("mainTradeVolumeFactor", value)
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      Live notional multiplier for the Main Trade Engine
                      (default 1.0x). Overridable per-connection from the
                      dashboard. Ratio 1 is one exchange-minimum order; range 1–10x.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Preset Trade Engine Volume Factor</Label>
                      <span className="text-sm font-medium">
                        {(settings.presetTradeVolumeFactor ?? 1).toFixed(1)}x
                      </span>
                    </div>
                    <Slider
                      min={1}
                      max={10}
                      step={0.1}
                      value={[settings.presetTradeVolumeFactor ?? 1]}
                      onValueChange={([value]) =>
                        handleSettingChange("presetTradeVolumeFactor", value)
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      Live notional multiplier for the Preset Trade Engine
                      (default 1.0x). Overridable per-connection from the
                      dashboard. Ratio 1 is one exchange-minimum order; range 1–10x.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Volume Step Ratio</Label>
                      <span className="text-sm font-medium">
                        {(settings.volume_step_ratio ?? DEFAULT_VOLUME_STEP_RATIO).toFixed(1)}× balance
                      </span>
                    </div>
                    <Slider
                      min={0.2}
                      max={1.8}
                      step={0.2}
                      value={[settings.volume_step_ratio ?? DEFAULT_VOLUME_STEP_RATIO]}
                      onValueChange={([value]) => handleSettingChange("volume_step_ratio", value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Recalculate order sizing only after balance rises by this ratio. Example: 100 USDT with 0.6 recalculates at 160 USDT; drawdowns reset immediately.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Range Percentage (Loss Trigger)</Label>
                      <span className="text-sm font-medium">{settings.negativeChangePercent || 20}%</span>
                    </div>
                    <Slider
                      min={5}
                      max={30}
                      step={5}
                      value={[settings.negativeChangePercent || 20]}
                      onValueChange={([value]) => {
                        handleSettingChange("negativeChangePercent", value)
                        handleSettingChange("risk_percentage" as any, value)
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      Market price change % to trigger loss calculation (5-30%)
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Positions Average</Label>
                      <span className="text-sm font-medium">{settings.positions_average || 300}</span>
                    </div>
                    <Slider
                      min={20}
                      max={300}
                      step={10}
                      value={[settings.positions_average || 300]}
                      onValueChange={([value]) => handleSettingChange("positions_average", value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Target positions count for volume averaging calculation (20-300)
                    </p>
                  </div>

                  <div className="flex items-center justify-between p-3 border rounded-lg">
                    <div>
                      <Label>Minimum Volume Enforcement</Label>
                      <p className="text-xs text-muted-foreground">
                        Require minimum trading volume for positions
                      </p>
                    </div>
                    <Switch
                      checked={settings.min_volume_enforcement !== false}
                      onCheckedChange={(checked) => handleSettingChange("min_volume_enforcement", checked)}
                    />
                  </div>

                  <div className="flex items-start justify-between gap-4 p-3 border rounded-lg bg-amber-500/5 border-amber-500/30">
                    <div className="flex-1 min-w-0">
                      <Label>Live Trade Without Control Orders (System Close)</Label>
                      <p className="text-xs text-muted-foreground mt-1">
                        Do <strong>not</strong> place reduce-only Stop-Loss / Take-Profit orders on the exchange.
                        The engine monitors <code className="text-[10px] px-1 rounded bg-muted">markPrice</code> every
                        reconcile and sync cycle and force-closes via a single market order when the SL/TP band is crossed.
                        Any existing exchange SL/TP control orders on open positions are swept on the next cycle.
                      </p>
                      <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1.5">
                        Live progress check is wired into every ongoing cycle — every close is verified post-fill.
                      </p>
                    </div>
                    <Switch
                      checked={(settings as any).useSystemCloseOnly === true}
                      onCheckedChange={(checked) => handleSettingChange("useSystemCloseOnly" as any, checked)}
                    />
                  </div>
                </div>
              </div>

              <Separator />

              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Position Configuration</h3>
                <p className="text-sm text-muted-foreground">
                  Position cost as ratio/percentage used for pseudo position calculations (Base/Main/Real levels).
                  Volume is calculated ONLY at Exchange level when orders are executed. This value is
                  account-balance independent.
                </p>

                <div className="space-y-2">
                  <Label>Position Cost Percentage (0.02% - 1.0%)</Label>
                  <div className="flex items-center gap-4">
                    <Slider
                      min={0.02}
                      max={1.0}
                      step={0.01}
                      value={[settings.exchangePositionCost ?? settings.positionCost ?? 0.1]}
                      onValueChange={([value]) => {
                        handleSettingChange("exchangePositionCost", value)
                        handleSettingChange("positionCost", value)
                      }}
                      className="flex-1"
                    />
                    <span className="text-sm font-medium w-16 text-right">
                      {(settings.exchangePositionCost ?? settings.positionCost ?? 0.1).toFixed(2)}%
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Position cost ratio used for Base/Main/Real pseudo position calculations (count-based, no
                    volume). Volume is calculated at Exchange level: volume = (accountBalance × positionCost) /
                    (entryPrice × leverage). Range: 0.02% - 1.0%, Default: 0.10%
                  </p>
                </div>
              </div>

              <Separator />

              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Leverage Configuration</h3>
                <p className="text-sm text-muted-foreground">Configure leverage settings and limits</p>

                <div className="grid md:grid-cols-2 gap-6">
                  {/* Leverage % — active only when Use Maximal Leverage is off */}
                  <div className={`space-y-2 ${settings.useMaximalLeverage !== false ? "opacity-50 pointer-events-none" : ""}`}>
                    <div className="flex items-center justify-between">
                      <Label>Leverage %</Label>
                      <span className="text-sm font-medium">
                        {settings.useMaximalLeverage !== false
                          ? "Max (overridden)"
                          : `${settings.leveragePercentage ?? 100}%`}
                      </span>
                    </div>
                    <Slider
                      min={5}
                      max={100}
                      step={5}
                      value={[Number(settings.leveragePercentage ?? 100)]}
                      onValueChange={([v]) => handleSettingChange("leveragePercentage", v)}
                      disabled={settings.useMaximalLeverage !== false}
                    />
                    <p className="text-xs text-muted-foreground">
                      Fraction of exchange max leverage to use. Only active when Use Maximal Leverage is off.
                    </p>
                  </div>

                  {/* Max Leverage display — resolved per exchange at order time */}
                  <div className="space-y-2 opacity-60 pointer-events-none">
                    <div className="flex items-center justify-between">
                      <Label>Max Leverage</Label>
                      <span className="text-sm font-medium">{settings.max_leverage || 125}x</span>
                    </div>
                    <Slider
                      min={1}
                      max={200}
                      step={1}
                      value={[Number(settings.max_leverage ?? 125)]}
                      disabled
                    />
                    <p className="text-xs text-muted-foreground">
                      Exchange predefinition maximum — resolved at order time, not editable here.
                    </p>
                  </div>

                  {/* Use Maximal Leverage toggle */}
                  <div className="flex items-center justify-between p-3 border rounded-lg md:col-span-2">
                    <div>
                      <Label>Use Maximal Leverage</Label>
                      <p className="text-xs text-muted-foreground">
                        When on, the engine always uses the exchange&apos;s maximum leverage.
                        Turn off to apply Leverage % instead.
                      </p>
                    </div>
                    <Switch
                      checked={settings.useMaximalLeverage !== false}
                      onCheckedChange={(v) => handleSettingChange("useMaximalLeverage", v)}
                    />
                  </div>
                </div>
              </div>

              <Separator />

              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Symbol Configuration</h3>
                <p className="text-sm text-muted-foreground">
                  Configure symbol selection and ordering from exchanges
                </p>

                <div className="grid md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label>Symbol Order Type</Label>
                    <Select
                      value={settings.symbolOrderType || "volume24h"}
                      onValueChange={(value) => handleSettingChange("symbolOrderType", value)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="volume24h">24h Volume (Highest First)</SelectItem>
                        <SelectItem value="marketCap">Market Cap (Largest First)</SelectItem>
                        <SelectItem value="priceChange24h">24h Price Change</SelectItem>
                        <SelectItem value="volatility">Volatility (Most Volatile)</SelectItem>
                        <SelectItem value="trades24h">24h Trades (Most Active)</SelectItem>
                        <SelectItem value="alphabetical">Alphabetical (A-Z)</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">Order symbols retrieved from exchange</p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Number of Symbols</Label>
                      <span className="text-sm font-medium">{settings.numberOfSymbolsToSelect || 8}</span>
                    </div>
                    <Slider
                      min={2}
                      max={30}
                      step={1}
                      value={[settings.numberOfSymbolsToSelect || 8]}
                      onValueChange={([value]) => handleSettingChange("numberOfSymbolsToSelect", value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Count of symbols to retrieve from exchange (2-30)
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label>Quote Asset</Label>
                    <Select
                      value={settings.quoteAsset || "USDT"}
                      onValueChange={(value) => handleSettingChange("quoteAsset", value)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="USDT">USDT</SelectItem>
                        <SelectItem value="USDC">USDC</SelectItem>
                        <SelectItem value="BUSD">BUSD</SelectItem>
                        <SelectItem value="BTC">BTC</SelectItem>
                        <SelectItem value="ETH">ETH</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">Quote currency for trading pairs</p>
                  </div>

                  <div className="flex items-center justify-between p-3 border rounded-lg">
                    <div>
                      <Label>Use Main Symbols Only</Label>
                      <p className="text-xs text-muted-foreground">
                        Trade only configured main symbols instead of exchange retrieval
                      </p>
                    </div>
                    <Switch
                      id="useMainSymbols"
                      checked={settings.useMainSymbols || false}
                      onCheckedChange={(checked) => handleSettingChange("useMainSymbols", checked)}
                    />
                  </div>
                </div>

                {/* Main Symbols Configuration */}
                <div className="space-y-3 p-4 border rounded-lg bg-muted/30">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-base">Main Symbols</Label>
                      <p className="text-xs text-muted-foreground">
                        Primary trading symbols - used when {"Use Main Symbols Only"} is enabled
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(settings.mainSymbols || ["BTC", "ETH", "BNB", "XRP", "ADA", "SOL"]).map((symbol: string) => (
                      <Badge key={symbol} variant="secondary" className="flex items-center gap-1 px-3 py-1">
                        {symbol}
                        <button onClick={() => removeMainSymbol(symbol)} className="ml-1 hover:text-destructive" type="button">
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Add symbol (e.g., DOGE)"
                      value={newMainSymbol}
                      onChange={(e) => setNewMainSymbol(e.target.value.toUpperCase())}
                      onKeyDown={(e) => e.key === "Enter" && addMainSymbol()}
                      className="max-w-[200px]"
                    />
                    <Button variant="outline" size="sm" onClick={addMainSymbol}>
                      <Plus className="h-4 w-4 mr-1" />
                      Add
                    </Button>
                  </div>
                </div>

                {/* Forced Symbols Configuration */}
                <div className="space-y-3 p-4 border rounded-lg bg-muted/30">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-base">Forced Symbols</Label>
                      <p className="text-xs text-muted-foreground">
                        Symbols always included in trading regardless of other settings
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(settings.forcedSymbols || ["XRP", "BCH"]).map((symbol: string) => (
                      <Badge key={symbol} variant="default" className="flex items-center gap-1 px-3 py-1">
                        {symbol}
                        <button
                          onClick={() => removeForcedSymbol(symbol)}
                          className="ml-1 hover:text-destructive"
                          type="button"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Add symbol (e.g., MATIC)"
                      value={newForcedSymbol}
                      onChange={(e) => setNewForcedSymbol(e.target.value.toUpperCase())}
                      onKeyDown={(e) => e.key === "Enter" && addForcedSymbol()}
                      className="max-w-[200px]"
                    />
                    <Button variant="outline" size="sm" onClick={addForcedSymbol}>
                      <Plus className="h-4 w-4 mr-1" />
                      Add
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="connection" className="space-y-6">
          <div className="grid md:grid-cols-2 gap-4">
            {/* Settings Editor Card */}
            <Card className="settings-card border-2 hover:border-primary/50 transition-colors cursor-pointer"
              onClick={() => setIsSettingsDialogOpen(true)}>
              <CardHeader className="settings-card-header">
                <div className="flex items-center gap-2">
                  <SettingsIcon className="w-5 h-5 text-primary" />
                  <CardTitle>Edit Settings</CardTitle>
                </div>
                <CardDescription>Manage core trading and system parameters</CardDescription>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                <p>Click to open settings editor with organized sections for:</p>
                <ul className="list-disc list-inside mt-2 space-y-1">
                  <li>Core Engine Configuration</li>
                  <li>Data & Historical Settings</li>
                  <li>Trade Engine Parameters</li>
                  <li>System & UI Options</li>
                </ul>
              </CardContent>
            </Card>

            {/* Connection Manager Card */}
            <Card className="settings-card border-2">
              <CardHeader className="settings-card-header">
                <CardTitle>Base Connections</CardTitle>
                <CardDescription>Configure and manage base exchange API connections</CardDescription>
              </CardHeader>
              <CardContent>
                <Button 
                  variant="outline" 
                  className="w-full"
                  onClick={() => document.dispatchEvent(new CustomEvent('open-add-connection'))}
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Add New Connection
                </Button>
              </CardContent>
            </Card>
          </div>

          {/* Exchange Connection Manager */}
          <ExchangeConnectionManager />

          {/* API Rate Limiting Settings */}
          <Card className="settings-card border-2">
            <CardHeader className="settings-card-header">
              <CardTitle>API Rate Limiting</CardTitle>
              <CardDescription>Configure request delays to respect exchange rate limits</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="bg-blue-50 border border-blue-200 rounded p-3 text-sm">
                <p className="text-blue-900">
                  Rate limiting ensures all API requests to exchanges comply with their rate limits. Set minimum delays between requests to avoid getting blocked.
                </p>
              </div>

              <div className="grid md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>REST API Request Delay</Label>
                    <span className="text-sm font-medium">{settings.restApiDelayMs || 50}ms</span>
                  </div>
                  <Slider
                    min={10}
                    max={500}
                    step={10}
                    value={[settings.restApiDelayMs || 50]}
                    onValueChange={([value]) => handleSettingChange("restApiDelayMs", value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Minimum delay between REST API requests (10-500ms). Higher values reduce rate limit violations.
                  </p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Public Request Delay</Label>
                    <span className="text-sm font-medium">{settings.publicRequestDelayMs || 20}ms</span>
                  </div>
                  <Slider
                    min={10}
                    max={200}
                    step={10}
                    value={[settings.publicRequestDelayMs || 20]}
                    onValueChange={([value]) => handleSettingChange("publicRequestDelayMs", value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Minimum delay for public/read-only requests (market data, ticker, etc.)
                  </p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Private Request Delay</Label>
                    <span className="text-sm font-medium">{settings.privateRequestDelayMs || 100}ms</span>
                  </div>
                  <Slider
                    min={50}
                    max={1000}
                    step={50}
                    value={[settings.privateRequestDelayMs || 100]}
                    onValueChange={([value]) => handleSettingChange("privateRequestDelayMs", value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Minimum delay for private/write requests (place orders, get balance, etc.)
                  </p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>WebSocket Connection Timeout</Label>
                    <span className="text-sm font-medium">{settings.websocketTimeoutMs || 30000}ms</span>
                  </div>
                  <Slider
                    min={5000}
                    max={60000}
                    step={5000}
                    value={[settings.websocketTimeoutMs || 30000]}
                    onValueChange={([value]) => handleSettingChange("websocketTimeoutMs", value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Timeout for WebSocket connections (5-60 seconds)
                  </p>
                </div>
              </div>

              <Separator />

              <div className="space-y-4">
                <h4 className="text-sm font-semibold">Rate Limit Statistics</h4>
                <div className="grid md:grid-cols-3 gap-4">
                  <div className="p-3 border rounded-lg bg-muted/30">
                    <p className="text-xs text-muted-foreground">Rest API Requests/Day</p>
                    <p className="text-lg font-semibold">{Math.floor((86400000 / (settings.restApiDelayMs || 50))).toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground mt-1">at {settings.restApiDelayMs || 50}ms delay</p>
                  </div>
                  <div className="p-3 border rounded-lg bg-muted/30">
                    <p className="text-xs text-muted-foreground">Public Requests/Day</p>
                    <p className="text-lg font-semibold">{Math.floor((86400000 / (settings.publicRequestDelayMs || 20))).toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground mt-1">at {settings.publicRequestDelayMs || 20}ms delay</p>
                  </div>
                  <div className="p-3 border rounded-lg bg-muted/30">
                    <p className="text-xs text-muted-foreground">Private Requests/Day</p>
                    <p className="text-lg font-semibold">{Math.floor((86400000 / (settings.privateRequestDelayMs || 100))).toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground mt-1">at {settings.privateRequestDelayMs || 100}ms delay</p>
                  </div>
                </div>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded p-3 text-sm">
                <p className="text-amber-900 font-semibold mb-2">Exchange-Specific Rate Limits</p>
                <ul className="text-amber-800 space-y-1 text-xs">
                  <li>• <strong>Bybit:</strong> 100 req/sec for public, 50 req/sec for private</li>
                  <li>• <strong>BingX:</strong> 1000 req/10sec for public, 200 req/10sec for private</li>
                  <li>• <strong>Pionex:</strong> 100 req/sec for public, 50 req/sec for private</li>
                  <li>• <strong>OKX:</strong> 40 req/sec for public, 40 req/sec for private</li>
                </ul>
              </div>
            </CardContent>
          </Card>

          {/* Settings Editor Dialog */}
          <SettingsEditorDialog
            isOpen={isSettingsDialogOpen}
            onOpenChange={setIsSettingsDialogOpen}
            settings={settings}
            onSave={async (updatedSettings) => {
              // Save settings via API or parent handler
              Object.entries(updatedSettings).forEach(([key, value]) => {
                handleSettingChange(key as keyof AppSettings, value)
              })
            }}
            onSettingChange={handleSettingChange}
          />
        </TabsContent>

        <TabsContent value="monitoring" className="space-y-4">
          <StatisticsOverview settings={settings} />
        </TabsContent>

        <TabsContent value="install" className="space-y-6 mt-6">
          <InstallManager />
          
          <Card>
            <CardHeader>
              <CardTitle>Database Migrations</CardTitle>
              <CardDescription>Run Redis migrations to update schema</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button 
                onClick={async () => {
                  try {
                    const { toast } = await import("sonner")
                    toast.info("Running migrations...")
                    const response = await fetch("/api/install/database/migrate", { method: "POST" })
                    const data = await response.json()
                    if (response.ok) {
                      toast.success("Migrations completed successfully")
                    } else {
                      toast.error(data.error || "Migration failed")
                    }
                  } catch (error) {
                    const { toast } = await import("sonner")
                    toast.error("Failed to run migrations")
                  }
                }} 
                variant="default"
                className="w-full"
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Run Migrations
              </Button>
              <p className="text-xs text-muted-foreground">
                Runs all pending Redis migrations to ensure your database schema is up to date.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="backup" className="space-y-6 mt-6">
          <Card>
            <CardHeader>
              <CardTitle>Export & Import Settings</CardTitle>
              <CardDescription>
                Back up your configuration or restore from a previous backup file.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-3">
                  <h4 className="text-sm font-medium">Export Configuration</h4>
                  <p className="text-xs text-muted-foreground">
                    Download all settings, connections, and strategies as a JSON file.
                  </p>
                  <Button onClick={exportSettings} disabled={exporting} variant="outline" className="w-full">
                    <Download className="h-4 w-4 mr-2" />
                    {exporting ? "Exporting..." : "Export Settings"}
                  </Button>
                </div>
                <div className="space-y-3">
                  <h4 className="text-sm font-medium">Import Configuration</h4>
                  <p className="text-xs text-muted-foreground">
                    Restore settings from a previously exported JSON backup file.
                  </p>
                  <Button onClick={importSettings} disabled={importing} variant="outline" className="w-full">
                    <Upload className="h-4 w-4 mr-2" />
                    {importing ? "Importing..." : "Import Settings"}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
          <LogsViewer />
        </TabsContent>
      </Tabs>
    </TabsContent>
  )
}

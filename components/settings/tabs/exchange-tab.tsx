"use client"

import { useEffect, useMemo } from "react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { Separator } from "@/components/ui/separator"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Plus, X } from "lucide-react"
import { useExchange } from "@/lib/exchange-context"
import { Badge } from "@/components/ui/badge"
import type { ExchangeConnection } from "@/lib/types"

interface ExchangeTabProps {
  settings: any
  handleSettingChange: (key: string, value: any) => void
  newMainSymbol: string
  setNewMainSymbol: (value: string) => void
  addMainSymbol: () => void
  removeMainSymbol: (symbol: string) => void
  newForcedSymbol: string
  setNewForcedSymbol: (value: string) => void
  addForcedSymbol: () => void
  removeForcedSymbol: (symbol: string) => void
  connections: any[]
}

const toBoolean = (value: unknown) =>
  value === true || value === 1 || value === "1" || value === "true"

export function ExchangeTab({
  settings,
  handleSettingChange,
  newMainSymbol,
  setNewMainSymbol,
  addMainSymbol,
  removeMainSymbol,
  newForcedSymbol,
  setNewForcedSymbol,
  addForcedSymbol,
  removeForcedSymbol,
  connections,
}: ExchangeTabProps) {
  const { selectedExchange, selectedConnectionId, setSelectedConnectionId } = useExchange()

  /*
   * IMPORTANT — this filter must match lib/exchange-context.tsx exactly.
   *
   * Previously this tab used `c.is_active_inserted === "1" || === true`, a
   * strict equality check that silently dropped connections whose flag was
   * stored as the numeric `1`, the string `"true"`, or any of the three
   * alternate "inserted" signals the rest of the app honors
   * (is_dashboard_inserted, is_assigned, is_enabled_dashboard).
   *
   * Symptom: a user would toggle a connection into Main Connections on the
   * dashboard, it would appear there, but the "Active Connection" dropdown
   * on Settings > Exchange would not list it — breaking the per-connection
   * settings flow entirely. The same toBoolean helper below is already the
   * source of truth used by ExchangeProvider.loadActiveConnections.
   */
  const mainConnections = useMemo(() => connections.filter((c: any) => {
    const isInserted =
      toBoolean(c.is_active_inserted) ||
      toBoolean(c.is_dashboard_inserted) ||
      toBoolean(c.is_assigned)
    const isDashboardActive = toBoolean(c.is_enabled_dashboard)
    return isInserted || isDashboardActive
  }), [connections])

  useEffect(() => {
    if (mainConnections.length === 0) return
    if (!mainConnections.some((connection: any) => connection.id === selectedConnectionId)) {
      setSelectedConnectionId(mainConnections[0].id)
    }
  }, [mainConnections, selectedConnectionId, setSelectedConnectionId])
  
  return (
    <Tabs defaultValue="exchange">
      <div className="mb-4 p-4 bg-muted/30 rounded-lg border">
        <label className="text-sm font-medium mb-2 block">Active Connection</label>
        <Select 
          value={mainConnections.some((connection: any) => connection.id === selectedConnectionId) ? selectedConnectionId || undefined : undefined}
          onValueChange={(val) => setSelectedConnectionId(val)}
          disabled={mainConnections.length === 0}
        >
          <SelectTrigger className="w-full max-w-md">
            <SelectValue placeholder="Select connection" />
          </SelectTrigger>
          <SelectContent>
            {mainConnections.map((conn: any) => (
              <SelectItem key={conn.id} value={conn.id}>
                <div className="flex items-center gap-2">
                  <span>{conn.name || conn.exchange}</span>
                  <Badge variant="outline" className="text-xs">{conn.exchange}</Badge>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/*
          Scope hint — the fields on this page are part of the global
          app_settings blob and apply to every connection. This selector only
          picks which exchange's per-connection overrides (API keys, leverage,
          cost %) are surfaced in the Connection Edit dialog below. The
          previous copy ("Isolated settings for this connection only")
          contradicted the global-scope banner and caused user confusion.
        */}
        <p className="text-xs text-muted-foreground mt-2">
          {mainConnections.length > 0
            ? "This selects the exchange context for previews. Trading defaults below remain global; use the connection card on the dashboard for isolated overrides."
            : "No active connection is assigned yet. Add and enable a connection in Overall → Exchange Connections."}
        </p>
      </div>
      <TabsContent value="exchange" className="space-y-4">
        {selectedExchange && (
          <div className="bg-muted/50 border rounded-lg p-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium">Active Exchange:</span>
              <Badge variant="secondary">{selectedExchange.toUpperCase()}</Badge>
              {/*
                Scope note — the fields on this page are saved via PUT
                /api/settings as a single global blob (app_settings hash in
                Redis). Truly per-connection fields (API keys, leverage,
                cost %) live in the Connection Edit dialog, not here. This
                copy was previously misleading (“Settings below apply to
                this exchange”), which caused repeated confusion.
              */}
              <span className="text-xs text-muted-foreground ml-auto">
                Global trading defaults &mdash; per-connection overrides in connection edit dialog
              </span>
            </div>
          </div>
        )}
        <Card>
          <CardHeader>
            <CardTitle>Main Configuration</CardTitle>
            <CardDescription>Core trading parameters and symbol selection for {selectedExchange || "all exchanges"}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Data & Timeframe Configuration</h3>
              <p className="text-sm text-muted-foreground">Configure historical data retrieval and market timeframes</p>

              <div className="grid md:grid-cols-2 gap-6">
                {/* Hours-based prehistoric range (1-50h, step 1, default 8). */}
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
                  <p className="text-xs text-muted-foreground">Historical candle range loaded on engine start (1-50 hours, default 8)</p>
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

            <Separator />

            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Position Configuration</h3>
              <p className="text-sm text-muted-foreground">
                Configure pseudo-position range settings. Base strategy sizing is system-internal and ratio based.
              </p>

              <div className="grid md:grid-cols-2 gap-6">
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
                      handleSettingChange("risk_percentage", value)
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
                    <p className="text-xs text-muted-foreground">Require minimum trading volume for positions</p>
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
                      Disable reduce-only SL/TP placements on the exchange. The engine evaluates
                      <code className="text-[10px] px-1 mx-1 rounded bg-muted">markPrice</code>
                      against the desired band each reconcile/sync cycle and force-closes via a single market
                      reduce-only order when crossed. Existing exchange SL/TP orders on open positions are swept on the next cycle.
                    </p>
                    <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1.5">
                      Ongoing-cycle progress check ensures every close is verified post-fill.
                    </p>
                  </div>
                  <Switch
                    checked={settings.useSystemCloseOnly === true}
                    onCheckedChange={(checked) => handleSettingChange("useSystemCloseOnly", checked)}
                  />
                </div>
              </div>
            </div>

            <Separator />

            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Position Configuration</h3>
              <p className="text-sm text-muted-foreground">
                Position cost as ratio/percentage used for pseudo position calculations (Base/Main/Real levels). Volume is
                calculated ONLY at Exchange level when orders are executed. This value is account-balance independent.
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
                  Position cost ratio used for Base/Main/Real pseudo position calculations (count-based, no volume). Volume
                  is calculated at Exchange level: volume = (accountBalance × positionCost) / (entryPrice × leverage).
                  Range: 0.02% - 1.0%, Default: 0.02%
                </p>
              </div>
            </div>

            <Separator />

            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Leverage Configuration</h3>
              <p className="text-sm text-muted-foreground">
                The engine always uses the exchange&apos;s maximum supported leverage per symbol.
                This setting cannot be changed — maximal leverage is enforced at the engine level.
              </p>

              <div className="flex items-center justify-between p-3 border rounded-lg opacity-70 cursor-not-allowed">
                <div>
                  <Label className="text-sm font-medium cursor-not-allowed">Use Maximal Leverage</Label>
                  <p className="text-xs text-muted-foreground">
                    Always on — engine uses the exchange&apos;s maximum supported leverage per symbol bracket.
                    The live-stage auto-halve retry handles per-symbol limits (e.g. code 101204).
                  </p>
                </div>
                <Switch checked={true} disabled={true} />
              </div>
            </div>

            <Separator />

            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Symbol Configuration</h3>
              <p className="text-sm text-muted-foreground">Configure symbol selection and ordering from exchanges</p>

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
                  <p className="text-xs text-muted-foreground">Count of symbols to retrieve from exchange (2-30)</p>
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

              <div className="space-y-3 mt-4">
                <Label>Main Trading Symbols</Label>
                <div className="flex gap-2">
                  <Input
                    placeholder="e.g., BTCUSDT"
                    value={newMainSymbol}
                    onChange={(e) => setNewMainSymbol(e.target.value.toUpperCase())}
                    onKeyPress={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        addMainSymbol()
                      }
                    }}
                  />
                  <Button onClick={addMainSymbol} size="icon">
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2 mt-2">
                  {settings.mainSymbols?.map((symbol: string) => (
                    <div
                      key={symbol}
                      className="flex items-center gap-1 px-3 py-1 bg-primary/10 text-primary rounded-full text-sm"
                    >
                      {symbol}
                      <button
                        type="button"
                        onClick={() => removeMainSymbol(symbol)}
                        className="ml-1 hover:text-destructive"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-3">
                <Label>Forced Symbols (Always Traded)</Label>
                <p className="text-xs text-muted-foreground">
                  Symbols that will always be included regardless of other filters
                </p>
                <div className="flex gap-2">
                  <Input
                    placeholder="e.g., ETHUSDT"
                    value={newForcedSymbol}
                    onChange={(e) => setNewForcedSymbol(e.target.value.toUpperCase())}
                    onKeyPress={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        addForcedSymbol()
                      }
                    }}
                  />
                  <Button onClick={addForcedSymbol} size="icon">
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2 mt-2">
                  {settings.forcedSymbols?.map((symbol: string) => (
                    <div
                      key={symbol}
                      className="flex items-center gap-1 px-3 py-1 bg-accent text-accent-foreground rounded-full text-sm"
                    >
                      {symbol}
                      <button
                        type="button"
                        onClick={() => removeForcedSymbol(symbol)}
                        className="ml-1 hover:text-destructive"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Position Management & Presets</CardTitle>
            <CardDescription>Position limits per exchange and preset configuration</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Max Positions Configuration</h3>
              <p className="text-sm text-muted-foreground">
                Configure maximum positions per exchange. These values automatically limit how many strategies can be
                deployed based on available symbols and exchange constraints.
              </p>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Max Positions (Binance)</Label>
                  <Slider
                    min={1}
                    max={125}
                    step={1}
                    value={[settings.maxPositions?.binance || 125]}
                    onValueChange={([value]) =>
                      handleSettingChange("maxPositions", { ...settings.maxPositions, binance: value })
                    }
                  />
                  <p className="text-xs text-muted-foreground">Current: {settings.maxPositions?.binance || 125}</p>
                </div>

                <div className="space-y-2">
                  <Label>Max Positions (Bybit)</Label>
                  <Slider
                    min={1}
                    max={500}
                    step={1}
                    value={[settings.maxPositions?.bybit || 500]}
                    onValueChange={([value]) =>
                      handleSettingChange("maxPositions", { ...settings.maxPositions, bybit: value })
                    }
                  />
                  <p className="text-xs text-muted-foreground">Current: {settings.maxPositions?.bybit || 500}</p>
                </div>

                <div className="space-y-2">
                  <Label>Max Positions (OKX)</Label>
                  <Slider
                    min={1}
                    max={200}
                    step={1}
                    value={[settings.maxPositions?.okx || 200]}
                    onValueChange={([value]) =>
                      handleSettingChange("maxPositions", { ...settings.maxPositions, okx: value })
                    }
                  />
                  <p className="text-xs text-muted-foreground">Current: {settings.maxPositions?.okx || 200}</p>
                </div>

                <div className="space-y-2">
                  <Label>Max Positions (Gate.io)</Label>
                  <Slider
                    min={1}
                    max={200}
                    step={1}
                    value={[settings.maxPositions?.gateio || 200]}
                    onValueChange={([value]) =>
                      handleSettingChange("maxPositions", { ...settings.maxPositions, gateio: value })
                    }
                  />
                  <p className="text-xs text-muted-foreground">Current: {settings.maxPositions?.gateio || 200}</p>
                </div>
              </div>

              <Separator className="my-6" />

              <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                <h3 className="text-sm font-semibold text-blue-900 dark:text-blue-100 mb-2">Preset Configuration</h3>
                <p className="text-xs text-blue-700 dark:text-blue-300">
                  Preset strategies can now be managed through the <strong>Presets page</strong>. Navigate to the Presets
                  section to configure custom sets of strategies with different symbol selections, leverage settings, and
                  risk parameters. The actual preset type sets and their availability are managed on the{" "}
                  <strong>Presets page</strong>, where you can create and organize multiple configurations into sets.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  )
}

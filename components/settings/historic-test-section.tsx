"use client"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import {
  HISTORIC_TEST_MAX_PROGRESS_COUNT,
  HISTORIC_TEST_PERIOD_HOURS,
  HISTORIC_TEST_LIVE_CHECK_POSITIONS,
  HISTORIC_TEST_RECALC_INTERVAL_HOURS,
  HISTORIC_TEST_STRATEGY_FAMILIES,
  HISTORIC_TEST_SYMBOL_COUNT,
  HISTORIC_TEST_SYMBOL_ORDERS,
  type HistoricTestSettings,
  type HistoricTestStrategyFamily,
  type HistoricTestSymbolOrder,
} from "@/lib/historic-test-settings"
import { MAIN_TRADE_PF_RATIO_MAX, MAIN_TRADE_PF_RATIO_MIN, MAIN_TRADE_PF_RATIO_STEP } from "@/lib/main-trade-profit-factor"

const FAMILY_LABEL: Record<HistoricTestStrategyFamily, string> = {
  normal: "Normal",
  trailing: "Trailing",
  axis: "Axis",
  block: "Block",
  dca: "DCA",
}

const ORDER_LABEL: Record<HistoricTestSymbolOrder, string> = {
  volatility_1h: "1H Volatility",
  volume_24h: "24H Volume",
  change_24h: "24H Change",
  alphabetical: "Alphabetical",
}

interface Props {
  value: HistoricTestSettings
  onChange: (next: HistoricTestSettings) => void
  /** Exchanges the operator may rank symbols from; the connection's own is always offered. */
  exchangeOptions?: string[]
  connectionExchange?: string
}

export function HistoricTestSection({ value, onChange, exchangeOptions = [], connectionExchange = "" }: Props) {
  const set = <K extends keyof HistoricTestSettings>(key: K, next: HistoricTestSettings[K]) =>
    onChange({ ...value, [key]: next })
  const exchanges = Array.from(new Set([connectionExchange, ...exchangeOptions].map((e) => String(e || "").toLowerCase()).filter(Boolean)))

  return (
    <Card data-testid="historic-test-section">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm">Historic Test</CardTitle>
            <CardDescription className="text-xs">
              Replays the last period of real history as simulated trades, scores every
              symbol × indication × strategy independently, and keeps only the combinations
              that end positive. When enabled the engine works from that validated set and
              the overall configuration stands back until the historic pass has run.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge variant={value.enabled ? "default" : "secondary"} className="text-[10px]">
              {value.enabled ? "enabled" : "disabled"}
            </Badge>
            <Switch
              id="historic-test-enabled"
              aria-label="Enable Historic Test"
              checked={value.enabled}
              onCheckedChange={(checked) => set("enabled", checked)}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Last period (hours)</Label>
              <span className="text-xs tabular-nums text-muted-foreground">{value.periodHours} h</span>
            </div>
            <Slider
              aria-label="Historic Test period hours"
              min={HISTORIC_TEST_PERIOD_HOURS.min}
              max={HISTORIC_TEST_PERIOD_HOURS.max}
              step={HISTORIC_TEST_PERIOD_HOURS.step}
              value={[value.periodHours]}
              onValueChange={([v]) => set("periodHours", v)}
            />
            <p className="text-[11px] text-muted-foreground">
              {HISTORIC_TEST_PERIOD_HOURS.min}–{HISTORIC_TEST_PERIOD_HOURS.max} h in steps of {HISTORIC_TEST_PERIOD_HOURS.step}; default {HISTORIC_TEST_PERIOD_HOURS.default}.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="historic-test-min-pf">Minimal ProfitFactor</Label>
            <Input
              id="historic-test-min-pf"
              type="number"
              inputMode="decimal"
              min={MAIN_TRADE_PF_RATIO_MIN}
              max={MAIN_TRADE_PF_RATIO_MAX}
              step={MAIN_TRADE_PF_RATIO_STEP}
              value={value.minProfitFactor}
              onChange={(e) => set("minProfitFactor", Number(e.target.value))}
              className="h-8 text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              PositionCost-relative: 1.00 is neutral, every 0.10 is one PositionCost. Default 1.20.
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Count symbols</Label>
              <span className="text-xs tabular-nums text-muted-foreground">{value.symbolCount}</span>
            </div>
            <Slider
              aria-label="Historic Test symbol count"
              min={HISTORIC_TEST_SYMBOL_COUNT.min}
              max={HISTORIC_TEST_SYMBOL_COUNT.max}
              step={1}
              value={[value.symbolCount]}
              onValueChange={([v]) => set("symbolCount", v)}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Recalc interval (hours)</Label>
              <span className="text-xs tabular-nums text-muted-foreground">{value.recalcIntervalHours} h</span>
            </div>
            <Slider
              aria-label="Historic Test recalc interval hours"
              min={HISTORIC_TEST_RECALC_INTERVAL_HOURS.min}
              max={HISTORIC_TEST_RECALC_INTERVAL_HOURS.max}
              step={1}
              value={[value.recalcIntervalHours]}
              onValueChange={([v]) => set("recalcIntervalHours", v)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Live check positions</Label>
            <span className="text-xs tabular-nums text-muted-foreground">{value.liveCheckPositions}</span>
          </div>
          <Slider
            aria-label="Historic Test live check positions"
            min={HISTORIC_TEST_LIVE_CHECK_POSITIONS.min}
            max={HISTORIC_TEST_LIVE_CHECK_POSITIONS.max}
            step={1}
            value={[value.liveCheckPositions]}
            onValueChange={([v]) => set("liveCheckPositions", v)}
          />
          <p className="text-[11px] text-muted-foreground">
            A validated config is re-judged on its own last N settled live results and
            deactivated when they turn negative. Judged per config — a failing Block count
            never disqualifies a sibling. Default {HISTORIC_TEST_LIVE_CHECK_POSITIONS.default}.
          </p>
        </div>

        <div className="space-y-2">
          <Label className="text-xs">Strategies</Label>
          <div className="flex flex-wrap gap-2">
            {HISTORIC_TEST_STRATEGY_FAMILIES.map((family) => (
              <label
                key={family}
                className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5 text-xs"
              >
                <Switch
                  aria-label={`Historic Test ${FAMILY_LABEL[family]}`}
                  checked={value.strategies[family]}
                  onCheckedChange={(checked) =>
                    set("strategies", { ...value.strategies, [family]: checked })}
                />
                {FAMILY_LABEL[family]}
              </label>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            All enabled by default. Every family is validated on its own; only positive combinations are kept.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="historic-test-exchange">Exchange</Label>
            <select
              id="historic-test-exchange"
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
              value={value.symbols.exchange || connectionExchange.toLowerCase()}
              onChange={(e) => set("symbols", { ...value.symbols, exchange: e.target.value })}
            >
              {exchanges.length === 0 && <option value="">connection default</option>}
              {exchanges.map((exchange) => (
                <option key={exchange} value={exchange}>{exchange}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="historic-test-order">Order type</Label>
            <select
              id="historic-test-order"
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
              value={value.symbols.order}
              onChange={(e) => set("symbols", { ...value.symbols, order: e.target.value as HistoricTestSymbolOrder })}
            >
              {HISTORIC_TEST_SYMBOL_ORDERS.map((order) => (
                <option key={order} value={order}>{ORDER_LABEL[order]}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Max progress count</Label>
              <span className="text-xs tabular-nums text-muted-foreground">{value.symbols.maxProgressCount}</span>
            </div>
            <Slider
              aria-label="Historic Test max progress count"
              min={HISTORIC_TEST_MAX_PROGRESS_COUNT.min}
              max={HISTORIC_TEST_MAX_PROGRESS_COUNT.max}
              step={10}
              value={[value.symbols.maxProgressCount]}
              onValueChange={([v]) => set("symbols", { ...value.symbols, maxProgressCount: v })}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

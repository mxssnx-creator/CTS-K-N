"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Filter, RotateCcw, ChevronDown, ChevronUp, X } from "lucide-react"

/**
 * Filters for the per-symbol stage summaries returned by /api/data/strategies.
 * Only dimensions those rows actually carry are offered: symbol, stage
 * (Base → Main → Real → Live), last-update time, measured PF ratio and the
 * active / valid state. TP/SL/volume coordinates, trailing and win rate are
 * not part of the summary rows, so filtering on them would silently act on
 * placeholders.
 */
export interface AdvancedFilters {
  /** inclusive local dates (yyyy-mm-dd) bounding the row's last update */
  dateFrom: string
  dateTo: string
  symbols: string[]
  symbolInput: string
  /** lower-case stage ids: base | main | real | live */
  stages: string[]
  profitFactorMin: number
  activeOnly: boolean
  validOnly: boolean
}

export const INITIAL_ADVANCED_FILTERS: AdvancedFilters = {
  dateFrom: "",
  dateTo: "",
  symbols: [],
  symbolInput: "",
  stages: [],
  profitFactorMin: 0,
  activeOnly: false,
  validOnly: false,
}

export const STAGE_OPTIONS = [
  { id: "base", label: "Base" },
  { id: "main", label: "Main" },
  { id: "real", label: "Real" },
  { id: "live", label: "Live" },
] as const

/** Normalised symbol key used by both the chips and the row filter (BTC-USDT → BTCUSDT). */
export const symbolKey = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]+/g, "")

export function activeFilterCount(filters: AdvancedFilters): number {
  return (
    (filters.dateFrom ? 1 : 0) +
    (filters.dateTo ? 1 : 0) +
    filters.symbols.length +
    filters.stages.length +
    (filters.profitFactorMin > 0 ? 1 : 0) +
    (filters.activeOnly ? 1 : 0) +
    (filters.validOnly ? 1 : 0)
  )
}

interface StrategyFiltersAdvancedProps {
  filters: AdvancedFilters
  onFiltersChange: (filters: AdvancedFilters) => void
  /** symbols present in the loaded rows, offered as one-click chips */
  availableSymbols?: readonly string[]
}

type Section = "date" | "symbols" | "stages" | "performance"

export function StrategyFiltersAdvanced({ filters, onFiltersChange, availableSymbols = [] }: StrategyFiltersAdvancedProps) {
  const [expanded, setExpanded] = useState<Record<Section, boolean>>({
    date: true,
    symbols: true,
    stages: true,
    performance: true,
  })

  const toggleSection = (section: Section) => setExpanded((prev) => ({ ...prev, [section]: !prev[section] }))
  const update = (patch: Partial<AdvancedFilters>) => onFiltersChange({ ...filters, ...patch })

  const addSymbol = (raw: string) => {
    const symbol = raw.trim().toUpperCase()
    if (!symbol) return
    // one update: two sequential updates would each spread the stale filters
    // and the second would drop the symbol the first one added
    update({
      symbols: filters.symbols.some((s) => symbolKey(s) === symbolKey(symbol)) ? filters.symbols : [...filters.symbols, symbol],
      symbolInput: "",
    })
  }

  const presets = availableSymbols.filter((sym) => !filters.symbols.some((s) => symbolKey(s) === symbolKey(sym)))
  const count = activeFilterCount(filters)

  const SectionHeader = ({ id, title }: { id: Section; title: string }) => (
    <button
      type="button"
      onClick={() => toggleSection(id)}
      aria-expanded={expanded[id]}
      className="flex w-full items-center justify-between px-3 py-2 text-left transition-colors hover:bg-muted/50"
    >
      <span className="font-semibold">{title}</span>
      {expanded[id] ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
    </button>
  )

  return (
    <Card className="border-border bg-card/60">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 whitespace-nowrap text-sm">
            <Filter className="h-4 w-4" />
            Filters
            {count > 0 && <Badge variant="secondary" className="h-4 px-1.5 text-[10px] tabular-nums">{count}</Badge>}
          </CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onFiltersChange(INITIAL_ADVANCED_FILTERS)}
            disabled={count === 0 && !filters.symbolInput}
            className="h-7 text-xs"
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            Reset
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3 text-xs">
        <div className="rounded border border-border bg-muted/20">
          <SectionHeader id="date" title="Last update" />
          {expanded.date && (
            <div className="space-y-2 border-t border-border px-3 py-2">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1 2xl:grid-cols-2">
                <div className="min-w-0">
                  <Label htmlFor="strategy-filter-from" className="mb-1 block text-xs text-muted-foreground">From</Label>
                  <Input
                    id="strategy-filter-from"
                    type="date"
                    value={filters.dateFrom}
                    max={filters.dateTo || undefined}
                    onChange={(e) => update({ dateFrom: e.target.value })}
                    className="h-8 w-full min-w-0 text-xs"
                  />
                </div>
                <div className="min-w-0">
                  <Label htmlFor="strategy-filter-to" className="mb-1 block text-xs text-muted-foreground">To</Label>
                  <Input
                    id="strategy-filter-to"
                    type="date"
                    value={filters.dateTo}
                    min={filters.dateFrom || undefined}
                    onChange={(e) => update({ dateTo: e.target.value })}
                    className="h-8 w-full min-w-0 text-xs"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="rounded border border-border bg-muted/20">
          <SectionHeader id="symbols" title={`Symbols (${filters.symbols.length})`} />
          {expanded.symbols && (
            <div className="space-y-2 border-t border-border px-3 py-2">
              <form
                className="flex gap-1"
                onSubmit={(e) => {
                  e.preventDefault()
                  addSymbol(filters.symbolInput)
                }}
              >
                <Input
                  type="text"
                  aria-label="Add symbol"
                  placeholder="e.g. BTC"
                  value={filters.symbolInput}
                  onChange={(e) => update({ symbolInput: e.target.value.toUpperCase() })}
                  className="h-7 min-w-0 flex-1 text-xs"
                />
                <Button type="submit" size="sm" className="h-7 px-2" disabled={!filters.symbolInput.trim()} aria-label="Add symbol filter">
                  +
                </Button>
              </form>
              {filters.symbols.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {filters.symbols.map((sym) => (
                    <Badge key={sym} variant="default" className="gap-1 py-0.5 text-xs">
                      {sym}
                      <button
                        type="button"
                        aria-label={`Remove ${sym}`}
                        className="rounded-sm opacity-70 hover:opacity-100"
                        onClick={() => update({ symbols: filters.symbols.filter((s) => s !== sym) })}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
              {presets.length > 0 ? (
                <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
                  {presets.map((sym) => (
                    <Badge
                      key={sym}
                      variant="outline"
                      role="button"
                      tabIndex={0}
                      className="cursor-pointer py-0.5 text-xs hover:bg-muted"
                      onClick={() => addSymbol(sym)}
                      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && addSymbol(sym)}
                    >
                      +{sym}
                    </Badge>
                  ))}
                </div>
              ) : (
                filters.symbols.length === 0 && <div className="text-muted-foreground">No symbols recorded yet.</div>
              )}
            </div>
          )}
        </div>

        <div className="rounded border border-border bg-muted/20">
          <SectionHeader id="stages" title={`Stage (${filters.stages.length})`} />
          {expanded.stages && (
            <div className="grid grid-cols-2 gap-1 border-t border-border px-3 py-2">
              {STAGE_OPTIONS.map(({ id, label }) => {
                const selected = filters.stages.includes(id)
                return (
                  <Button
                    key={id}
                    type="button"
                    size="sm"
                    variant={selected ? "default" : "outline"}
                    aria-pressed={selected}
                    className="h-7 text-xs"
                    onClick={() => update({ stages: selected ? filters.stages.filter((s) => s !== id) : [...filters.stages, id] })}
                  >
                    {label}
                  </Button>
                )
              })}
            </div>
          )}
        </div>

        <div className="rounded border border-border bg-muted/20">
          <SectionHeader id="performance" title="Performance" />
          {expanded.performance && (
            <div className="space-y-3 border-t border-border px-3 py-2">
              <div>
                <Label className="mb-2 block text-muted-foreground">
                  Min PF ratio: <span className="tabular-nums text-foreground">{filters.profitFactorMin > 0 ? filters.profitFactorMin.toFixed(2) : "any"}</span>
                </Label>
                <Slider
                  value={[filters.profitFactorMin]}
                  onValueChange={(value) => update({ profitFactorMin: value[0] })}
                  min={0}
                  max={3}
                  step={0.05}
                  aria-label="Minimum PF ratio"
                  className="w-full"
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="strategy-filter-active" className="text-muted-foreground">Active only</Label>
                <Switch id="strategy-filter-active" checked={filters.activeOnly} onCheckedChange={(checked) => update({ activeOnly: checked })} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="strategy-filter-valid" className="text-muted-foreground">Valid only</Label>
                <Switch id="strategy-filter-valid" checked={filters.validOnly} onCheckedChange={(checked) => update({ validOnly: checked })} />
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

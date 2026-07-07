"use client"

import { useMemo } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"

/**
 * Spec-mandated multi-step trailing matrix for Base Strategies.
 *
 *   trailingStart  ∈ {0.3, 0.6, 0.9, 1.2, 1.5}   step 0.3   activation gain
 *   trailingStop   ∈ {0.1, 0.2, 0.3, 0.4, 0.5}   step 0.1   trail distance
 *   trailingStep   = trailingStop / 2                       ratchet increment
 *
 * Each enabled (start, stop) combo spawns ONE independent Base Set per
 * (indication_type × direction). Operator prunes the 5×5 matrix here.
 *
 * Encoding: variants persisted as `string[]` of "start:stop" tokens
 * (e.g. ["0.3:0.1", "0.6:0.2", …]) under
 * `settings.strategyBaseTrailingVariants`.
 */

const START_VALUES = [0.3, 0.6, 0.9, 1.2, 1.5] as const
const STOP_VALUES = [0.1, 0.2, 0.3, 0.4, 0.5] as const

const fmtRatio = (r: number) => `${(r * 100).toFixed(0)}%`
const variantKey = (start: number, stop: number) => `${start.toFixed(1)}:${stop.toFixed(1)}`

interface MultiTrailingSettingsProps {
  settings: any
  handleSettingChange: (key: string, value: any) => void
}

export default function MultiTrailingSettings({
  settings,
  handleSettingChange,
}: MultiTrailingSettingsProps) {
  // Normalise to a Set for O(1) lookup; defaults to all 25 enabled when missing
  const enabledSet = useMemo(() => {
    const list: string[] = Array.isArray(settings.strategyBaseTrailingVariants)
      ? settings.strategyBaseTrailingVariants
      : []
    return new Set(list)
  }, [settings.strategyBaseTrailingVariants])

  const masterEnabled = settings.strategyBaseTrailingEnabled !== false
  const totalEnabled = enabledSet.size
  const totalCombos = START_VALUES.length * STOP_VALUES.length

  const setVariants = (next: Set<string>) => {
    // Stable order: iterate matrix top-to-bottom, left-to-right
    const ordered: string[] = []
    for (const s of START_VALUES) {
      for (const k of STOP_VALUES) {
        const key = variantKey(s, k)
        if (next.has(key)) ordered.push(key)
      }
    }
    handleSettingChange("strategyBaseTrailingVariants", ordered)
  }

  const toggleVariant = (start: number, stop: number) => {
    const key = variantKey(start, stop)
    const next = new Set(enabledSet)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setVariants(next)
  }

  const toggleStartRow = (start: number) => {
    const next = new Set(enabledSet)
    const allOn = STOP_VALUES.every((k) => next.has(variantKey(start, k)))
    for (const k of STOP_VALUES) {
      const key = variantKey(start, k)
      if (allOn) next.delete(key)
      else next.add(key)
    }
    setVariants(next)
  }

  const enableAll = () => {
    const all = new Set<string>()
    for (const s of START_VALUES) for (const k of STOP_VALUES) all.add(variantKey(s, k))
    setVariants(all)
  }

  const disableAll = () => setVariants(new Set())

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Base Multi-Step Trailing</CardTitle>
          <CardDescription>
            Spawn independent Base Sets per enabled trailing configuration.
            Each enabled (start × stop) combo creates one Set per
            (indication_type × direction); the engine evaluates the full
            matrix in parallel. Per-direction position cap still applies.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Master toggle */}
          <div className="flex items-center justify-between rounded-lg border bg-card p-4">
            <div className="space-y-1">
              <Label className="text-base">Multi-Step Trailing Enabled</Label>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Master switch. When off, Base falls back to the legacy
                single-step path with statistically-decided trailing
                (confidence ≥ 0.85) — no Set fan-out occurs.
              </p>
            </div>
            <Switch
              checked={masterEnabled}
              onCheckedChange={(checked) =>
                handleSettingChange("strategyBaseTrailingEnabled", checked)
              }
            />
          </div>

          {/* Summary + bulk actions */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant="secondary" className="font-mono">
                {totalEnabled} / {totalCombos} variants
              </Badge>
              <span className="text-xs text-muted-foreground">
                Each enabled combo → 1 Base Set per (type × direction).
                With 6 indication types × 2 directions:{" "}
                <span className="font-mono font-medium">
                  ~{totalEnabled * 12}
                </span>{" "}
                Base Sets per symbol per cycle.
              </span>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={enableAll}
                disabled={!masterEnabled || totalEnabled === totalCombos}
              >
                Enable all
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={disableAll}
                disabled={!masterEnabled || totalEnabled === 0}
              >
                Disable all
              </Button>
            </div>
          </div>

          {/* Per-start submenus — one collapsible group per trailingStart row */}
          <div className={masterEnabled ? "" : "pointer-events-none opacity-50"}>
            <h3 className="text-sm font-semibold mb-2">
              Trailing-Start Activation Groups
            </h3>
            <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
              Trailing activates only after the position is in profit by
              the start ratio. Each row below is one activation threshold
              with five trail-distance options.
            </p>

            <Accordion type="multiple" defaultValue={START_VALUES.map((s) => `start-${s}`)}>
              {START_VALUES.map((start) => {
                const rowEnabled = STOP_VALUES.filter((k) =>
                  enabledSet.has(variantKey(start, k)),
                ).length
                return (
                  <AccordionItem key={start} value={`start-${start}`}>
                    <AccordionTrigger className="hover:no-underline">
                      <div className="flex w-full items-center justify-between pr-3">
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-sm font-medium">
                            start = {start.toFixed(1)}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            ({fmtRatio(start)} gain triggers trailing)
                          </span>
                        </div>
                        <Badge
                          variant={rowEnabled === STOP_VALUES.length ? "default" : "secondary"}
                          className="font-mono"
                        >
                          {rowEnabled} / {STOP_VALUES.length}
                        </Badge>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-3 pt-2">
                        <div className="flex justify-end">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => toggleStartRow(start)}
                          >
                            {rowEnabled === STOP_VALUES.length
                              ? "Disable row"
                              : "Enable row"}
                          </Button>
                        </div>

                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                          {STOP_VALUES.map((stop) => {
                            const key = variantKey(start, stop)
                            const enabled = enabledSet.has(key)
                            const step = stop / 2
                            return (
                              <label
                                key={key}
                                htmlFor={`variant-${key}`}
                                className={`flex cursor-pointer flex-col gap-2 rounded-lg border p-3 transition-colors ${
                                  enabled
                                    ? "border-primary bg-primary/5"
                                    : "border-border bg-card hover:bg-muted/50"
                                }`}
                              >
                                <div className="flex items-center justify-between">
                                  <Checkbox
                                    id={`variant-${key}`}
                                    checked={enabled}
                                    onCheckedChange={() => toggleVariant(start, stop)}
                                  />
                                  <span className="text-xs font-mono text-muted-foreground">
                                    {key}
                                  </span>
                                </div>
                                <div className="space-y-0.5">
                                  <p className="text-xs font-medium">
                                    stop = {stop.toFixed(1)}{" "}
                                    <span className="text-muted-foreground">
                                      ({fmtRatio(stop)})
                                    </span>
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    step = {step.toFixed(2)}{" "}
                                    <span className="opacity-70">
                                      ({fmtRatio(step)})
                                    </span>
                                  </p>
                                </div>
                              </label>
                            )
                          })}
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                )
              })}
            </Accordion>
          </div>

          <Separator />

          {/* Mechanics explainer */}
          <div className="rounded-lg border bg-muted/30 p-4 text-xs leading-relaxed text-muted-foreground space-y-2">
            <p className="font-semibold text-foreground">How multi-step trailing works</p>
            <p>
              <span className="font-mono">start</span> — minimum profit
              ratio before trailing activates. Below this, fixed TP/SL only.
            </p>
            <p>
              <span className="font-mono">stop</span> — distance kept
              between price and the trailing stop, anchored to the
              high-water mark of the trade (low-water for shorts).
            </p>
            <p>
              <span className="font-mono">step</span> — minimum favourable
              price move before the trailing stop is re-anchored. Always
              half of <span className="font-mono">stop</span>. Prevents
              chatter on small wiggles while keeping the ratchet responsive.
            </p>
            <p>
              All three values are <em>ratios</em>:{" "}
              <span className="font-mono">0.1</span> ≡ 10% of price change.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

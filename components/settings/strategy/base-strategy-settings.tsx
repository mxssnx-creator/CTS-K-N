"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  MAIN_TRADE_BASE_PF_RATIO_DEFAULT,
  MAIN_TRADE_BASE_PF_RATIO_MIN,
  MAIN_TRADE_PF_RATIO_MAX,
  MAIN_TRADE_PF_RATIO_STEP,
  normalizeMainTradeStagePfRatio,
} from "@/lib/main-trade-profit-factor"
// `Switch` no longer imported — the obsolete `Base Trailing Enabled`
// toggle has been replaced with an engine-decided statistical-trailing
// note (see comment block below).

export default function BaseStrategySettings({
  settings,
  handleSettingChange,
}: {
  settings: any
  handleSettingChange: (key: string, value: any) => void
}) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Base Strategy Configuration</CardTitle>
          <CardDescription>
            Configure base-level strategy parameters that form the foundation of position calculations
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4">
            <h3 className="text-lg font-semibold border-b pb-2">Value Range Settings</h3>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Base Value Min</Label>
                <Input
                  type="number"
                  min="0.1"
                  max="5"
                  step="0.1"
                  value={settings.strategyBaseValueMin || 0.5}
                  onChange={(e) => handleSettingChange("strategyBaseValueMin", Number.parseFloat(e.target.value))}
                />
                <p className="text-xs text-muted-foreground">Minimum base value for position sizing (default: 0.5)</p>
              </div>

              <div className="space-y-2">
                <Label>Base Value Max</Label>
                <Input
                  type="number"
                  min="0.5"
                  max="10"
                  step="0.1"
                  value={settings.strategyBaseValueMax || 2.5}
                  onChange={(e) => handleSettingChange("strategyBaseValueMax", Number.parseFloat(e.target.value))}
                />
                <p className="text-xs text-muted-foreground">Maximum base value for position sizing (default: 2.5)</p>
              </div>
            </div>
          </div>

          <div className="border-t pt-6 space-y-4">
            <h3 className="text-lg font-semibold border-b pb-2">Coordination Ratio</h3>

            <div className="rounded-lg border bg-muted/40 p-4">
              <p className="text-sm font-medium">Base ratio: 1.0x (fixed)</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Base → Main → Real preserves the same unit basis. Only explicit
                Main, Preset, Signal, Position-count, DCA and Block ratios can
                adjust physical Live volume.
              </p>
            </div>
          </div>

          {/*
           * Trailing is no longer an operator toggle.
           *
           * Spec: "Trailing, No Trailing handled System Internally and
           * Statistically". The strategy coordinator decides trailing
           * on/off PER POSITION at creation time based on the best entry's
           * statistical confidence — see
           * `lib/strategy-coordinator.ts` (`trailing = bestEntry.confidence >= 0.85`).
           *
           * The previous `strategyBaseTrailing` Switch had ZERO engine
           * consumers — toggling it had no effect on any live path. It
           * has been removed to prevent operator confusion and to keep
           * the settings UI honest about what the engine actually reads.
           */}
          <div className="border-t pt-6 space-y-4">
            <h3 className="text-lg font-semibold border-b pb-2">Base Strategy Features</h3>

            <div className="rounded-lg border bg-muted/40 p-4">
              <p className="text-sm font-medium">Trailing Stop Loss</p>
              <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                Trailing is decided automatically per position based on
                statistical confidence of the originating Set (threshold
                <span className="font-mono"> conf ≥ 0.85</span>). High-confidence
                Sets enable trailing; lower-confidence Sets use fixed TP/SL.
                No operator toggle is consulted on the live path.
              </p>
            </div>
          </div>

          <div className="border-t pt-6 space-y-4">
            <h3 className="text-lg font-semibold border-b pb-2">Profit Factor</h3>

            <div className="space-y-2">
              <Label>Base Min Profit Factor</Label>
              <Input
                type="number"
                min={MAIN_TRADE_BASE_PF_RATIO_MIN}
                max={MAIN_TRADE_PF_RATIO_MAX}
                step={MAIN_TRADE_PF_RATIO_STEP}
                value={settings.baseProfitFactor ?? MAIN_TRADE_BASE_PF_RATIO_DEFAULT}
                onChange={(e) => handleSettingChange(
                  "baseProfitFactor",
                  normalizeMainTradeStagePfRatio("base", Number.parseFloat(e.target.value)),
                )}
              />
              <p className="text-xs text-muted-foreground">
                PositionCost-relative Base Valid ratio (1.00 is calculation-neutral; selectable range 1.02–2.30 in 0.02 steps; default 1.10).
              </p>
            </div>
          </div>

          {/*
           * P0-4: Max active pseudo positions per direction.
           *
           * Exact-lane invariant: one open pseudo position for each complete
           * connection/symbol/indication/config/direction/Base-Set identity.
           */}
          <div className="border-t pt-6 space-y-4">
            <h3 className="text-lg font-semibold border-b pb-2">
              Active Pseudo Position Limit
            </h3>

            <div className="space-y-2">
              <Label>Open Positions Per Exact Base Lane</Label>
              <Input
                type="number"
                min="1"
                max="1"
                step="1"
                value={settings.maxActiveBasePseudoPositionsPerDirection ?? 1}
                disabled
              />
              <p className="text-xs text-muted-foreground">
                Fixed at one per complete symbol × indication type/name ×
                configuration × Long/Short × Base Set. This does not cap the
                total number of independent Base configurations.
              </p>
            </div>
          </div>

          <div className="p-4 bg-muted rounded-lg space-y-3">
            <h4 className="text-sm font-semibold">Base Strategy Overview</h4>
            <div className="space-y-2 text-xs text-muted-foreground">
              <p>
                The Base Strategy forms the foundation of all position calculations. It determines the initial position
                sizes and volume allocations.
              </p>
              <p>
                Value ranges control strategy configuration. The shared volume
                coordination basis remains fixed at 1.0x.
              </p>
              <p>
                Profit protection (trailing stop) is engine-managed
                per position based on statistical confidence — see the
                Trailing Stop Loss note above.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

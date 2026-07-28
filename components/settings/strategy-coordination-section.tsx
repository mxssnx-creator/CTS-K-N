"use client"

/**
 * Strategy Coordination Settings Section
 *
 * Lives inside the Strategies tab of the Connection Settings dialog and
 * gives the operator a single, organised surface for the *Position-Count
 * coordination* layer added on top of base strategy evaluation. It groups
 * settings that previously lived only as code constants in
 * `lib/strategy-coordinator.ts` into a per-connection, persisted form.
 *
 * Two distinct sub-sections:
 *
 * 1. **Position-Count Axes** — the four step-1 axes that gate
 *    Main-stage related Set creation. Each axis has:
 *      • an enable toggle (the axis can be disabled entirely)
 *      • a max-window slider (1..N; N defaults to spec maxima
 *        12 / 4 / 8 / 8 for prev / last / cont / pause respectively)
 *
 * 2. **Variant Profiles** — the *categorical* variants evaluated on top
 *    of the axes:
 *      • Default       (always on; not toggleable)
 *      • Trailing      (gated on lastWins ≥ 2 + no continuous)
 *      • Block         (Count 1..N independently evaluated from exact Set
 *                       history; INDEPENDENT of Pos-count axes)
 *      • DCA           (gated on prevLosses ≥ 1; INDEPENDENT of axes)
 *
 * Pause is intentionally modeled only as a Position-Count axis above; it
 * pauses/calibrates further calculations by count window and is not a
 * general strategy variant. Block + DCA are flagged "Independent" in the UI so the operator
 * understands they don't fold into the axis windows above.
 *
 * The component is *purely controlled* — it accepts the current
 * `CoordinationSettings` value plus an `onChange` callback. Persistence
 * is the parent dialog's responsibility; the parent already round-trips
 * settings through the connection-settings API.
 */

import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import {
  ALL_TRAILING_VARIANTS,
  DEFAULT_TRAILING_VARIANTS,
  TRAILING_START_RATIOS,
  TRAILING_STOP_RATIOS,
  trailingVariantKey,
} from "@/lib/trailing-settings"
import { DEFAULT_DCA_PROFILE, type DcaTakeProfitMode } from "@/lib/dca-strategy"
import { STRATEGY_AXIS_SPECS } from "@/lib/strategy-axis-settings"
import {
  DEFAULT_BASE_MIN_STEP,
  MAX_BASE_STEP,
  MIN_BASE_STEP,
} from "@/lib/constants"
import {
  POS_COUNT_VOLUME_RATIO_DEFAULT,
  POS_COUNT_VOLUME_RATIO_MAX,
  POS_COUNT_VOLUME_RATIO_MIN,
  POS_COUNT_VOLUME_RATIO_STEP,
  posCountVolumeRatioToSetMultiplier,
} from "@/lib/pos-count-volume-ratio"

export interface CoordinationSettings {
  // ── Position-Count axes ─────────────────────────────────────────────
  axes: {
    prev:  { enabled: boolean; maxWindow: number }
    last:  { enabled: boolean; maxWindow: number }
    cont:  { enabled: boolean; maxWindow: number }
    pause: { enabled: boolean; maxWindow: number }
  }
  // ── Categorical variant profiles ────────────────────────────────────
  variants: {
    trailing: boolean
    block:    boolean
    dca:      boolean
  }
  // ── Block-strategy: completed-position block count × vol-ratio coordination ─
  // Knobs that flow into the Block variant's runtime size scaling.
  // Each valid Block count owns an absolute target from the general basis:
  //   targetVolume = generalVolume × (1 + blockCount × blockVolumeRatio)
  // Physical orders submit only the still-missing delta to that target.
  // for every blockCount in [1..blockMaxStack]. pause count is derived as
  // round(blockCount × blockPauseCountRatio).
  blockVolumeRatio: number // 0.25..3.0 per spec band (UI clamps; engine re-clamps)
  blockProfitFactorRatio: number // 0.2..5.0 × default PF × count volume increment
  blockMaxStack:    number // 1..10 block sizes processed independently
  strategyBlockMaterializationBatchSize: number // 64..10000, rotating work batch
  blockPauseCountRatio: number // 1..4, step 0.5
  blockActiveRealEnabled: boolean // active real-position Block overlay, default true
  blockActiveLiveEnabled: boolean // active live-position Block overlay, default true
  blockOnly: boolean // dispatch only Block rows while Block is enabled

  // Per-connection trailing matrix. Values use the canonical "start:stop"
  // encoding and are validated again by the engine before Base fan-out.
  trailingVariants: string[]

  /**
   * ── Position-Count (Pis) Sets volume ratio ───────────────────────
   * Operator coordination ratio applied ONLY to pos-count (axis) Sets.
   * Range 0.1..10 step 0.1, default 3. Ratio 10 maps to 0.02× Base
   * volume for each valid Set.
   * Backed by `connection_settings:{conn}.posCountsVolumeRatio`.
   */
  posCountsVolumeRatio: number
  // DCA is a sequential, price-triggered add-on ladder. Every volume is
  // relative to the confirmed initial position quantity (never the growing
  // aggregate), preventing exponential exposure growth.
  dcaMaxSteps: number // 1..4
  dcaStepVolumeMultipliers: number[] // four values, 0.1..2.5 × initial qty
  dcaStepDistancesPct: number[] // four monotonic adverse distances, 0.1..20%
  dcaTakeProfitMode: DcaTakeProfitMode
  dcaBreakevenProfitPct: number // 0.05..5%
  dcaCooldownSeconds: number // 0..3600 seconds between confirmed steps

  /**
   * ── Prev-PI threshold (operator spec) ──────────────────────────────
   *
   * Activation threshold for the historic-PI blend at Base stage and
   * the per-variant Real-stage tuner. Below this many CLOSED positions
   * in the (symbol × indicationType × direction) bucket, the engine
   * runs in BOOTSTRAP mode (= raw indication PF, no historic blend) so
   * fresh boots can produce trades immediately. At/above the threshold
   * the engine engages historic PF min-blend and Real-stage size/leverage
   * tuning. Default 5 = smallest statistically meaningful denominator.
   * Backed by `connection_settings:{conn}.prevPosMinCount`.
   */
  prevPosMinCount: number // 1..50, default 5

  /**
   * ── Base PF rolling-window size ─────────────────────────────────────
   * The eval gates average historic Profit Factor over the LAST N closed
   * positions of each (indication × direction) bucket — not the lifetime
   * mean. This is N. A tighter window reacts faster to a strategy that has
   * started degrading; a wider one is steadier but stickier. Must be ≥
   * prevPosMinCount to be meaningful (the blend only activates once a
   * bucket has prevPosMinCount samples). Range 5..200 step 5, default 25.
   * Backed by `connection_settings:{conn}.prevPosWindow`.
   */
  prevPosWindow: number

  /**
   * ── Main-stage validation min position-count ───────────────────────
   * Operator spec: At Main, only Base Sets whose `entryCount >=
   * mainEvalPosCount` are run through PF + DDT validation. Sets with
   * fewer completed pseudo-positions are SKIPPED (not counted as passed,
   * not promoted) — they re-enter the validation pool on subsequent
   * cycles once enough positions have closed.
   * Range 5..80 step 1, default 25.
   */
  mainEvalPosCount: number

  /**
   * ── Real-stage validation min position-count ───────────────────────
   * Same semantics as `mainEvalPosCount` but applied at Real (Main →
   * Real promotion). Range 5..80 step 1, default 20.
   */
  realEvalPosCount: number

  /** Inclusive lower bound of the exhaustive integer Base window grid. */
  minStep: number

  /**
   * Maximum stop-loss ratio included when creating Base pseudo-position Sets.
   * Range 0.25..2.5 step 0.25, default 2.5 (the max). Backed by
   * connection_settings:{conn}.maxStopLossRatio.
   */
  maxStopLossRatio: number

  /**
   * Minimum Base step-window size that is allowed to fan out into
   * independent trailing Sets. Backed by
   * connection_settings:{conn}.trailingMinStep.
   */
  trailingMinStep: number
}

/**
 * Operator-spec defaults.
 * - trailing: on, block: on, dca: off (per directive)
 * - minStep: 4 (default; exhaustive configured minimum through 30)
 * - maxStopLossRatio: 2.5 (default=max; range 0.25-2.5, step 0.25)
 * - trailingMinStep: 4 (default; range 2-30)
 * - PF defaults set in DEFAULT_STRATEGY_PROFILE (base=1.0, main/real=1.2)
 */
export const DEFAULT_COORDINATION_SETTINGS: CoordinationSettings = {
  axes: {
    prev:  { enabled: true,  maxWindow: 12 },
    last:  { enabled: true,  maxWindow: 4  },
    cont:  { enabled: true,  maxWindow: 8  },
    pause: { enabled: true,  maxWindow: 8  },
  },
  variants: {
    trailing: true,
    block:    true,
    dca:      false, // off by default per operator spec
  },
  blockVolumeRatio: 1.0,
  blockProfitFactorRatio: 0.8,
  blockMaxStack:    10,
  strategyBlockMaterializationBatchSize: 1024,
  blockPauseCountRatio: 1.0,
  blockActiveRealEnabled: true,
  blockActiveLiveEnabled: true,
  blockOnly: true,
  trailingVariants: [...DEFAULT_TRAILING_VARIANTS],
  posCountsVolumeRatio: POS_COUNT_VOLUME_RATIO_DEFAULT,
  dcaMaxSteps: DEFAULT_DCA_PROFILE.maxSteps,
  dcaStepVolumeMultipliers: [...DEFAULT_DCA_PROFILE.stepVolumeMultipliers],
  dcaStepDistancesPct: [...DEFAULT_DCA_PROFILE.stepDistancesPct],
  dcaTakeProfitMode: DEFAULT_DCA_PROFILE.takeProfitMode,
  dcaBreakevenProfitPct: DEFAULT_DCA_PROFILE.breakevenProfitPct,
  dcaCooldownSeconds: DEFAULT_DCA_PROFILE.cooldownSeconds,
  prevPosMinCount:   5,
  prevPosWindow:    25,
  mainEvalPosCount: 25,
  realEvalPosCount: 20,
  minStep:           DEFAULT_BASE_MIN_STEP,
  maxStopLossRatio:  2.5,
  trailingMinStep:   DEFAULT_BASE_MIN_STEP,
}

interface StrategyCoordinationSectionProps {
  value: CoordinationSettings
  onChange: (next: CoordinationSettings) => void
}

// Axis metadata — labels, spec ceilings, and short descriptions. Driven
// off this map so the JSX below stays compact and DRY.
const AXES: Array<{
  key: keyof CoordinationSettings["axes"]
  label: string
  range: string
  floor: number
  ceiling: number
  step: number
  description: string
}> = [
  {
    key: "prev",
    label: "Previous",
    range: "4–12 · step 2",
    floor: STRATEGY_AXIS_SPECS.prev.min,
    ceiling: STRATEGY_AXIS_SPECS.prev.max,
    step: STRATEGY_AXIS_SPECS.prev.step,
    description:
      "Closed-position PF lookback. Exact windows 4, 6, 8, 10 and 12 are evaluated independently.",
  },
  {
    key: "last",
    label: "Last (of previous)",
    range: "1–4",
    floor: STRATEGY_AXIS_SPECS.last.min,
    ceiling: STRATEGY_AXIS_SPECS.last.max,
    step: STRATEGY_AXIS_SPECS.last.step,
    description:
      "Magnitude of the last-N wins / losses dimension. Drives trailing aggressiveness and the pause count-axis.",
  },
  {
    key: "cont",
    label: "Continuous",
    range: "1–8",
    floor: STRATEGY_AXIS_SPECS.cont.min,
    ceiling: STRATEGY_AXIS_SPECS.cont.max,
    step: STRATEGY_AXIS_SPECS.cont.step,
    description:
      "Open continuous positions. Larger windows allow longer add-on stacks before the gate closes.",
  },
  {
    key: "pause",
    label: "Position-count Pause",
    range: "1–8",
    floor: STRATEGY_AXIS_SPECS.pause.min,
    ceiling: STRATEGY_AXIS_SPECS.pause.max,
    step: STRATEGY_AXIS_SPECS.pause.step,
    description:
      "Last-N count window used to pause/calibrate further position-count calculations. This stays under axis semantics and is not a dispatchable strategy variant.",
  },
]

const VARIANTS: Array<{
  key: keyof CoordinationSettings["variants"]
  label: string
  badge: string
  axisIndependent: boolean
  description: string
}> = [
  {
    key: "trailing",
    label: "Trailing",
    badge: "Recent winners",
    axisIndependent: false,
    description:
      "Scale-in profile for runs of recent winners with no open position. Higher leverage, longer DDT bias.",
  },
  {
    key: "block",
    label: "Block",
    badge: "Independent · Add-on",
    axisIndependent: true,
    description:
      "Completed-position recovery profile that processes every configured block count independently over the selected Set.",
  },
  {
    key: "dca",
    label: "DCA",
    badge: "Independent · Recovery",
    axisIndependent: true,
    description:
      "Recovery profile after recent losses (prevLosses ≥ 1). Reduce / close states with conservative sizing. Evaluated INDEPENDENTLY of position-count axes.",
  },
]

export function StrategyCoordinationSection({
  value,
  onChange,
}: StrategyCoordinationSectionProps) {
  // ── Helpers ─ partial setters for axes & variants. Keeping the
  // mutator surface inline (rather than reducer / context) keeps the
  // component drop-in for the existing dialog's controlled-state
  // pattern.
  const setAxis = (
    key: keyof CoordinationSettings["axes"],
    patch: Partial<{ enabled: boolean; maxWindow: number }>,
  ) => {
    onChange({
      ...value,
      axes: {
        ...value.axes,
        [key]: { ...value.axes[key], ...patch },
      },
    })
  }

  const setVariant = (
    key: keyof CoordinationSettings["variants"],
    enabled: boolean,
  ) => {
    onChange({
      ...value,
      variants: { ...value.variants, [key]: enabled },
    })
  }

  const enabledTrailingVariants = new Set(value.trailingVariants || [])
  const setTrailingVariants = (next: Set<string>) => {
    onChange({
      ...value,
      trailingVariants: ALL_TRAILING_VARIANTS.filter((key) => next.has(key)),
    })
  }
  const toggleTrailingVariant = (start: number, stop: number) => {
    const key = trailingVariantKey(start, stop)
    const next = new Set(enabledTrailingVariants)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setTrailingVariants(next)
  }
  const updateDcaArray = (
    key: "dcaStepVolumeMultipliers" | "dcaStepDistancesPct",
    index: number,
    nextValue: number,
  ) => {
    const next = [...value[key]]
    next[index] = nextValue
    onChange({ ...value, [key]: next })
  }

  return (
    <div className="space-y-4">
      {/* ── Position-Count Axes card ─────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">Position-Count Axes</CardTitle>
              <CardDescription className="text-xs">
                Canonical windows that gate Main-stage related Set creation. Each
                validated Base Set fans out into related Sets across these
                axes. Counts surface in the dashboard&apos;s axis strip.
              </CardDescription>
            </div>
            <Badge variant="secondary" className="text-[10px]">
              4 axes
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {AXES.map((axis) => {
            const state = value.axes[axis.key]
            return (
              <div
                key={axis.key}
                className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Label className="text-sm font-semibold capitalize">
                      {axis.label}
                    </Label>
                    <Badge variant="outline" className="text-[10px] tabular-nums">
                      {axis.range}
                    </Badge>
                  </div>
                  <Switch
                    checked={state.enabled}
                    onCheckedChange={(checked) =>
                      setAxis(axis.key, { enabled: checked })
                    }
                  />
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {axis.description}
                </p>
                <div className="flex items-center gap-3 pt-1">
                  <Label className="text-xs text-muted-foreground min-w-[80px]">
                    Max window
                  </Label>
                  <Slider
                    value={[state.maxWindow]}
                    min={axis.floor}
                    max={axis.ceiling}
                    step={axis.step}
                    onValueChange={(v) =>
                      setAxis(axis.key, { maxWindow: v[0] })
                    }
                    disabled={!state.enabled}
                    className="flex-1"
                  />
                  <span className="text-xs font-semibold tabular-nums w-8 text-right">
                    {state.maxWindow}
                  </span>
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>

      {/* ── Trailing matrix ─────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-sm">Trailing — Independent Start × Stop Profiles</CardTitle>
              <CardDescription className="text-xs">
                Each selected pair creates one independent Base Set. Start is
                the favourable activation gain; stop is the trailing distance;
                the ratchet step is always half the stop distance. The engine
                deduplicates and caps this matrix at 25 profiles.
              </CardDescription>
            </div>
            <Badge variant={value.variants.trailing ? "default" : "outline"} className="text-[10px]">
              {value.variants.trailing ? `${enabledTrailingVariants.size}/25 active` : "Disabled"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!value.variants.trailing || enabledTrailingVariants.size === 25}
              onClick={() => setTrailingVariants(new Set(ALL_TRAILING_VARIANTS))}
            >
              Enable all
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!value.variants.trailing || enabledTrailingVariants.size === 0}
              onClick={() => setTrailingVariants(new Set())}
            >
              Disable matrix
            </Button>
          </div>
          <div className={value.variants.trailing ? "space-y-2" : "pointer-events-none space-y-2 opacity-50"}>
            {TRAILING_START_RATIOS.map((start) => (
              <div key={start} className="rounded-lg border border-border/60 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <Label className="text-xs font-semibold tabular-nums">
                    Start {(start * 100).toFixed(0)}%
                  </Label>
                  <span className="text-[10px] text-muted-foreground">Stop distance · step = stop / 2</span>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {TRAILING_STOP_RATIOS.map((stop) => {
                    const key = trailingVariantKey(start, stop)
                    const checked = enabledTrailingVariants.has(key)
                    return (
                      <label
                        key={key}
                        className={`flex cursor-pointer items-center gap-2 rounded-md border px-2 py-2 text-[11px] ${checked ? "border-primary/40 bg-primary/5" : "border-border/60"}`}
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggleTrailingVariant(start, stop)}
                        />
                        <span className="font-mono">{(stop * 100).toFixed(0)}%</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── Position-Count Cartesian Fan-out (read-only spec) ────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">
                Position-Count Sets — Cartesian Fan-out
              </CardTitle>
              <CardDescription className="text-xs">
                Each validated Base Set fans out at Main into additional
                Position-Count Sets along three axes plus a direction split.{" "}
                <strong>Previous</strong> is a PF filter — only emits when the
                mean PF of the last N completed positions meets Main&apos;s
                threshold. <strong>Last</strong> tags each Set by outcome
                (positive / negative aggregate of last M completed
                positions). <strong>Continuous</strong> contributes to
                position count:{" "}
                <span className="font-mono text-[11px]">
                  entries = base + cont
                </span>
                . Open positions are excluded — only completed ones count.
                Real-stage hedge-netting collapses bucket{" "}
                <span className="font-mono text-[11px]">
                  (symbol × indication × triple × outcome)
                </span>{" "}
                to the dominant direction; Live opens/closes partial
                positions on hedge-count deltas.
              </CardDescription>
            </div>
            <Badge variant="secondary" className="text-[10px]">
              5 × 4 × 8 × 2
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
            <div className="rounded-md border border-border/60 p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold">Previous</div>
                <Badge variant="outline" className="text-[9px] tabular-nums">
                  PF filter
                </Badge>
              </div>
              <div className="text-muted-foreground tabular-nums">
                4 → 12 step 2
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">
                4, 6, 8, 10, 12
              </div>
            </div>
            <div className="rounded-md border border-border/60 p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold">Last</div>
                <Badge variant="outline" className="text-[9px] tabular-nums">
                  pos / neg
                </Badge>
              </div>
              <div className="text-muted-foreground tabular-nums">
                1 → 4 step 1
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">
                1, 2, 3, 4
              </div>
            </div>
            <div className="rounded-md border border-border/60 p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold">Continuous</div>
                <Badge variant="outline" className="text-[9px] tabular-nums">
                  pos count
                </Badge>
              </div>
              <div className="text-muted-foreground tabular-nums">
                1 → 8 step 1
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">
                1, 2, …, 8
              </div>
            </div>
            <div className="rounded-md border border-border/60 p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold">Direction</div>
                <Badge variant="outline" className="text-[9px] tabular-nums">
                  Cartesian
                </Badge>
              </div>
              <div className="text-muted-foreground tabular-nums">2 values</div>
              <div className="font-mono text-[11px] text-muted-foreground">
                long, short
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed pt-1">
            Worst-case fan-out per Base = 5 × 4 × 8 × 2 ={" "}
            <strong>320</strong> Sets. Typical (prev PF-filter rejects ~half;
            last single-outcome-tagged): ≈ 128–192. After Real hedge-net
            cancellation: ≈ 96 surviving Sets per Base reaching Live. No
            lock — recompute every cycle; hedge-count deltas drive partial
            open/close at Live.
          </p>
        </CardContent>
      </Card>

      {/* ── DCA tuning card ─────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-sm">DCA — Sequential Price-Triggered Ladder</CardTitle>
              <CardDescription className="text-xs">
                DCA only adds to an already-confirmed Standard/Trailing parent.
                Steps trigger sequentially on an adverse move from the original
                entry. Each quantity is based on the initial confirmed size,
                which keeps exposure deterministic after every restart.
              </CardDescription>
            </div>
            <Badge variant={value.variants.dca ? "default" : "outline"} className="text-[10px]">
              {value.variants.dca ? "Active" : "Disabled"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className={value.variants.dca ? "space-y-4" : "pointer-events-none space-y-4 opacity-50"}>
          <div className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label className="text-sm font-semibold">Maximum Steps</Label>
                <p className="text-xs text-muted-foreground">Only the next unfinished step can submit an order.</p>
              </div>
              <Badge variant="outline" className="text-[10px] tabular-nums">1–4</Badge>
            </div>
            <div className="flex items-center gap-3">
              <Slider
                min={1}
                max={4}
                step={1}
                value={[value.dcaMaxSteps]}
                onValueChange={([next]) => onChange({ ...value, dcaMaxSteps: next })}
                className="flex-1"
              />
              <span className="w-8 text-right text-xs font-semibold tabular-nums">{value.dcaMaxSteps}</span>
            </div>
          </div>

          <div className="space-y-2">
            {Array.from({ length: value.dcaMaxSteps }, (_, index) => (
              <div key={index} className="rounded-lg border border-border/60 p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-semibold">Step {index + 1}</Label>
                  <span className="text-[10px] text-muted-foreground font-mono">
                    +{value.dcaStepVolumeMultipliers[index].toFixed(2)}× initial at −{value.dcaStepDistancesPct[index].toFixed(2)}%
                  </span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-[11px]"><span>Volume multiplier</span><span>{value.dcaStepVolumeMultipliers[index].toFixed(2)}×</span></div>
                    <Slider
                      min={0.1}
                      max={2.5}
                      step={0.1}
                      value={[value.dcaStepVolumeMultipliers[index]]}
                      onValueChange={([next]) => updateDcaArray("dcaStepVolumeMultipliers", index, Number(next.toFixed(2)))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-[11px]"><span>Adverse distance</span><span>{value.dcaStepDistancesPct[index].toFixed(2)}%</span></div>
                    <Slider
                      min={0.1}
                      max={20}
                      step={0.1}
                      value={[value.dcaStepDistancesPct[index]]}
                      onValueChange={([next]) => updateDcaArray("dcaStepDistancesPct", index, Number(next.toFixed(2)))}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-border/60 p-3 space-y-3">
            <Label className="text-sm font-semibold">Take-Profit Reference</Label>
            <div className="grid gap-2 sm:grid-cols-3">
              {([
                ["average", "Average entry"],
                ["first_entry", "First entry"],
                ["breakeven_plus", "Breakeven +"],
              ] as Array<[DcaTakeProfitMode, string]>).map(([mode, label]) => (
                <Button
                  key={mode}
                  type="button"
                  size="sm"
                  variant={value.dcaTakeProfitMode === mode ? "default" : "outline"}
                  onClick={() => onChange({ ...value, dcaTakeProfitMode: mode })}
                >
                  {label}
                </Button>
              ))}
            </div>
            {value.dcaTakeProfitMode === "breakeven_plus" && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-[11px]"><span>Profit above breakeven</span><span>{value.dcaBreakevenProfitPct.toFixed(2)}%</span></div>
                <Slider
                  min={0.05}
                  max={5}
                  step={0.05}
                  value={[value.dcaBreakevenProfitPct]}
                  onValueChange={([next]) => onChange({ ...value, dcaBreakevenProfitPct: Number(next.toFixed(2)) })}
                />
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex justify-between gap-3">
              <div>
                <Label className="text-sm font-semibold">Confirmed-Step Cooldown</Label>
                <p className="text-xs text-muted-foreground">Prevents multiple levels from firing in one fast price cascade.</p>
              </div>
              <span className="text-xs font-semibold tabular-nums">{value.dcaCooldownSeconds}s</span>
            </div>
            <Slider
              min={0}
              max={3600}
              step={15}
              value={[value.dcaCooldownSeconds]}
              onValueChange={([next]) => onChange({ ...value, dcaCooldownSeconds: next })}
            />
          </div>
        </CardContent>
      </Card>

      {/* ── Variant profiles card ────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">Variant Profiles</CardTitle>
              <CardDescription className="text-xs">
                Categorical Set variants evaluated alongside the axes above.
                Block and DCA are evaluated <em>independently</em> of the
                position-count axes per spec.
              </CardDescription>
            </div>
            <Badge variant="secondary" className="text-[10px]">
              3 variants
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {VARIANTS.map((variant) => {
            const enabled = value.variants[variant.key]
            return (
              <div
                key={variant.key}
                className="flex items-start justify-between gap-3 rounded-lg border border-border/60 p-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Label className="text-sm font-semibold capitalize">
                      {variant.label}
                    </Label>
                    <Badge
                      variant={variant.axisIndependent ? "default" : "outline"}
                      className="text-[10px]"
                    >
                      {variant.badge}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed mt-1">
                    {variant.description}
                  </p>
                </div>
                <Switch
                  checked={enabled}
                  onCheckedChange={(checked) =>
                    setVariant(variant.key, checked)
                  }
                />
              </div>
            )
          })}
        </CardContent>
      </Card>

      {/* ── Block tuning card ────────────────────────────────────────
          Completed-position Block coordination knobs:
            • Volume-ratio slider → absolute target from the general volume
            • Max-stack stepper   → number of independent block counts
            • Pause ratio         → post-success pause window per block count */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">
                Block — Completed Position Count × Vol-Ratio
              </CardTitle>
              <CardDescription className="text-xs">
                Calculates every valid Block target independently from the
                immutable general position volume. The total target follows{" "}
                <span className="font-mono text-[11px]">
                  total = base + ((base × ratio) × block count)
                </span>{" "}
                while each order sends only the missing delta. Every count up
                to <strong>max stack</strong> keeps independent evaluation,
                result and pause state.
              </CardDescription>
            </div>
            <Badge
              variant={value.variants.block ? "default" : "outline"}
              className="text-[10px]"
            >
              {value.variants.block ? "Active" : "Disabled"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border border-primary/25 bg-primary/5 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1">
                <Label className="text-sm font-semibold">Block-Only execution</Label>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Enabled systemwide by default. With Block active, only evaluated
                  Block Rows reach exchange dispatch. Disable this to run the
                  Standard and Block strategies concurrently. If Block itself is
                  disabled, Standard execution remains available.
                </p>
              </div>
              <Switch
                checked={value.blockOnly}
                onCheckedChange={(checked) => onChange({ ...value, blockOnly: checked })}
                disabled={!value.variants.block}
              />
            </div>
          </div>
          {/* Volume ratio */}
          <div className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label className="text-sm font-semibold">Volume Ratio</Label>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Additive step applied to the immutable general volume. Earlier
                  confirmed Block fills are subtracted from the next target, so
                  valid Counts never compound or over-add. Engine clamps this
                  setting to 0.25–3.0 even if the UI is bypassed.
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground leading-relaxed">
                  Regular ladders use Base-derived Sets only, never Pos-Count
                  Sets. Active Real counts remain separate and include active
                  Pos-Count positions for the same symbol and direction.
                </p>
              </div>
              <Badge variant="outline" className="text-[10px] tabular-nums">
                0.25–3.0
              </Badge>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Slider
                value={[value.blockVolumeRatio]}
                min={0.25}
                max={3.0}
                step={0.05}
                onValueChange={(v) =>
                  onChange({ ...value, blockVolumeRatio: Number(v[0].toFixed(2)) })
                }
                disabled={!value.variants.block}
                className="flex-1"
              />
              <span className="text-xs font-semibold tabular-nums w-10 text-right">
                {value.blockVolumeRatio.toFixed(2)}×
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-1 text-[11px]">
              {[1, 2, 3].map((n) => {
                const mul = n * value.blockVolumeRatio
                return (
                  <div
                    key={n}
                    className="rounded-md border border-border/60 p-2 flex items-center justify-between gap-2"
                  >
                    <span className="text-muted-foreground">
                      block={n}
                    </span>
                    <span className="font-mono tabular-nums font-semibold">
                      {(1 + mul).toFixed(2)}× total
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Count-specific ProfitFactor ratio */}
          <div className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label className="text-sm font-semibold">ProfitFactor</Label>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Minimum PF factor calculated separately for every Block
                  count: Default PF × this factor × that count&apos;s actual
                  volume increment. The same latest-position window as the
                  source/default calculation is used. Default 0.8.
                </p>
              </div>
              <Badge variant="outline" className="text-[10px] tabular-nums">
                0.2–5.0
              </Badge>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Slider
                value={[value.blockProfitFactorRatio]}
                min={0.2}
                max={5}
                step={0.1}
                onValueChange={(v) =>
                  onChange({ ...value, blockProfitFactorRatio: Number(v[0].toFixed(1)) })
                }
                disabled={!value.variants.block}
                className="flex-1"
              />
              <span className="text-xs font-semibold tabular-nums w-10 text-right">
                {value.blockProfitFactorRatio.toFixed(1)}×
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-1 text-[11px]">
              {[1, 2, 3].map((count) => (
                <div key={count} className="rounded-md border border-border/60 p-2">
                  <span className="text-muted-foreground">Block {count}</span>
                  <p className="mt-0.5 font-mono font-semibold tabular-nums">
                    PF × {(value.blockProfitFactorRatio * count * value.blockVolumeRatio).toFixed(2)}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Active Real position overlay */}
          <div className="rounded-lg border border-border/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1">
                <Label className="text-sm font-semibold">Active Real Position Block</Label>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Adds an independent Block overlay for currently running Real-stage
                  positions, separate from completed-position block-count calcs.
                </p>
              </div>
              <Switch
                checked={value.blockActiveRealEnabled}
                onCheckedChange={(checked) =>
                  onChange({ ...value, blockActiveRealEnabled: checked })
                }
                disabled={!value.variants.block}
              />
            </div>
          </div>

          {/* Active live position overlay */}
          <div className="rounded-lg border border-border/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1">
                <Label className="text-sm font-semibold">Active Live Position Block</Label>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Adds an independent Block overlay for currently running live
                  positions, separate from completed-position block-count calcs.
                </p>
              </div>
              <Switch
                checked={value.blockActiveLiveEnabled}
                onCheckedChange={(checked) =>
                  onChange({ ...value, blockActiveLiveEnabled: checked })
                }
                disabled={!value.variants.block}
              />
            </div>
          </div>

          {/* Max stack */}
          <div className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label className="text-sm font-semibold">Max Stack</Label>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Number of independent Block sizes processed in parallel.
                  Default 10 emits all block counts 1 through 10. Engine clamps to 1–10.
                </p>
              </div>
              <Badge variant="outline" className="text-[10px] tabular-nums">
                1–10
              </Badge>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Slider
                value={[value.blockMaxStack]}
                min={1}
                max={10}
                step={1}
                onValueChange={(v) =>
                  onChange({ ...value, blockMaxStack: v[0] })
                }
                disabled={!value.variants.block}
                className="flex-1"
              />
              <span className="text-xs font-semibold tabular-nums w-8 text-right">
                {value.blockMaxStack}
              </span>
            </div>
          </div>

          {/* Exhaustive logical calculation with bounded rotating materialization. */}
          <div className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label className="text-sm font-semibold">Rotating Real/Live Work Batch</Label>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Materializes this many inactive Block rows per cycle. Every
                  source × symbol × direction × config × count combination is
                  still evaluated and counted; the cursor visits every valid
                  row and active exposure always bypasses the batch.
                </p>
              </div>
              <Badge variant="outline" className="text-[10px] tabular-nums">
                64–10,000
              </Badge>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Slider
                value={[value.strategyBlockMaterializationBatchSize]}
                min={64}
                max={10000}
                step={64}
                onValueChange={([next]) =>
                  onChange({
                    ...value,
                    strategyBlockMaterializationBatchSize: next,
                  })
                }
                disabled={!value.variants.block}
                className="flex-1"
              />
              <span className="text-xs font-semibold tabular-nums w-14 text-right">
                {value.strategyBlockMaterializationBatchSize.toLocaleString()}
              </span>
            </div>
          </div>

          {/* Pause count ratio */}
          <div className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label className="text-sm font-semibold">Pause Count Ratio</Label>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Converts each Block count into a post-success pause/cooldown
                  window: pause = round(block count × ratio). Default 1.0.
                </p>
              </div>
              <Badge variant="outline" className="text-[10px] tabular-nums">
                1–4 · step 0.5
              </Badge>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Slider
                value={[value.blockPauseCountRatio]}
                min={1}
                max={4}
                step={0.5}
                onValueChange={(v) =>
                  onChange({ ...value, blockPauseCountRatio: Number(v[0].toFixed(1)) })
                }
                disabled={!value.variants.block}
                className="flex-1"
              />
              <span className="text-xs font-semibold tabular-nums w-10 text-right">
                {value.blockPauseCountRatio.toFixed(1)}×
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Position-Count coordination ratio. The 0.1..10 operator value is
          converted to a direct per-valid-Set multiplier (10 → 0.02). */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">
                Position-Count (Pis) Sets Volume Ratio
              </CardTitle>
              <CardDescription className="text-xs">
                Coordination ratio for every independently valid additional
                Main Position-Count Set.
              </CardDescription>
            </div>
            <Badge variant="outline" className="text-[10px] tabular-nums">
              0.1–10
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label className="text-sm font-semibold">Pis Volume Ratio</Label>
              <span className="text-xs font-semibold tabular-nums w-12 text-right">
                {value.posCountsVolumeRatio.toFixed(1)}
              </span>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Slider
                value={[value.posCountsVolumeRatio]}
                min={POS_COUNT_VOLUME_RATIO_MIN}
                max={POS_COUNT_VOLUME_RATIO_MAX}
                step={POS_COUNT_VOLUME_RATIO_STEP}
                onValueChange={(v) =>
                  onChange({ ...value, posCountsVolumeRatio: Number(v[0].toFixed(1)) })
                }
                className="flex-1"
              />
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Per valid Set: {posCountVolumeRatioToSetMultiplier(value.posCountsVolumeRatio).toFixed(4)}×
              Base volume. At ratio 10, 300 valid Sets coordinate to 6× Base
              volume before the exchange minimum-volume floor.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* ── Prev-PI Influence card ───────────────────────────────────
          Operator spec: "make sure strategies are evaluating prev pis
          and profitfactors min from historic … prev pis cnts are
          working and added to settings,strategy".

          One number — the activation threshold below which the engine
          runs in BOOTSTRAP mode (raw indication PF, no historic blend).
          At/above the threshold, Base avgProfitFactor becomes the MIN
          of (live PF, historic PF) and Real-stage size/leverage tuning
          activates per (symbol × indicationType × direction). */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">
                Prev-PI Influence — Historic Blend Threshold
              </CardTitle>
              <CardDescription className="text-xs">
                Activation gate for the historic-PF blend at Base and the
                Real-stage size/leverage tuner. Below this many CLOSED
                positions in the{" "}
                <span className="font-mono text-[11px]">
                  (symbol × indicationType × direction)
                </span>{" "}
                bucket the engine runs in <strong>bootstrap</strong> mode
                (raw indication PF, no blend) so fresh boots can produce
                trades immediately. At/above the threshold the engine
                MIN-blends realised PF into{" "}
                <span className="font-mono text-[11px]">
                  avgProfitFactor
                </span>{" "}
                — historic underperformance pulls the bar down so Base
                → Main filters reject it. Default 5 = smallest
                statistically meaningful denominator.
              </CardDescription>
            </div>
            <Badge variant="outline" className="text-[10px] tabular-nums">
              1–50
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label className="text-sm font-semibold">
                Min closed positions for blend
              </Label>
              <Badge variant="secondary" className="text-[10px] tabular-nums">
                default 5
              </Badge>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Slider
                value={[value.prevPosMinCount]}
                min={1}
                max={50}
                step={1}
                onValueChange={(v) =>
                  onChange({ ...value, prevPosMinCount: v[0] })
                }
                className="flex-1"
              />
              <span className="text-xs font-semibold tabular-nums w-8 text-right">
                {value.prevPosMinCount}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed pt-1">
              Lower = engages historic blend faster (small samples can be
              noisy). Higher = waits for more data before letting history
              influence current decisions. The Real-stage tuner uses the
              same threshold to gate per-variant size/leverage adjustments
              (Block size scaling, DCA leverage capping, Pos-coord axis
              size). Counts and live status are surfaced on the Strategy
              Pipeline dashboard tile.
            </p>
          </div>

          {/* Cumulative last-N window — feeds BOTH windowed PF and DDT */}
          <div className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label className="text-sm font-semibold">
                PF / DDT window (last N positions)
              </Label>
              <Badge variant="secondary" className="text-[10px] tabular-nums">
                default 25
              </Badge>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Slider
                value={[value.prevPosWindow]}
                min={5}
                max={200}
                step={5}
                onValueChange={(v) =>
                  onChange({ ...value, prevPosWindow: v[0] })
                }
                className="flex-1"
              />
              <span className="text-xs font-semibold tabular-nums w-10 text-right">
                {value.prevPosWindow}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed pt-1">
              One cumulative window over the{" "}
              <strong>last N completed positions</strong> of each (indication ×
              direction) bucket. Both the historic Profit Factor and the
              average Drawdown-Time are computed over this same sample — not the
              lifetime mean. A tighter window reacts faster when a strategy
              starts degrading; a wider window is steadier but slower to demote
              a fading Set. Should be ≥ the min-blend threshold above.
            </p>
          </div>
        </CardContent>
      </Card>
      {/* ── Stage Validation Position-Count card ─────────────────────
          Operator spec:
            • Main evaluates Base with PF + DDT for X pre pseudo
              positions per Set (min positions to validate). Default 25.
            • Real evaluates Main the same way. Default 20.
          If a Set has fewer positions than the threshold it is SKIPPED
          (not validated, not promoted, no count bump) — re-evaluated
          on subsequent cycles once enough positions accumulate. */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">
                Stage Validation — Min Positions per Set
              </CardTitle>
              <CardDescription className="text-xs">
                Minimum completed pseudo-positions a Set must contain
                before its <strong>profit-factor</strong> and{" "}
                <strong>drawdown-time</strong> are evaluated for promotion
                to the next stage. Below the threshold the Set is
                <em> skipped</em> (not validated, not counted) — it
                re-enters the validation pool on subsequent cycles once
                enough positions have closed. Drawdown-time ceiling at
                Main + Real is <strong>5 hours</strong>.
              </CardDescription>
            </div>
            <Badge variant="outline" className="text-[10px] tabular-nums">
              8–80 step 2
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Main */}
          <div className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label className="text-sm font-semibold">
                  Main — Min positions to validate
                </Label>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Base → Main: a Base Set is validated against{" "}
                  <span className="font-mono text-[11px]">minPF</span> and{" "}
                  <span className="font-mono text-[11px]">maxDDT (5h)</span>{" "}
                  only when its entry count meets this threshold.
                </p>
              </div>
              <Badge variant="secondary" className="text-[10px] tabular-nums">
                default 25
              </Badge>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Slider
                value={[value.mainEvalPosCount]}
                min={8}
                max={80}
                step={2}
                onValueChange={(v) =>
                  onChange({ ...value, mainEvalPosCount: v[0] })
                }
                className="flex-1"
              />
              <span className="text-xs font-semibold tabular-nums w-8 text-right">
                {value.mainEvalPosCount}
              </span>
            </div>
          </div>
          {/* Real */}
          <div className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label className="text-sm font-semibold">
                  Real — Min positions to validate
                </Label>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Main → Real: a Main Set is validated against{" "}
                  <span className="font-mono text-[11px]">minPF</span> and{" "}
                  <span className="font-mono text-[11px]">maxDDT (5h)</span>{" "}
                  only when its entry count meets this threshold.
                </p>
              </div>
              <Badge variant="secondary" className="text-[10px] tabular-nums">
                default 20
              </Badge>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Slider
                value={[value.realEvalPosCount]}
                min={8}
                max={80}
                step={2}
                onValueChange={(v) =>
                  onChange({ ...value, realEvalPosCount: v[0] })
                }
                className="flex-1"
              />
              <span className="text-xs font-semibold tabular-nums w-8 text-right">
                {value.realEvalPosCount}
              </span>
            </div>
          </div>

        </CardContent>
      </Card>

      {/* Configurable lower bound; generation remains exhaustive. */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">
                Minimal Base Pseudo-Position Range Step
              </CardTitle>
              <CardDescription className="text-xs">
                Base creates and evaluates every integer step from this
                configured lower bound through 30.
              </CardDescription>
            </div>
            <Badge variant="outline" className="text-[10px] tabular-nums">
              {value.minStep}–30, step 1
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label className="text-sm font-semibold">
                Min position-creation step
              </Label>
              <Badge variant="secondary" className="text-[10px] tabular-nums">
                exhaustive
              </Badge>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Slider
                value={[value.minStep]}
                min={MIN_BASE_STEP}
                max={MAX_BASE_STEP}
                step={1}
                onValueChange={([next]) => onChange({
                  ...value,
                  minStep: next,
                  trailingMinStep: Math.max(next, value.trailingMinStep),
                })}
                className="flex-1"
              />
              <span className="text-sm font-semibold tabular-nums w-8 text-right">
                {value.minStep}
              </span>
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground pt-0.5">
              <span>{MIN_BASE_STEP}</span>
              <span className="text-muted-foreground/60">
                all {MAX_BASE_STEP - value.minStep + 1} windows
              </span>
              <span>30 (included)</span>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed pt-1">
              Generated steps: {value.minStep}, {Math.min(30, value.minStep + 1)},
              {Math.min(30, value.minStep + 2)}, …, 29, 30. Concurrency controls
              only scheduling; it never reduces this configuration space.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

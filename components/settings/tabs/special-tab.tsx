"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  DEFAULT_SPECIAL_STRATEGY_SETTINGS as defaults,
  SPECIAL_MAX_HOLDING_SECONDS,
  SPECIAL_MAX_POSITIONS_PER_DIRECTION,
  SPECIAL_MAX_SL_TO_TP_RATIO,
  SPECIAL_MAX_VOLUME_RATIO,
  SPECIAL_MIN_STEP,
} from "@/lib/special-strategy"

interface SpecialTabProps {
  settings: Record<string, any>
  handleSettingChange: (key: string, value: any) => void
}

function NumberField({
  settings,
  onChange,
  settingKey,
  label,
  fallback,
  min,
  max,
  step = 1,
  suffix,
  disabled = false,
}: {
  settings: Record<string, any>
  onChange: (key: string, value: any) => void
  settingKey: string
  label: string
  fallback: number
  min?: number
  max?: number
  step?: number
  suffix?: string
  disabled?: boolean
}) {
  const value = Number(settings[settingKey] ?? fallback)
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={settingKey}>{label}</Label>
        {suffix ? <span className="text-xs text-muted-foreground">{suffix}</span> : null}
      </div>
      <Input
        id={settingKey}
        type="number"
        value={Number.isFinite(value) ? value : fallback}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => onChange(settingKey, Number(event.target.value))}
      />
    </div>
  )
}

function ToggleField({
  settings,
  onChange,
  settingKey,
  label,
  fallback,
  description,
}: {
  settings: Record<string, any>
  onChange: (key: string, value: any) => void
  settingKey: string
  label: string
  fallback: boolean
  description?: string
}) {
  const checked = settings[settingKey] === undefined ? fallback : Boolean(settings[settingKey])
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
      <div className="space-y-1">
        <Label htmlFor={settingKey}>{label}</Label>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <Switch
        id={settingKey}
        checked={checked}
        onCheckedChange={(value) => onChange(settingKey, value)}
      />
    </div>
  )
}

const grid = "grid gap-4 md:grid-cols-2 xl:grid-cols-4"

export function SpecialTab({ settings, handleSettingChange }: SpecialTabProps) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Special</CardTitle>
          <CardDescription>
            Independent Long/Short market-change lanes with multi-timeframe coordination,
            bounded logical legs, active protection and purged walk-forward release gates.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ToggleField settings={settings} onChange={handleSettingChange} settingKey="specialEnabled" label="Enable Special" fallback={defaults.enabled} />
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
            Non-bypassable limits: minimum calculation step {SPECIAL_MIN_STEP}, maximum {SPECIAL_MAX_POSITIONS_PER_DIRECTION} logical positions per direction,
            total Special volume ≤ {SPECIAL_MAX_VOLUME_RATIO}×, SL distance ≤ {SPECIAL_MAX_SL_TO_TP_RATIO}× TP distance,
            absolute holding time ≤ {SPECIAL_MAX_HOLDING_SECONDS / 60} minutes.
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Timeframes and coordination</CardTitle>
          <CardDescription>Each timeframe calculates Long and Short separately. Combined configs emit at most one winning direction.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <ToggleField settings={settings} onChange={handleSettingChange} settingKey="specialTimeframe15sEnabled" label="15 seconds" fallback={defaults.timeframe15sEnabled} description="Requires real ≤15 s observations; never synthesized from 1 m candles." />
            <ToggleField settings={settings} onChange={handleSettingChange} settingKey="specialTimeframe1mEnabled" label="1 minute" fallback={defaults.timeframe1mEnabled} />
            <ToggleField settings={settings} onChange={handleSettingChange} settingKey="specialTimeframe15mEnabled" label="15 minutes" fallback={defaults.timeframe15mEnabled} />
            <ToggleField settings={settings} onChange={handleSettingChange} settingKey="specialTimeframe30mEnabled" label="30 minutes" fallback={defaults.timeframe30mEnabled} />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <ToggleField settings={settings} onChange={handleSettingChange} settingKey="specialIndividualTimeframesEnabled" label="Individual timeframe configs" fallback={defaults.individualTimeframesEnabled} />
            <ToggleField settings={settings} onChange={handleSettingChange} settingKey="specialCombinedTimeframesEnabled" label="Combined timeframe configs" fallback={defaults.combinedTimeframesEnabled} />
            <ToggleField settings={settings} onChange={handleSettingChange} settingKey="specialRequireHigherTimeframeAlignment" label="Require 15 m / 30 m alignment" fallback={defaults.requireHigherTimeframeAlignment} description="Fail closed if no enabled higher timeframe confirms the selected direction." />
          </div>
          <div className={grid}>
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMinimumTimeframeConfirmations" label="Minimum confirmations" fallback={defaults.minimumTimeframeConfirmations} min={1} max={4} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMinimumCombinedScoreMargin" label="Winner score margin" fallback={defaults.minimumCombinedScoreMargin} min={0} max={100} step={0.01} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialTimeframe15sWeight" label="15 s weight" fallback={defaults.timeframe15sWeight} min={0.01} max={10} step={0.05} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialTimeframe1mWeight" label="1 m weight" fallback={defaults.timeframe1mWeight} min={0.01} max={10} step={0.05} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialTimeframe15mWeight" label="15 m weight" fallback={defaults.timeframe15mWeight} min={0.01} max={10} step={0.05} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialTimeframe30mWeight" label="30 m weight" fallback={defaults.timeframe30mWeight} min={0.01} max={10} step={0.05} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Direction and market activity</CardTitle>
          <CardDescription>Momentum, volume activity, order flow, volatility and market-change speed per second.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className={grid}>
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMinStep" label="Minimum step" fallback={defaults.minStep} min={SPECIAL_MIN_STEP} max={120} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMaxStep" label="Maximum step" fallback={defaults.maxStep} min={SPECIAL_MIN_STEP} max={240} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialStepSize" label="Step size" fallback={defaults.stepSize} min={1} max={120} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialActiveWindow" label="Active window" fallback={defaults.activeWindow} min={SPECIAL_MIN_STEP} max={120} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMinimumEvidence" label="Minimum evidence" fallback={defaults.minimumEvidence} min={1} max={120} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMinimumAgreement" label="Directional agreement" fallback={defaults.minimumAgreement} min={0.5} max={1} step={0.01} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMinimumMarketChangePct" label="Minimum market change" fallback={defaults.minimumMarketChangePct} min={0} max={100} step={0.001} suffix="%" />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMinimumScore" label="Minimum lane score" fallback={defaults.minimumScore} min={0} max={100} step={0.05} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialNoiseFilterPct" label="Noise filter" fallback={defaults.noiseFilterPct} min={0} max={10} step={0.001} suffix="%" />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMomentumWeight" label="Momentum weight" fallback={defaults.momentumWeight} min={0} max={5} step={0.05} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialActivityWeight" label="Activity weight" fallback={defaults.activityWeight} min={0} max={5} step={0.05} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialVolatilityWeight" label="Volatility weight" fallback={defaults.volatilityWeight} min={0} max={5} step={0.05} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMarketChangeSpeedWeight" label="Change-speed weight" fallback={defaults.marketChangeSpeedWeight} min={0} max={5} step={0.05} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMinimumMarketChangeSpeedRatio" label="Minimum speed ratio" fallback={defaults.minimumMarketChangeSpeedRatio} min={0} max={100} step={0.05} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMaximumMarketChangeSpeedPctPerSecond" label="Maximum speed" fallback={defaults.maximumMarketChangeSpeedPctPerSecond} min={0.000001} max={100} step={0.0001} suffix="% / second" />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialScenarioWeight" label="Scenario weight" fallback={defaults.scenarioWeight} min={0} max={5} step={0.05} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialScenarioMinimumScore" label="Minimum scenario score" fallback={defaults.scenarioMinimumScore} min={0} max={100} step={0.05} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialPastActivityPersistenceMinimum" label="Past-activity persistence" fallback={defaults.pastActivityPersistenceMinimum} min={0} max={1} step={0.01} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialActivityBreakoutRatio" label="Activity-breakout ratio" fallback={defaults.activityBreakoutRatio} min={0} max={20} step={0.05} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialReversalAccelerationMinimumPct" label="Reversal acceleration minimum" fallback={defaults.reversalAccelerationMinimumPct} min={0} max={100} step={0.001} suffix="%" />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialActivityLookback" label="Volume lookback" fallback={defaults.activityLookback} min={SPECIAL_MIN_STEP} max={500} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMinimumActivityRatio" label="Minimum volume activity" fallback={defaults.minimumActivityRatio} min={0} max={20} step={0.01} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMarketActivityFadeRatio" label="Activity-fade exit" fallback={defaults.marketActivityFadeRatio} min={0} max={5} step={0.01} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMaximumVolatilityPct" label="Maximum volatility" fallback={defaults.maximumVolatilityPct} min={0.01} max={100} step={0.01} suffix="%" />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialVolatilityTargetPct" label="Volume scaling volatility target" fallback={defaults.volatilityTargetPct} min={0.001} max={100} step={0.001} suffix="%" />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMinimumVolatilityVolumeScale" label="Minimum volatility volume scale" fallback={defaults.minimumVolatilityVolumeScale} min={0.01} max={1} step={0.01} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialOrderFlowWeight" label="Order-flow weight" fallback={defaults.orderFlowWeight} min={0} max={5} step={0.05} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMinimumDirectionalOrderFlow" label="Minimum directional OFI" fallback={defaults.minimumDirectionalOrderFlow} min={0} max={1} step={0.01} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMaximumSpreadBps" label="Maximum spread" fallback={defaults.maximumSpreadBps} min={0} max={10000} step={0.1} suffix="bps" />
          </div>
          <ToggleField settings={settings} onChange={handleSettingChange} settingKey="specialScenarioCoordinationEnabled" label="Enable extensible scenario coordination" fallback={defaults.scenarioCoordinationEnabled} description="Continuation, acceleration, breakout, reversal, OFI persistence, fade, exhaustion and liquidity-stress evaluators." />
          <ToggleField settings={settings} onChange={handleSettingChange} settingKey="specialRequireOrderFlowConfirmation" label="Require order-flow confirmation" fallback={defaults.requireOrderFlowConfirmation} description="If enabled, missing OFI/depth fails closed instead of being treated as neutral." />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Positions and holding time</CardTitle>
          <CardDescription>Same-side logical legs are aggregated into one exchange hedge-side position.</CardDescription>
        </CardHeader>
        <CardContent className={grid}>
          <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMinimumHoldingSteps" label="Minimum holding steps" fallback={defaults.minimumHoldingSteps} min={0} max={10000} />
          <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMaximumHoldingSteps" label="Maximum holding steps" fallback={defaults.maximumHoldingSteps} min={SPECIAL_MIN_STEP} max={100000} />
          <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMinimumHoldingSeconds" label="Minimum holding time" fallback={defaults.minimumHoldingSeconds} min={1} max={SPECIAL_MAX_HOLDING_SECONDS} suffix="seconds" />
          <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialTargetHoldingSeconds" label="Target holding time" fallback={defaults.targetHoldingSeconds} min={1} max={SPECIAL_MAX_HOLDING_SECONDS} suffix="seconds" />
          <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMaximumHoldingSeconds" label="Absolute maximum holding time" fallback={defaults.maximumHoldingSeconds} min={1} max={SPECIAL_MAX_HOLDING_SECONDS} suffix="seconds (≤90 min)" />
          <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMaxPositionsPerDirection" label="Logical positions per direction" fallback={defaults.maxPositionsPerDirection} min={1} max={SPECIAL_MAX_POSITIONS_PER_DIRECTION} />
          <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialAdditionalPositionStepPositionCostRatio" label="Additional-position step" fallback={defaults.additionalPositionStepPositionCostRatio} min={SPECIAL_MIN_STEP} max={100} step={0.1} suffix="× position cost" />
          <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialVolumeIncrementRatio" label="Volume increment" fallback={defaults.volumeIncrementRatio} min={0} max={2} step={0.05} suffix="× base" />
          <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMaxVolumeRatio" label="Total volume ratio" fallback={defaults.maxVolumeRatio} min={1} max={SPECIAL_MAX_VOLUME_RATIO} step={0.1} suffix="× base (hard max 3)" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>TP, SL, costs and trailing</CardTitle>
          <CardDescription>Position-cost-aware protection recalculated as the market moves.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className={grid}>
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialTakeProfitMinPositionCostRatio" label="TP minimum" fallback={defaults.takeProfitMinPositionCostRatio} min={0.1} max={100} step={0.1} suffix="× position cost" />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialTakeProfitMaxPositionCostRatio" label="TP maximum" fallback={defaults.takeProfitMaxPositionCostRatio} min={0.1} max={100} step={0.1} suffix="× position cost" />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialTakeProfitVolatilityMultiplier" label="TP volatility multiplier" fallback={defaults.takeProfitVolatilityMultiplier} min={0} max={20} step={0.05} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialTakeProfitMarketChangeMultiplier" label="TP market-change multiplier" fallback={defaults.takeProfitMarketChangeMultiplier} min={0} max={20} step={0.05} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialStopLossMinPositionCostRatio" label="SL minimum" fallback={defaults.stopLossMinPositionCostRatio} min={0.1} max={100} step={0.05} suffix="× position cost" />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialStopLossVolatilityMultiplier" label="SL volatility multiplier" fallback={defaults.stopLossVolatilityMultiplier} min={0} max={20} step={0.05} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialStopLossMaxTakeProfitRatio" label="SL / TP maximum" fallback={defaults.stopLossMaxTakeProfitRatio} min={0.1} max={SPECIAL_MAX_SL_TO_TP_RATIO} step={0.1} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialRoundTripCostPct" label="Assumed round-trip costs" fallback={defaults.roundTripCostPct} min={0} max={20} step={0.01} suffix="%" />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialMinimumTakeProfitAfterCostsRatio" label="Minimum TP over costs" fallback={defaults.minimumTakeProfitAfterCostsRatio} min={1} max={20} step={0.1} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialTrailingActivationTakeProfitRatio" label="Trailing activation" fallback={defaults.trailingActivationTakeProfitRatio} min={0.05} max={1} step={0.01} suffix="× TP" />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialTrailingDistanceTakeProfitRatio" label="Trailing distance" fallback={defaults.trailingDistanceTakeProfitRatio} min={0.01} max={1} step={0.01} suffix="× TP" />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialTrailingStepTakeProfitRatio" label="Trailing ratchet step" fallback={defaults.trailingStepTakeProfitRatio} min={0.005} max={1} step={0.005} suffix="× TP" />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialTrailingVolatilityAdaptationWeight" label="Trailing volatility adaptation" fallback={defaults.trailingVolatilityAdaptationWeight} min={0} max={5} step={0.05} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialTrailingSpeedAdaptationWeight" label="Trailing speed/acceleration adaptation" fallback={defaults.trailingSpeedAdaptationWeight} min={0} max={5} step={0.05} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialTrailingActivityAdaptationWeight" label="Trailing activity adaptation" fallback={defaults.trailingActivityAdaptationWeight} min={0} max={5} step={0.05} />
            <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialTrailingScenarioAdaptationWeight" label="Trailing scenario adaptation" fallback={defaults.trailingScenarioAdaptationWeight} min={0} max={5} step={0.05} />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <ToggleField settings={settings} onChange={handleSettingChange} settingKey="specialNonTrailingVariantEnabled" label="Process fixed TP/SL variant" fallback={defaults.nonTrailingVariantEnabled} description="Independent Set key, position ledger, PF and drawdown statistics without trailing." />
            <ToggleField settings={settings} onChange={handleSettingChange} settingKey="specialTrailingEnabled" label="Process active trailing variant" fallback={defaults.trailingEnabled} description="Independent Set key, position ledger, PF and drawdown statistics with trailing." />
            <ToggleField settings={settings} onChange={handleSettingChange} settingKey="specialTrailingAdaptiveEnabled" label="Adaptive trailing calculations" fallback={defaults.trailingAdaptiveEnabled} description="Volatility, change-speed, acceleration, activity persistence and scenarios independently recalculate activation, distance and ratchet step." />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Five-day multi-symbol release gates</CardTitle>
          <CardDescription>Best-first ranking uses the weakest symbol/direction/fold, costs, drawdown and catastrophic-loss veto.</CardDescription>
        </CardHeader>
        <CardContent className={grid}>
          <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialBacktestMinimumTrades" label="Minimum total trades" fallback={defaults.backtestMinimumTrades} min={1} max={100000} />
          <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialBacktestMinimumTradesPerDirection" label="Minimum trades per direction" fallback={defaults.backtestMinimumTradesPerDirection} min={0} max={100000} />
          <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialBacktestMinimumTradesPerSymbol" label="Minimum trades per symbol" fallback={defaults.backtestMinimumTradesPerSymbol} min={0} max={100000} />
          <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialBacktestMinimumStableProfitFactor" label="Minimum stable PF" fallback={defaults.backtestMinimumStableProfitFactor} min={0} max={100} step={0.01} />
          <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialBacktestMaximumDrawdownPct" label="Maximum drawdown" fallback={defaults.backtestMaximumDrawdownPct} min={0.01} max={100} step={0.1} suffix="%" />
          <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialWalkForwardFolds" label="Walk-forward folds" fallback={defaults.walkForwardFolds} min={2} max={12} />
          <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialWalkForwardPurgeSteps" label="Purged steps between folds" fallback={defaults.walkForwardPurgeSteps} min={0} max={100000} />
          <NumberField settings={settings} onChange={handleSettingChange} settingKey="specialWalkForwardMaximumFoldLossPct" label="Catastrophic fold-loss veto" fallback={defaults.walkForwardMaximumFoldLossPct} min={0} max={100} step={0.1} suffix="%" />
        </CardContent>
      </Card>
    </div>
  )
}

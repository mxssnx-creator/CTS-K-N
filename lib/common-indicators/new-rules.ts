/**
 * Rules of the Common types ported from CTS-A-O (see ./catalog.ts for the
 * parameters). Each type runs one ported CTS-A-O rule on the shared context's
 * column view; event rules of the research and Micro batches are kept for
 * `keep` bars so the last-bar evaluation still reads an event once its bar has
 * closed. Classic held events (Donchian break, MACD cross, …) apply their own
 * `keep` inside the rule, exactly as in the reference.
 */
import { COMMON_CATALOG, type CommonCatalogEntry, type CommonCatalogType } from "./catalog"
import { hold, registerClassic } from "./ao/classic"
import { collectAoRules, type AoRuleSource } from "./ao/define"
import { registerMicro } from "./ao/micro-rules"
import { registerResearch } from "./ao/research"
import { registerResearch2 } from "./ao/research2"
import { registerResearch3 } from "./ao/research3"
import type { CommonSeriesContext } from "./context"
import type { CommonRule, RuleParams } from "./legacy-rules"
import { clamp, finite } from "./kn-math"

export const AO_RULES: ReadonlyMap<string, AoRuleSource> = collectAoRules((both) => {
  registerClassic(both)
  registerResearch(both)
  registerResearch2(both)
  registerResearch3(both)
  registerMicro(both)
})

type Mapping = {
  /** CTS-A-O rule id */
  source: string
  /** K-N parameters → the rule's own parameters (default: identical keys) */
  map?: (p: RuleParams) => RuleParams
  /** bars before the rule can fire */
  warmup: (p: RuleParams) => number
}

const ATR = 15
const VZ = 21
const at = (...values: number[]) => Math.ceil(Math.max(...values.map((value) => (Number.isFinite(value) ? value : 0)))) + 1
const HTF4 = (tfBars: number) => 4 * 51 + tfBars

export const NEW_RULE_MAPPINGS: Record<CommonCatalogType, Mapping> = {
  // trend
  emaTrend: { source: "trend-ema", warmup: (p) => at(p.slow) },
  supertrend: { source: "trend-st", warmup: (p) => at(p.period) },
  emaRibbon: { source: "trend-ribbon", warmup: (p) => at(p.slow) },
  emaSlope: { source: "ema-slope", warmup: (p) => at(p.period + p.lookback) },
  emaReclaim: { source: "dir-reclaim", warmup: (p) => at(p.period + 1) },
  emaPullback: { source: "ema-pullback", warmup: (p) => at(p.slow) },
  ichimokuTk: { source: "ichi-tk", warmup: (p) => at(p.kijun) },
  ichimokuCloud: { source: "ichi-cloud", warmup: (p) => at(p.senkou + p.kijun) },
  aroon: { source: "aroon", warmup: (p) => at(p.period + 1) },
  vortex: { source: "r-vortex", warmup: (p) => at(p.p + 1) },
  chandelier: { source: "r-chand", warmup: (p) => at(p.p + 1) },
  hma: { source: "hma", warmup: (p) => at(p.period + Math.sqrt(p.period) + 1) },
  kama: { source: "kama", warmup: (p) => at(p.period + 1) },
  trix: { source: "trix", warmup: (p) => at(3 * p.period) },
  heikinAshi: { source: "ha", warmup: (p) => at(p.bars) },
  roofingFilter: { source: "r-roofing", warmup: () => 121 },
  elderRay: { source: "r-elder", warmup: (p) => at(3 * p.ema) },
  linearRegression: { source: "r-linreg", warmup: (p) => at(p.n + 5) },
  htfTrendResume: { source: "mc-tmom", warmup: (p) => HTF4(p.bars + 1) },
  htfEmaPullback: { source: "mc-tpull", warmup: (p) => HTF4(p.period) },
  htfEmaCross: { source: "mc-tcross", warmup: (p) => HTF4(p.slow) },
  // momentum
  rsiMomentum: { source: "rsi-mom", warmup: (p) => at(p.period + 1) },
  macdCross: { source: "macd-cross", warmup: (p) => at(p.slow + p.signal) },
  macdHistogramTrend: { source: "macd-hist", warmup: (p) => at(p.slow + p.signal + 2) },
  macdZeroLine: { source: "macd-zero", warmup: (p) => at(p.slow) },
  macdHistogramTurn: { source: "mc-macdh", warmup: () => at(26 + 9 + 2) },
  tsi: { source: "r-tsi", warmup: (p) => at(3 * p.a) },
  awesomeOscillator: { source: "r-awesome", warmup: (p) => at(p.s + 3) },
  schaffTrendCycle: { source: "r-stc", warmup: (p) => at(p.s + 20) },
  impulse: { source: "move-impulse", warmup: (p) => at(p.bars, ATR) },
  continuation: { source: "move-cont", warmup: (p) => at(p.longRoc) },
  thrust: { source: "dir-thrust", warmup: (p) => at(p.bars) },
  hfMomentum: { source: "act-hf", warmup: (p) => at(p.bars, ATR) },
  sessionTrend: { source: "r-session-trend", warmup: (p) => at(p.ema, p.bars, ATR) },
  htfRsiMid: { source: "mc-rsimid", warmup: (p) => HTF4(p.period + 1) },
  // oscillator
  rsiReversion: { source: "rsi-extreme", warmup: (p) => at(p.period + 1) },
  rsiTurn: { source: "mc-rsit", warmup: (p) => at(p.period + 2) },
  rsiTrendFilter: { source: "r-rsi2", warmup: (p) => at(p.ema) },
  rsiDivergence: { source: "rsi-div", warmup: (p) => at(p.period + p.lookback + 1) },
  rsiWindowDivergence: { source: "mc-rsidiv", warmup: (p) => at(p.period + p.lookback + 1) },
  quietRsi2: { source: "mc-qrsi2", warmup: () => at(100 + 20) },
  connorsRsi: { source: "r-connors", warmup: (p) => at(110, p.ema) },
  laguerreRsi: {
    source: "r-laguerre",
    map: (p) => ({ g: p.g, lo: p.level, hi: 1 - p.level }),
    warmup: () => 9,
  },
  stochRsi: { source: "srsi", warmup: (p) => at(2 * p.period + 3) },
  ultimateOscillator: {
    source: "r-ultimate",
    map: (p) => ({ a: p.a, b: 2 * p.a, d: 4 * p.a, lo: p.level, hi: 100 - p.level }),
    warmup: (p) => at(4 * p.a + 1),
  },
  fisherTransform: { source: "r-fisher", warmup: (p) => at(p.n + 1) },
  zScore: { source: "z", warmup: (p) => at(p.period) },
  zDistance: { source: "r-zdist", warmup: (p) => at(p.look + 20) },
  cciReversion: { source: "cci-revert", warmup: (p) => at(p.period) },
  tdSetup: { source: "r-td", warmup: (p) => at(p.n + 4) },
  emaStochastic: { source: "ema-stoch", warmup: (p) => at(p.slow, p.kPeriod + 3) },
  chopFade: { source: "act-chop", warmup: (p) => at(2 * 14, p.rsiPeriod + 1) },
  streakFade: { source: "mc-streak", warmup: (p) => at(p.bars + 1) },
  exhaustionStreak: { source: "r-streak", warmup: (p) => at(p.n + 1, ATR, VZ) },
  spikeReversal: { source: "mc-spike", warmup: () => at(21) },
  vwapDistance: { source: "mc-vwapd", warmup: () => at(60, ATR) },
  bandReentry: { source: "mc-bbx", warmup: () => at(21) },
  bandAdxReversion: { source: "r-bb-adx", warmup: () => at(28, 20) },
  htfTrendStretch: { source: "mc-tstretch", warmup: () => HTF4(60) },
  htfTrendTurn: { source: "mc-tturn", warmup: () => HTF4(5) },
  // volatility & breaks
  donchianBreak: { source: "break-don", warmup: (p) => at(p.period + 1) },
  volumeBreak: { source: "break-vol", warmup: (p) => at(p.period + 1, 20) },
  donchianVolumeThrust: { source: "r-donch-vol", warmup: (p) => at(p.p + 1, ATR, VZ) },
  atrExpansion: { source: "break-atr", warmup: () => at(ATR + 1) },
  bollingerSqueeze: { source: "break-squeeze", warmup: (p) => at(p.lookback + 20) },
  keltnerBreak: { source: "kelt", warmup: (p) => at(p.period + 1) },
  squeezeRelease: { source: "squeeze", warmup: (p) => at(p.period + 1) },
  squeezeRun: { source: "r-squeeze", warmup: (p) => at(21 + p.bars) },
  breakRetest: { source: "break-retest", warmup: (p) => at(p.period + 2) },
  failedBreak: { source: "break-fail", warmup: (p) => at(p.period + 1) },
  fakeout: { source: "r-fakeout", warmup: (p) => at(p.p + 4, ATR) },
  rangeBurst: { source: "act-burst", warmup: () => at(21) },
  rangeShift: { source: "act-shift", warmup: (p) => at(p.long, 11) },
  volatilityRegime: { source: "r-vol-regime", warmup: (p) => at(p.p + 1, 101) },
  bandWidthExpansion: { source: "r-bbw-expand", warmup: () => at(46) },
  bandWalk: { source: "bb-walk", warmup: (p) => at(p.period + 1) },
  bollingerMidReclaim: { source: "bb-mid", warmup: (p) => at(p.period + 1) },
  bollingerWick: { source: "bb-wick", warmup: (p) => at(p.period) },
  bandBreakout: { source: "mc-bbrk", warmup: () => at(21) },
  narrowRangeBreak: { source: "r-nr-break", warmup: (p) => at(p.n + 1) },
  choppinessBreak: { source: "r-chop", warmup: (p) => at(p.p + p.m) },
  expansionBreak: { source: "mc-brk", warmup: (p) => at(p.period + 1, 21) },
  insideBarBreak: { source: "mc-ibrk", warmup: () => 3 },
  // volume & flow
  mfi: { source: "mfi", warmup: (p) => at(p.period + 1) },
  cmf: { source: "cmf", warmup: (p) => at(p.period) },
  obvEma: { source: "obv-ema", warmup: (p) => at(p.period + 1) },
  klinger: { source: "r-klinger", warmup: (p) => at(p.s + p.sig) },
  clvThrust: { source: "r-clv-thrust", warmup: () => at(ATR, VZ) },
  cvdDivergence: { source: "r-cvd-div", warmup: (p) => at(2 * p.p) },
  vwapReclaim: { source: "r-vwap-reclaim", warmup: (p) => at(VZ + p.hold + 1) },
  vwapVolumeCross: { source: "mc-vwapx", warmup: () => at(61) },
  volumeBurst: { source: "mc-burst", warmup: () => at(61, 100) },
  valueArea: { source: "r-valuearea", warmup: (p) => at(p.look + 2) },
  quarterHourFlow: { source: "r-qh-flow", warmup: () => at(60) },
  quarterHourReversal: { source: "r-qh-rev", warmup: () => at(61) },
  // structure & price action
  swingPosition: { source: "move-swing", warmup: (p) => at(p.period + 1) },
  stopSweep: { source: "r-sweep", warmup: (p) => at(p.p + 1, VZ) },
  capitulation: { source: "r-capit", warmup: () => at(ATR + 1, VZ) },
  fractalBreak: { source: "r-fractal", warmup: (p) => at(p.ema, 2 * p.w + 1, 15) },
  camarillaPivots: { source: "r-camarilla", warmup: () => at(2) },
  spring: { source: "r-spring", warmup: (p) => at(p.p + 3, ATR) },
  openingRangeBreak: { source: "r-orb", warmup: (p) => at(p.bars + 1, ATR) },
  previousDayBreak: { source: "r-pdhl", warmup: () => at(ATR) },
  breakOfStructure: { source: "r-bos", warmup: (p) => at(4 * p.w + 1, ATR) },
  changeOfCharacter: { source: "r-choch", warmup: (p) => at(4 * p.w + 1, ATR) },
  fairValueGap: { source: "r-fvg", warmup: () => at(ATR + 3) },
  insideBarTrend: { source: "r-inside", warmup: (p) => at(p.ema + 3, ATR) },
  engulfingVolume: { source: "r-engulf", warmup: (p) => at(p.look + 2, ATR, VZ) },
  engulfingExtreme: { source: "mc-engulf", warmup: (p) => at(p.period + 1) },
  pinBar: { source: "r-pin", warmup: () => at(22, ATR) },
  rejectionWick: { source: "mc-wick", warmup: () => at(21) },
  starPattern: { source: "r-star", warmup: () => at(20, ATR) },
}

const isHeldInternally = (source: string) => !source.startsWith("r-") && !source.startsWith("mc-")

const paramKey = (params: RuleParams) =>
  Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join(",")

function resolveCatalogParams(entry: CommonCatalogEntry, raw: Record<string, number> | undefined): RuleParams {
  const params: RuleParams = {}
  for (const [key, definition] of Object.entries(entry.parameters)) {
    params[key] = clamp(finite(raw?.[key], definition.default.from), definition.min, definition.max)
  }
  return params
}

function ruleFor(entry: CommonCatalogEntry, mapping: Mapping): CommonRule {
  const source = AO_RULES.get(mapping.source)
  if (!source) throw new Error(`Common type ${entry.type}: CTS-A-O rule ${mapping.source} is not registered`)
  const heldInternally = isHeldInternally(mapping.source)
  const states = (ctx: CommonSeriesContext, p: RuleParams): Int8Array =>
    ctx.memo(`ao:${entry.type}:${paramKey(p)}`, () => {
      const raw = source.fn(ctx.ao(), mapping.map ? mapping.map(p) : p)
      return entry.kind === "event" && !heldInternally ? hold(raw, p.keep ?? 1) : raw
    })
  // bars since the last raw event (held events lose strength with age)
  const age = (ctx: CommonSeriesContext, p: RuleParams, index: number, value: number): number => {
    if (entry.kind !== "event") return 0
    const series = states(ctx, p)
    let bars = 0
    while (index - bars - 1 >= 0 && series[index - bars - 1] === value && bars < 50) bars++
    return bars
  }
  return {
    type: entry.type,
    kind: entry.kind,
    resolve: (raw) => resolveCatalogParams(entry, raw),
    warmup: (p) => Math.max(1, Math.round(mapping.warmup(p))),
    at(ctx, p, index) {
      const value = states(ctx, p)[index] || 0
      const directional = value > 0 ? "long" : value < 0 ? "short" : "neutral"
      const keep = Math.max(1, p.keep ?? 1)
      const ageBars = value ? age(ctx, p, index, value) : 0
      const strength = value === 0 ? 0 : entry.kind === "event" ? 1 - 0.5 * Math.min(1, ageBars / keep) : 0.6
      return {
        direction: directional,
        strength,
        value: ctx.candles[index]?.close ?? 0,
        signal: value,
        details: (entry.kind === "event" ? { state: value, ageBars } : { state: value }) as Record<string, number>,
      }
    },
    states,
  }
}

export const NEW_COMMON_RULES: readonly CommonRule[] = COMMON_CATALOG.map((entry) =>
  ruleFor(entry as CommonCatalogEntry, NEW_RULE_MAPPINGS[entry.type]),
)

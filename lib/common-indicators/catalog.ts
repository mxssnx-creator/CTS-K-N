/**
 * Catalogue of the Common types ported from CTS-A-O (classic registry families,
 * the three research batches and the single-symbol Micro events). Pure data and
 * free of indicator math, so the Settings page can import it without bundling
 * the calculations; the rules themselves live in ./new-rules.ts and a unit test
 * keeps both in sync.
 *
 * Every A-O short / "-m" medium / numeric-suffix variant of one rule is one K-N
 * type whose parameter ranges cover the A-O values. Stable-02 ports are not part
 * of this catalogue (they belong to the CTS-G project), and the Micro market
 * relations need the multi-symbol universe, so they are not portable to a
 * per-symbol Common type.
 */
import type { CommonIndicatorCategory } from "./types"

export interface CatalogRange {
  from: number
  to: number
  step: number
}

export interface CatalogParameter {
  label: string
  default: CatalogRange
  min: number
  max: number
  minimumStep: number
}

export interface CommonCatalogEntry<T extends string = string> {
  type: T
  label: string
  description: string
  category: CommonIndicatorCategory
  /** "state" holds a reading every bar; "event" fires on bars and is kept for `keep` bars */
  kind: "state" | "event"
  /** CTS-A-O source ids this type ports */
  sources: readonly string[]
  parameters: Record<string, CatalogParameter>
  /** ordering constraints between parameters, e.g. ["fast", "<", "slow"] */
  constraints?: ReadonlyArray<readonly [string, "<" | "<=", string]>
  /** needs wall-clock bars (sessions, quarter hours or UTC days) */
  requiresWallClock?: boolean
}

const range = (
  label: string,
  from: number,
  to: number,
  step: number,
  min: number,
  max: number,
  minimumStep = Math.min(step, 1),
): CatalogParameter => ({ label, default: { from, to, step }, min, max, minimumStep })

const single = (label: string, value: number, min: number, max: number, minimumStep = 1): CatalogParameter =>
  range(label, value, value, minimumStep, min, max, minimumStep)

/** keep = bars an event stays active (2: the firing bar is still read once it has closed) */
const keep = (value = 2) => single("Keep (bars)", value, 1, 20)

const entry = <T extends string>(
  type: T,
  category: CommonIndicatorCategory,
  kind: "state" | "event",
  sources: readonly string[],
  label: string,
  description: string,
  parameters: Record<string, CatalogParameter>,
  extra: Pick<CommonCatalogEntry, "constraints" | "requiresWallClock"> = {},
): CommonCatalogEntry<T> => ({
  type,
  label,
  description,
  category,
  kind,
  sources,
  parameters: kind === "event" && !parameters.keep ? { ...parameters, keep: keep() } : parameters,
  ...extra,
})

export const COMMON_CATALOG = [
  // ── trend ─────────────────────────────────────────────────────────────────────────
  entry("emaTrend", "trend", "state", ["trend-ema"], "EMA trend",
    "Fast EMA above the slow EMA with the close above the slow EMA (long), the mirror (short).", {
      fast: range("Fast EMA", 9, 21, 12, 2, 200),
      slow: range("Slow EMA", 21, 55, 34, 3, 400),
    }, { constraints: [["fast", "<", "slow"]] }),
  entry("supertrend", "trend", "state", ["trend-st", "dir-st"], "Supertrend",
    "Supertrend direction (Wilder ATR band flip).", {
      period: range("ATR period", 7, 21, 7, 2, 200),
      multiplier: range("Multiplier", 2, 4, 1, 0.5, 10, 0.1),
    }),
  entry("emaRibbon", "trend", "state", ["trend-ribbon"], "EMA ribbon",
    "Three EMAs stacked in order (fast > mid > slow long, the reverse short).", {
      fast: single("Fast EMA", 9, 2, 200),
      mid: single("Mid EMA", 21, 3, 300),
      slow: range("Slow EMA", 55, 89, 34, 4, 500),
    }, { constraints: [["fast", "<", "mid"], ["mid", "<", "slow"]] }),
  entry("emaSlope", "trend", "state", ["ema-slope"], "EMA slope",
    "Sign of the EMA's change over the lookback.", {
      period: range("EMA period", 10, 50, 20, 2, 400),
      lookback: range("Lookback (bars)", 3, 9, 3, 1, 100),
    }),
  entry("emaReclaim", "trend", "event", ["dir-reclaim"], "EMA reclaim",
    "Close crosses back over the EMA, kept for a few bars.", {
      period: range("EMA period", 21, 50, 29, 2, 400),
      keep: single("Keep (bars)", 4, 1, 20),
    }),
  entry("emaPullback", "trend", "state", ["ema-pullback"], "EMA pullback in trend",
    "In an EMA trend, the bar dips to the fast EMA and closes back beyond it.", {
      fast: range("Fast EMA", 21, 50, 29, 2, 300),
      slow: range("Slow EMA", 55, 100, 45, 3, 500),
    }, { constraints: [["fast", "<", "slow"]] }),
  entry("ichimokuTk", "trend", "state", ["ichi-tk"], "Ichimoku TK",
    "Tenkan-sen above / below the Kijun-sen.", {
      tenkan: range("Tenkan", 9, 20, 11, 2, 200),
      kijun: range("Kijun", 26, 60, 34, 3, 300),
      senkou: range("Senkou B", 52, 120, 68, 4, 500),
    }, { constraints: [["tenkan", "<", "kijun"], ["kijun", "<", "senkou"]] }),
  entry("ichimokuCloud", "trend", "state", ["ichi-cloud"], "Ichimoku cloud",
    "Close above the cloud with Tenkan above Kijun (long), the mirror (short).", {
      tenkan: range("Tenkan", 9, 20, 11, 2, 200),
      kijun: range("Kijun", 26, 60, 34, 3, 300),
      senkou: range("Senkou B", 52, 120, 68, 4, 500),
    }, { constraints: [["tenkan", "<", "kijun"], ["kijun", "<", "senkou"]] }),
  entry("aroon", "trend", "state", ["aroon"], "Aroon",
    "Aroon up above the level with Aroon down below its mirror (long), the reverse (short).", {
      period: range("Period", 14, 25, 11, 2, 200),
      level: single("Level", 70, 51, 99),
    }),
  entry("vortex", "trend", "event", ["r-vortex"], "Vortex cross",
    "VI+ crosses VI− with a minimum gap.", {
      p: range("Period", 14, 21, 7, 2, 200),
      gap: range("Gap", 0.1, 0.15, 0.05, 0, 2, 0.01),
    }),
  entry("chandelier", "trend", "event", ["r-chand"], "Chandelier flip",
    "The chandelier exit flips side.", {
      p: range("Period", 22, 44, 22, 2, 300),
      m: range("ATR multiplier", 3, 3.5, 0.5, 0.5, 10, 0.1),
    }),
  entry("hma", "trend", "state", ["hma"], "HMA slope",
    "Sign of the Hull moving average's one-bar slope.", {
      period: range("Period", 16, 56, 20, 2, 400),
    }),
  entry("kama", "trend", "state", ["kama"], "KAMA trend",
    "Close above a rising KAMA (long), below a falling KAMA (short).", {
      period: range("Period", 10, 20, 10, 2, 200),
    }),
  entry("trix", "trend", "state", ["trix"], "TRIX",
    "Sign of the triple-smoothed EMA rate of change.", {
      period: range("Period", 9, 15, 6, 2, 200),
    }),
  entry("heikinAshi", "trend", "state", ["ha"], "Heikin-Ashi",
    "N consecutive bullish (long) or bearish (short) Heikin-Ashi candles.", {
      bars: range("Bars", 1, 3, 2, 1, 20),
    }),
  entry("roofingFilter", "trend", "event", ["r-roofing"], "Roofing filter cross",
    "Ehlers roofing filter crosses zero with a minimum amplitude and trend efficiency.", {
      hp: range("High-pass", 48, 96, 48, 10, 400),
      ss: range("Smoother", 10, 20, 10, 2, 100),
      min: range("Min amplitude (σ)", 0.5, 0.7, 0.2, 0, 5, 0.05),
    }),
  entry("elderRay", "trend", "event", ["r-elder"], "Elder ray pullback",
    "EMA trend with bear / bull power recovering and the force index against the pullback.", {
      ema: range("EMA", 13, 26, 13, 2, 300),
      fi: range("Force index EMA", 2, 5, 3, 1, 100),
    }),
  entry("linearRegression", "trend", "event", ["r-linreg"], "Regression channel",
    "Pullback inside a significant regression trend, or a fade beyond a flat channel.", {
      n: range("Length", 50, 100, 50, 10, 500),
      t: range("t-stat", 2, 2.5, 0.5, 0.5, 10, 0.1),
    }),
  entry("htfTrendResume", "trend", "event", ["mc-tmom"], "Resumption with the 4× trend",
    "N closes with the 4× timeframe trend right after a counter-trend close.", {
      bars: range("Bars", 3, 5, 2, 1, 20),
    }),
  entry("htfEmaPullback", "trend", "event", ["mc-tpull"], "EMA pullback with the 4× trend",
    "Close back beyond the EMA after touching it, in the 4× timeframe trend.", {
      period: range("EMA period", 8, 13, 5, 2, 200),
    }),
  entry("htfEmaCross", "trend", "event", ["mc-tcross"], "EMA cross with the 4× trend",
    "Fast EMA crosses the slow EMA in the 4× timeframe trend.", {
      fast: range("Fast EMA", 5, 8, 3, 2, 100),
      slow: range("Slow EMA", 13, 21, 8, 3, 300),
    }, { constraints: [["fast", "<", "slow"]] }),

  // ── momentum ──────────────────────────────────────────────────────────────────────
  entry("rsiMomentum", "momentum", "state", ["rsi-mom", "rsi-mid"], "RSI momentum",
    "RSI above 100 − level (long) or below the level (short): read with the move.", {
      period: range("Period", 7, 21, 7, 2, 200),
      level: range("Level", 20, 40, 10, 1, 49),
    }),
  entry("macdCross", "momentum", "event", ["macd-cross"], "MACD signal cross",
    "MACD line crosses its signal line, kept for a few bars.", {
      fast: range("Fast", 8, 12, 4, 2, 100),
      slow: range("Slow", 21, 26, 5, 3, 300),
      signal: range("Signal", 5, 9, 4, 2, 100),
      keep: single("Keep (bars)", 6, 1, 20),
    }, { constraints: [["fast", "<", "slow"]] }),
  entry("macdHistogramTrend", "momentum", "state", ["macd-hist"], "MACD histogram rising",
    "Histogram rising (long) or falling (short) for two bars.", {
      fast: single("Fast", 12, 2, 100),
      slow: single("Slow", 26, 3, 300),
      signal: single("Signal", 9, 2, 100),
    }, { constraints: [["fast", "<", "slow"]] }),
  entry("macdZeroLine", "momentum", "state", ["macd-zero"], "MACD zero line",
    "Sign of the MACD line.", {
      fast: single("Fast", 12, 2, 100),
      slow: single("Slow", 26, 3, 300),
    }, { constraints: [["fast", "<", "slow"]] }),
  entry("macdHistogramTurn", "momentum", "event", ["mc-macdh"], "MACD histogram turn",
    "Histogram turns back toward zero from beyond it.", {}),
  entry("tsi", "momentum", "event", ["r-tsi"], "TSI cross",
    "True strength index crosses its signal on the side of zero.", {
      a: range("Long smoothing", 13, 25, 12, 2, 200),
      b: range("Short smoothing", 7, 13, 6, 1, 100),
      sig: range("Signal", 5, 7, 2, 1, 50),
    }, { constraints: [["b", "<", "a"]] }),
  entry("awesomeOscillator", "momentum", "event", ["r-awesome"], "Awesome oscillator saucer",
    "AO saucer above (long) or below (short) zero.", {
      f: range("Fast", 5, 8, 3, 2, 100),
      s: range("Slow", 34, 55, 21, 3, 300),
    }, { constraints: [["f", "<", "s"]] }),
  entry("schaffTrendCycle", "momentum", "event", ["r-stc"], "Schaff trend cycle",
    "STC crosses up through 25 (long) or down through 75 (short).", {
      f: range("Fast", 23, 34, 11, 2, 200),
      s: range("Slow", 50, 75, 25, 3, 300),
      cyc: range("Cycle", 10, 14, 4, 2, 100),
    }, { constraints: [["f", "<", "s"]] }),
  entry("impulse", "momentum", "event", ["move-impulse"], "Impulse",
    "Close-to-close move over N bars beyond a multiple of ATR, kept for a few bars.", {
      bars: range("Bars", 4, 20, 8, 1, 200),
      multiplier: range("ATR multiplier", 1.5, 2.5, 1, 0.1, 20, 0.1),
      keep: single("Keep (bars)", 4, 1, 20),
    }),
  entry("continuation", "momentum", "state", ["move-cont"], "Continuation pullback",
    "Long-window rate of change with the trend while the short window pulls back.", {
      longRoc: single("Long ROC", 12, 2, 300),
      shortRoc: single("Short ROC", 3, 1, 100),
      thresholdPct: range("Threshold %", 0.4, 0.6, 0.2, 0.01, 20, 0.01),
    }, { constraints: [["shortRoc", "<", "longRoc"]] }),
  entry("thrust", "momentum", "event", ["dir-thrust"], "Bar thrust",
    "N rising bullish (or falling bearish) bars in a row, kept for a few bars.", {
      bars: range("Bars", 3, 4, 1, 2, 20),
      keep: single("Keep (bars)", 3, 1, 20),
    }),
  entry("hfMomentum", "momentum", "state", ["act-hf"], "HF momentum",
    "Close-to-close move over N bars beyond 0.9 ATR scaled by √(N/3).", {
      bars: range("Bars", 3, 9, 3, 1, 100),
    }),
  entry("sessionTrend", "momentum", "event", ["r-session-trend"], "Session trend",
    "EMA trend plus a strong move, only in the liquid sessions (12–17 and 0–2 UTC).", {
      bars: range("Bars", 12, 24, 12, 2, 200),
      mul: range("ATR multiplier", 1.5, 2, 0.5, 0.1, 20, 0.1),
      ema: range("EMA", 50, 100, 50, 2, 500),
    }, { requiresWallClock: true }),
  entry("htfRsiMid", "momentum", "event", ["mc-rsimid"], "RSI 50 cross with the 4× trend",
    "RSI crosses 50 in the direction of the 4× timeframe trend.", {
      period: range("Period", 14, 21, 7, 2, 200),
    }),

  // ── oscillator (reversion) ────────────────────────────────────────────────────────
  entry("rsiReversion", "oscillator", "state", ["rsi-extreme", "rsi-fast", "rsi-P-L-H", "mc-rsi"], "RSI reversion",
    "RSI below the level (long) or above 100 − level (short).", {
      period: range("Period", 2, 14, 4, 2, 200),
      level: range("Level", 10, 30, 10, 1, 49),
    }),
  entry("rsiTurn", "oscillator", "event", ["mc-rsit"], "RSI turn",
    "RSI turns back out of its extreme (the confirmation bar).", {
      period: range("Period", 2, 8, 3, 2, 200),
      level: range("Level", 10, 30, 10, 1, 49),
    }),
  entry("rsiTrendFilter", "oscillator", "event", ["r-rsi2"], "RSI(2) reversion with trend",
    "Short RSI extreme taken only on the side of the slow EMA.", {
      p: range("RSI period", 2, 3, 1, 2, 50),
      lo: range("Level", 5, 10, 5, 1, 49),
      ema: range("Trend EMA", 100, 200, 100, 2, 500),
    }),
  entry("rsiDivergence", "oscillator", "event", ["rsi-div"], "RSI divergence",
    "Lower close with a higher RSI (long) or the mirror (short), kept for a few bars.", {
      period: single("RSI period", 14, 2, 200),
      lookback: range("Lookback", 10, 20, 10, 2, 200),
      keep: single("Keep (bars)", 4, 1, 20),
    }),
  entry("rsiWindowDivergence", "oscillator", "event", ["mc-rsidiv"], "RSI window divergence",
    "New closing extreme of the window while the RSI holds above / below its window extreme.", {
      period: single("RSI period", 14, 2, 200),
      lookback: range("Lookback", 20, 30, 10, 2, 300),
    }),
  entry("quietRsi2", "oscillator", "event", ["mc-qrsi2"], "RSI(2) in a quiet market",
    "RSI(2) extreme only while ADX(14) < 12 and the Bollinger width is below its median.", {
      level: range("Level", 5, 10, 5, 1, 49),
    }),
  entry("connorsRsi", "oscillator", "event", ["r-connors"], "Connors RSI",
    "Connors RSI extreme on the side of the slow EMA.", {
      lo: range("Level", 10, 15, 5, 1, 49),
      ema: range("Trend EMA", 100, 200, 100, 2, 500),
    }),
  entry("laguerreRsi", "oscillator", "event", ["r-laguerre"], "Laguerre RSI turn",
    "Laguerre RSI crosses back up through the level (long) or down through 1 − level (short).", {
      g: range("Gamma", 0.5, 0.7, 0.2, 0.05, 0.95, 0.05),
      level: range("Level", 0.1, 0.15, 0.05, 0.01, 0.49, 0.01),
    }),
  entry("stochRsi", "oscillator", "state", ["srsi"], "Stochastic RSI",
    "Stochastic RSI below the level (long) or above 100 − level (short).", {
      period: single("Period", 14, 2, 200),
      level: range("Level", 10, 20, 10, 1, 49),
    }),
  entry("ultimateOscillator", "oscillator", "event", ["r-ultimate"], "Ultimate oscillator turn",
    "Ultimate oscillator (windows N, 2N, 4N) crosses back through its levels.", {
      a: range("Short window N", 7, 14, 7, 2, 100),
      level: range("Level", 25, 30, 5, 1, 49),
    }),
  entry("fisherTransform", "oscillator", "event", ["r-fisher"], "Fisher transform turn",
    "Fisher transform crosses its trigger from an extreme.", {
      n: range("Period", 10, 20, 10, 2, 200),
      ext: range("Extreme", 1.5, 1.8, 0.3, 0.6, 5, 0.1),
    }),
  entry("zScore", "oscillator", "state", ["z", "mc-z"], "Z-score reversion",
    "Close z-score below −threshold (long) or above +threshold (short).", {
      period: range("Period", 20, 50, 10, 3, 400),
      threshold: range("Threshold", 2, 2.5, 0.5, 0.5, 10, 0.1),
    }),
  entry("zDistance", "oscillator", "event", ["r-zdist"], "Distance z-score fade",
    "Distance from the SMA(20) in units of its own volatility beyond z: fade it.", {
      z: range("z", 2.5, 3, 0.5, 0.5, 10, 0.1),
      look: range("Volatility lookback", 100, 200, 100, 20, 1000),
    }),
  entry("cciReversion", "oscillator", "state", ["cci"], "CCI reversion",
    "CCI below −level (long) or above +level (short). The original CCI type reads it as momentum.", {
      period: range("Period", 14, 40, 13, 3, 300),
      level: range("Level", 100, 200, 100, 10, 500, 5),
    }),
  entry("tdSetup", "oscillator", "event", ["r-td"], "TD setup exhaustion",
    "DeMark setup count completes: fade the run.", {
      n: range("Count", 9, 13, 4, 2, 30),
    }),
  entry("emaStochastic", "oscillator", "state", ["ema-stoch"], "EMA trend + Stochastic dip",
    "Stochastic dip in an EMA uptrend (long), rip in a downtrend (short).", {
      fast: single("Fast EMA", 21, 2, 300),
      slow: single("Slow EMA", 55, 3, 500),
      kPeriod: single("%K period", 14, 2, 200),
      level: range("Level", 20, 25, 5, 1, 49),
    }, { constraints: [["fast", "<", "slow"]] }),
  entry("chopFade", "oscillator", "state", ["act-chop"], "Chop fade",
    "RSI extremes faded only while ADX shows no trend.", {
      adxMax: range("ADX max", 15, 18, 3, 1, 60),
      rsiPeriod: single("RSI period", 7, 2, 100),
      level: range("Level", 25, 30, 5, 1, 49),
    }),
  entry("streakFade", "oscillator", "event", ["mc-streak"], "Close streak fade",
    "N closes in a row the same way: fade the run.", {
      bars: range("Bars", 4, 6, 2, 2, 30),
    }),
  entry("exhaustionStreak", "oscillator", "event", ["r-streak"], "Exhaustion streak",
    "A long same-way streak on volume that turns: fade it.", {
      n: range("Bars", 5, 6, 1, 2, 30),
      mul: range("ATR multiplier", 2.5, 3, 0.5, 0.1, 20, 0.1),
    }),
  entry("spikeReversal", "oscillator", "event", ["mc-spike"], "Rejected spike fade",
    "A spike bar closing in its opposite third: fade it.", {
      multiplier: range("Range multiplier", 2, 2.5, 0.5, 1, 10, 0.1),
    }),
  entry("vwapDistance", "oscillator", "event", ["mc-vwapd"], "VWAP distance fade",
    "Close beyond N ATR from the rolling VWAP(60): fade it.", {
      distance: range("ATR distance", 2, 3, 1, 0.5, 10, 0.1),
    }),
  entry("bandReentry", "oscillator", "event", ["mc-bbx"], "Bollinger outside close turn",
    "A close outside the band followed by a turn back.", {
      stdDev: range("Standard deviations", 2, 2.5, 0.5, 0.5, 5, 0.05),
    }),
  entry("bandAdxReversion", "oscillator", "event", ["r-bb-adx"], "Bollinger extreme, ADX low",
    "Close outside the band with an RSI(2) extreme while ADX stays low.", {
      adx: range("ADX max", 20, 25, 5, 1, 60),
      rsi: range("RSI(2) level", 10, 15, 5, 1, 49),
    }),
  entry("htfTrendStretch", "oscillator", "event", ["mc-trsi2", "mc-tbbx", "mc-tvwapd", "mc-tz"], "Stretch with the 4× trend",
    "A stretch taken only with the 4× trend: 1 RSI(2) 10/90, 2 Bollinger 2.5 turn, 3 VWAP 3 ATR, 4 z-score 2.5.", {
      stretch: range("Stretch rule", 1, 4, 1, 1, 4),
    }),
  entry("htfTrendTurn", "oscillator", "event", ["mc-turn", "mc-tstreak"], "Turn after a stretch with the 4× trend",
    "The bar after a stretch closes beyond it, with the 4× trend: 1 RSI(2) 10/90, 2 four-close streak.", {
      stretch: range("Stretch rule", 1, 2, 1, 1, 2),
    }),

  // ── volatility & breaks ───────────────────────────────────────────────────────────
  entry("donchianBreak", "volatility", "event", ["break-don"], "Donchian break",
    "Close beyond the prior N-bar high / low, kept for a few bars.", {
      period: range("Period", 10, 55, 15, 2, 400),
      keep: single("Keep (bars)", 6, 1, 20),
    }),
  entry("volumeBreak", "volatility", "event", ["break-vol"], "Donchian break on volume",
    "Donchian break on volume above a multiple of its 20-bar average.", {
      period: single("Period", 20, 2, 400),
      volumeRatio: range("Volume ratio", 1.3, 2, 0.35, 0.5, 10, 0.05),
      keep: single("Keep (bars)", 6, 1, 20),
    }),
  entry("donchianVolumeThrust", "volatility", "event", ["r-donch-vol"], "Donchian + volume + CLV",
    "Donchian break on a volume spike and a wide bar closing near its extreme.", {
      p: range("Period", 20, 40, 20, 2, 400),
      vz: range("Volume z", 2, 2.5, 0.5, 0, 10, 0.1),
      rng: range("Range (ATR)", 1.5, 1.8, 0.3, 0.1, 10, 0.1),
    }),
  entry("atrExpansion", "volatility", "event", ["break-atr"], "ATR expansion",
    "One-bar move beyond a multiple of the prior ATR, kept for a few bars.", {
      multiplier: range("ATR multiplier", 0.9, 2.1, 0.6, 0.1, 20, 0.05),
      keep: single("Keep (bars)", 4, 1, 20),
    }),
  entry("bollingerSqueeze", "volatility", "event", ["break-squeeze"], "Bollinger squeeze break",
    "Band width near its tightest, then a close outside the band.", {
      lookback: range("Lookback", 30, 120, 45, 5, 1000),
      tightness: range("Tightness", 1.1, 1.25, 0.15, 1, 3, 0.01),
      keep: single("Keep (bars)", 8, 1, 20),
    }),
  entry("keltnerBreak", "volatility", "event", ["kelt"], "Keltner break",
    "Close beyond the Keltner channel, kept for a few bars.", {
      period: single("Period", 20, 2, 300),
      multiplier: range("ATR multiplier", 1.5, 2.5, 0.5, 0.1, 10, 0.1),
      keep: single("Keep (bars)", 4, 1, 20),
    }),
  entry("squeezeRelease", "volatility", "event", ["squeeze"], "BB/Keltner squeeze release",
    "Bollinger bands leave the Keltner channel: direction of the close against the channel mid.", {
      period: range("Period", 20, 30, 10, 2, 300),
      kcMultiplier: single("Keltner multiplier", 1.5, 0.1, 10, 0.1),
      keep: single("Keep (bars)", 6, 1, 20),
    }),
  entry("squeezeRun", "volatility", "event", ["r-squeeze"], "Squeeze release after a run",
    "Release after the bands stayed inside the Keltner channel for N bars.", {
      bars: range("Squeeze bars", 4, 8, 4, 1, 100),
      kc: single("Keltner multiplier", 1.5, 0.1, 10, 0.1),
    }),
  entry("breakRetest", "volatility", "event", ["break-retest"], "Break retest hold",
    "After a Donchian break the level is retested and holds.", {
      period: single("Period", 20, 2, 400),
      window: single("Retest window (bars)", 8, 2, 100),
      keep: single("Keep (bars)", 5, 1, 20),
    }),
  entry("failedBreak", "volatility", "event", ["break-fail"], "Failed break fade",
    "Pierce of the prior high / low that closes back inside: fade it.", {
      period: range("Period", 20, 40, 20, 2, 400),
      keep: single("Keep (bars)", 5, 1, 20),
    }),
  entry("fakeout", "volatility", "event", ["r-fakeout"], "Failed breakout",
    "A recent break followed by a close back inside by a fraction of ATR.", {
      p: range("Period", 20, 40, 20, 2, 400),
      back: range("Back (ATR)", 0.1, 0.15, 0.05, 0, 5, 0.01),
    }),
  entry("rangeBurst", "volatility", "event", ["act-burst"], "Range burst",
    "Bar range beyond a multiple of the 20-bar average range, in the bar's direction.", {
      multiplier: range("Range multiplier", 1.5, 2.5, 0.5, 1, 10, 0.1),
      keep: single("Keep (bars)", 4, 1, 20),
    }),
  entry("rangeShift", "volatility", "state", ["act-shift"], "Range shift",
    "Short average range above a multiple of the long one: direction of ROC(10).", {
      short: single("Short window", 20, 2, 300),
      long: single("Long window", 60, 3, 1000),
      ratio: range("Ratio", 1.2, 1.4, 0.2, 1, 5, 0.05),
    }, { constraints: [["short", "<", "long"]] }),
  entry("volatilityRegime", "volatility", "event", ["r-vol-regime"], "Regime breakout",
    "Donchian break only while ATR(14) exceeds a multiple of ATR(100).", {
      p: range("Period", 20, 40, 20, 2, 400),
      ratio: range("ATR ratio", 1.1, 1.25, 0.15, 0.5, 5, 0.05),
    }),
  entry("bandWidthExpansion", "volatility", "event", ["r-bbw-expand"], "Bandwidth expansion",
    "Band width rises from the bottom of its history above its median: close against the mid band.", {
      look: range("Lookback", 500, 800, 300, 50, 5000),
      from: range("From percentile", 0.15, 0.2, 0.05, 0.01, 0.9, 0.01),
      to: single("To percentile", 0.4, 0.05, 0.99, 0.01),
    }, { constraints: [["from", "<", "to"]] }),
  entry("bandWalk", "volatility", "state", ["bb-walk"], "Bollinger band walk",
    "Two closes in a row outside the band.", {
      period: range("Period", 20, 50, 30, 2, 400),
      stdDev: single("Standard deviations", 2, 0.5, 5, 0.05),
    }),
  entry("bollingerMidReclaim", "volatility", "event", ["bb-mid"], "Bollinger mid reclaim",
    "Close crosses the middle band, kept for a few bars.", {
      period: single("Period", 20, 2, 400),
      keep: single("Keep (bars)", 4, 1, 20),
    }),
  entry("bollingerWick", "volatility", "event", ["bb-wick"], "Bollinger wick tag",
    "Wick pierces the band and the close returns inside.", {
      period: single("Period", 20, 2, 400),
      keep: single("Keep (bars)", 3, 1, 20),
    }),
  entry("bandBreakout", "volatility", "event", ["mc-bbrk"], "Bollinger breakout on range expansion",
    "Close breaks out of Bollinger(20, 2) on an expanding bar.", {}),
  entry("narrowRangeBreak", "volatility", "event", ["r-nr-break"], "Narrow-range breakout",
    "The bar after the narrowest of N bars closes beyond its range.", {
      n: range("Bars", 4, 7, 3, 2, 30),
    }),
  entry("choppinessBreak", "volatility", "event", ["r-chop"], "Choppiness break",
    "Choppiness falls out of a range regime: direction of the move over the period.", {
      p: range("Period", 14, 28, 14, 2, 200),
      lo: single("Trend level", 38.2, 1, 99, 0.1),
      hi: single("Range level", 61.8, 1, 99, 0.1),
      m: range("Range window", 20, 40, 20, 2, 300),
    }, { constraints: [["lo", "<", "hi"]] }),
  entry("expansionBreak", "volatility", "event", ["mc-brk"], "Expansion break",
    "Close beyond the prior N-bar high / low on a bar at least 1.2× the average range.", {
      period: range("Period", 10, 20, 10, 2, 400),
    }),
  entry("insideBarBreak", "volatility", "event", ["mc-ibrk"], "Inside-bar break",
    "An inside bar broken by the next close.", {}),

  // ── volume & flow ─────────────────────────────────────────────────────────────────
  entry("mfi", "volume", "state", ["mfi"], "MFI reversion",
    "Money flow index below the level (long) or above 100 − level (short).", {
      period: single("Period", 14, 2, 200),
      level: range("Level", 10, 20, 10, 1, 49),
    }),
  entry("cmf", "volume", "state", ["cmf"], "Chaikin money flow",
    "CMF above +threshold (long) or below −threshold (short).", {
      period: single("Period", 20, 2, 300),
      threshold: range("Threshold", 0.05, 0.1, 0.05, 0, 1, 0.01),
    }),
  entry("obvEma", "volume", "state", ["obv"], "OBV vs EMA",
    "On-balance volume above / below its EMA.", {
      period: range("EMA period", 20, 50, 30, 2, 400),
    }),
  entry("klinger", "volume", "event", ["r-klinger"], "Klinger cross",
    "Klinger volume oscillator crosses its signal on the side of zero.", {
      f: range("Fast", 34, 55, 21, 2, 300),
      s: range("Slow", 55, 89, 34, 3, 500),
      sig: range("Signal", 13, 21, 8, 2, 100),
    }, { constraints: [["f", "<", "s"]] }),
  entry("clvThrust", "volume", "event", ["r-clv-thrust"], "CLV thrust",
    "Wide bar on a volume spike closing at its extreme (continuation).", {
      clv: range("Close location", 0.8, 0.9, 0.1, 0.1, 1, 0.05),
      vz: range("Volume z", 1.5, 2, 0.5, 0, 10, 0.1),
      rng: range("Range (ATR)", 1, 1.3, 0.3, 0.1, 10, 0.1),
    }),
  entry("cvdDivergence", "volume", "event", ["r-cvd-div"], "Volume-delta divergence",
    "New N-bar extreme on a weaker cumulative close-location delta: fade it.", {
      p: range("Period", 20, 40, 20, 2, 400),
    }),
  entry("vwapReclaim", "volume", "event", ["r-vwap-reclaim"], "Session VWAP reclaim",
    "Close crosses the UTC-day VWAP on volume and holds for the confirmation bars.", {
      vz: range("Volume z", 1, 1.5, 0.5, 0, 10, 0.1),
      hold: range("Confirmation bars", 1, 2, 1, 0, 20),
    }, { requiresWallClock: true }),
  entry("vwapVolumeCross", "volume", "event", ["mc-vwapx"], "VWAP cross on volume",
    "Close crosses the rolling VWAP(60) on volume above a multiple of its average.", {
      volumeRatio: range("Volume ratio", 1.5, 2, 0.5, 0.5, 10, 0.1),
    }),
  entry("volumeBurst", "volume", "event", ["mc-burst", "mc-qburst"], "Activity burst",
    "Volume × range burst on a directional bar (quiet = 1: only out of a narrow band).", {
      multiplier: range("Multiplier", 2, 3, 1, 1, 20, 0.1),
      quiet: range("Quiet filter", 0, 1, 1, 0, 1),
    }),
  entry("valueArea", "volume", "event", ["r-valuearea"], "Value-area re-entry",
    "Close re-enters the volume value area from outside.", {
      look: range("Lookback", 96, 192, 96, 10, 2000),
      va: single("Value area", 0.7, 0.1, 0.99, 0.01),
    }),
  entry("quarterHourFlow", "volume", "event", ["r-qh-flow"], "Quarter-hour order flow",
    "Pooled close-location-weighted volume of the last quarter-hour boundary bars.", {
      n: range("Boundary bars", 4, 8, 4, 1, 50),
      thr: range("Threshold", 0.3, 0.35, 0.05, 0, 5, 0.01),
    }, { requiresWallClock: true }),
  entry("quarterHourReversal", "volume", "event", ["r-qh-rev"], "Quarter-hour burst reversal",
    "A quarter-hour boundary bar with an outsized return on a volume burst: fade it.", {
      z: range("Return z", 2.5, 3, 0.5, 0.5, 10, 0.1),
      vx: range("Volume ratio", 1.5, 2, 0.5, 0.5, 20, 0.1),
    }, { requiresWallClock: true }),

  // ── structure & price action ──────────────────────────────────────────────────────
  entry("swingPosition", "structure", "state", ["move-swing"], "Swing position",
    "Close in the top (long) or bottom (short) quarter of the prior N-bar range.", {
      period: range("Period", 8, 32, 12, 2, 400),
    }),
  entry("stopSweep", "structure", "event", ["r-sweep"], "Stop-run reversal",
    "Pierce of the prior extreme closing back inside on a long wick and volume.", {
      p: range("Period", 20, 40, 20, 2, 400),
      wick: single("Wick share", 0.6, 0.1, 1, 0.05),
      vz: range("Volume z", 1.5, 2, 0.5, 0, 10, 0.1),
    }),
  entry("capitulation", "structure", "event", ["r-capit"], "Forced-flow fade",
    "A bar of several ATR on a volume spike closing off its extreme: fade it.", {
      mul: range("ATR multiplier", 3, 3.5, 0.5, 0.5, 20, 0.1),
      vz: range("Volume z", 3, 3.5, 0.5, 0, 10, 0.1),
    }),
  entry("fractalBreak", "structure", "event", ["r-fractal"], "Fractal breakout",
    "Close crosses the newest confirmed fractal on the side of the EMA with an efficient trend.", {
      w: range("Fractal width", 2, 3, 1, 1, 20),
      ema: range("EMA", 50, 100, 50, 2, 500),
    }),
  entry("camarillaPivots", "structure", "event", ["r-camarilla"], "Camarilla pivots",
    "Rejection at R3 / S3 or a break of R4 / S4 of the previous UTC day.", {
      rej: range("Rejection wick", 0.5, 0.7, 0.2, 0.1, 1, 0.05),
    }, { requiresWallClock: true }),
  entry("spring", "structure", "event", ["r-spring"], "Wyckoff spring",
    "Shallow pierce of a narrow range that closes back inside (spring / upthrust).", {
      p: range("Period", 40, 60, 20, 5, 400),
      width: range("Range width (ATR)", 4, 5, 1, 0.5, 20, 0.1),
      pierce: range("Pierce (ATR)", 0.5, 0.7, 0.2, 0.05, 5, 0.05),
    }),
  entry("openingRangeBreak", "structure", "event", ["r-orb"], "Opening-range breakout",
    "Break of the 00:00 / 13:30 UTC opening range within eight hours.", {
      bars: range("Range bars", 4, 8, 4, 1, 100),
      minW: range("Min width (ATR)", 0.5, 0.7, 0.2, 0, 5, 0.05),
    }, { requiresWallClock: true }),
  entry("previousDayBreak", "structure", "event", ["r-pdhl"], "Previous-day break and retest",
    "Break of the previous UTC day's high / low and a held retest.", {
      brk: range("Break (ATR)", 0.15, 0.3, 0.15, 0, 5, 0.05),
      ret: range("Retest (ATR)", 0.05, 0.1, 0.05, 0, 5, 0.01),
    }, { requiresWallClock: true }),
  entry("breakOfStructure", "structure", "event", ["r-bos"], "Break of structure",
    "Close beyond the last swing in the direction of the swing structure.", {
      w: range("Swing width", 3, 5, 2, 1, 20),
      buf: range("Buffer (ATR)", 0.3, 0.4, 0.1, 0, 5, 0.05),
    }),
  entry("changeOfCharacter", "structure", "event", ["r-choch"], "Change of character",
    "Close beyond the last swing against the swing structure.", {
      w: range("Swing width", 3, 5, 2, 1, 20),
      buf: range("Buffer (ATR)", 0.2, 0.3, 0.1, 0, 5, 0.05),
    }),
  entry("fairValueGap", "structure", "event", ["r-fvg"], "Fair value gap retest",
    "Retest of a displacement gap that holds.", {
      disp: range("Displacement (ATR)", 1.5, 2, 0.5, 0.1, 10, 0.1),
      gap: range("Gap (ATR)", 0.3, 0.5, 0.2, 0, 5, 0.05),
      ttl: range("Max age (bars)", 12, 20, 8, 2, 200),
    }),
  entry("insideBarTrend", "structure", "event", ["r-inside"], "Inside-bar breakout with trend",
    "Break of a wide mother bar after an inside bar, with the EMA slope.", {
      mother: range("Mother bar (ATR)", 1, 1.3, 0.3, 0.1, 10, 0.1),
      ema: range("EMA", 50, 100, 50, 2, 500),
    }),
  entry("engulfingVolume", "structure", "event", ["r-engulf"], "Engulfing at an extreme on volume",
    "Engulfing bar at a new extreme with a volume spike.", {
      mult: range("Body ratio", 1.5, 2, 0.5, 0.5, 10, 0.1),
      atr: range("Body (ATR)", 0.8, 1, 0.2, 0, 10, 0.1),
      look: range("Extreme lookback", 10, 20, 10, 2, 200),
    }),
  entry("engulfingExtreme", "structure", "event", ["mc-engulf"], "Engulfing at an extreme",
    "Engulfing bar at the prior N-bar extreme.", {
      period: range("Period", 20, 40, 20, 2, 400),
    }),
  entry("pinBar", "structure", "event", ["r-pin"], "Pin bar at an extreme",
    "Long-wick pin bar at the prior 20-bar extreme.", {
      wick: range("Wick ratio", 2, 2.5, 0.5, 0.5, 10, 0.1),
      rng: range("Range (ATR)", 1.2, 1.5, 0.3, 0.1, 10, 0.1),
    }),
  entry("rejectionWick", "structure", "event", ["mc-wick"], "Rejection wick at an extreme",
    "Rejection wick of a multiple of the body at the prior 20-bar extreme.", {
      multiplier: range("Wick multiple", 2, 3, 1, 0.5, 10, 0.1),
    }),
  entry("starPattern", "structure", "event", ["r-star"], "Morning / evening star",
    "Three-bar star reversal.", {
      small: range("Small body (ATR)", 0.25, 0.3, 0.05, 0.01, 5, 0.01),
      big: range("Big body (ATR)", 0.8, 1, 0.2, 0.1, 10, 0.1),
    }),
] as const

export type CommonCatalogType = (typeof COMMON_CATALOG)[number]["type"]

/** The types of the catalogue, in catalogue order. */
export const COMMON_CATALOG_TYPES: readonly CommonCatalogType[] = COMMON_CATALOG.map((item) => item.type)

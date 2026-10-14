// The classic CTS-A-O registry families (src/core/indications/registry.ts: BASE_INDICATIONS and VARIANTS), with
// each family's hard-coded constants turned into parameters. The rule bodies are the reference's: a family's
// default parameters reproduce its base indication, and its variant ids are other points of the same ranges.
import type { AoBoth } from "./define"
import * as I from "./math"
import type { SeriesCache } from "./series-cache"

const sgn = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0)
const ok = (...xs: number[]) => xs.every((x) => Number.isFinite(x))

/** per-bar directional state from f (NaN = 0) */
export function state(n: number, f: (i: number) => number): Int8Array {
  const out = new Int8Array(n)
  for (let i = 0; i < n; i++) {
    const v = f(i)
    out[i] = Number.isFinite(v) ? (sgn(v) as -1 | 0 | 1) : 0
  }
  return out
}

/** Extend event bars into a state that persists `keep` bars (latest event wins). */
export function hold(ev: Int8Array, keep: number): Int8Array {
  const span = Math.max(1, Math.round(keep))
  if (span <= 1) return ev
  const out = new Int8Array(ev.length)
  let cur = 0
  let left = 0
  for (let i = 0; i < ev.length; i++) {
    if (ev[i] !== 0) {
      cur = ev[i]
      left = span
    }
    if (left > 0) {
      out[i] = cur
      left--
    }
  }
  return out
}

/** Bollinger squeeze break (registry `squeezeBreak`): tight width on bar i−1, close outside the band on bar i. */
function squeezeBreak(k: SeriesCache, look: number, tight: number, keep: number): Int8Array {
  const { up, lo, width } = k.bb(20, 2)
  const c = k.b.c
  const n = k.b.n
  const ev = new Int8Array(n)
  for (let i = look; i < n; i++) {
    let minW = Infinity
    for (let j = i - look; j < i; j++) if (width[j] < minW) minW = width[j]
    if (width[i - 1] <= minW * tight) ev[i] = c[i] > up[i] ? 1 : c[i] < lo[i] ? -1 : 0
  }
  return hold(ev, keep)
}

const reclaim = (k: SeriesCache, e: Float64Array) => {
  const c = k.b.c
  return state(k.b.n, (i) =>
    i > 0 && ok(e[i - 1])
      ? c[i - 1] < e[i - 1] && c[i] > e[i]
        ? 1
        : c[i - 1] > e[i - 1] && c[i] < e[i]
          ? -1
          : 0
      : 0,
  )
}

/** Register every classic family. Short / medium are representative points of the family (documentation only). */
export function registerClassic(both: AoBoth): void {
  // ── trend ───────────────────────────────────────────────
  both("trend", "trend-ema", "EMA trend (fast above slow, close above slow)", { fast: 9, slow: 21 }, { fast: 20, slow: 50 }, (k, p) => {
    const f = k.ema(p.fast)
    const s = k.ema(p.slow)
    const c = k.b.c
    return state(k.b.n, (i) =>
      ok(f[i], s[i]) ? (f[i] > s[i] && c[i] > s[i] ? 1 : f[i] < s[i] && c[i] < s[i] ? -1 : 0) : NaN,
    )
  })
  both("trend", "trend-st", "Supertrend", { period: 10, multiplier: 3 }, { period: 21, multiplier: 4 }, (k, p) => k.st(p.period, p.multiplier).dir)
  both("trend", "trend-ribbon", "EMA ribbon", { fast: 9, mid: 21, slow: 55 }, { fast: 9, mid: 21, slow: 89 }, (k, p) => {
    const a = k.ema(p.fast)
    const b = k.ema(p.mid)
    const c = k.ema(p.slow)
    return state(k.b.n, (i) =>
      ok(a[i], b[i], c[i]) ? (a[i] > b[i] && b[i] > c[i] ? 1 : a[i] < b[i] && b[i] < c[i] ? -1 : 0) : NaN,
    )
  })
  both("ema", "ema-slope", "EMA slope", { period: 20, lookback: 5 }, { period: 50, lookback: 5 }, (k, p) => {
    const e = k.ema(p.period)
    const n = p.lookback
    return state(k.b.n, (i) => (i >= n && ok(e[i - n]) ? e[i] - e[i - n] : NaN))
  })
  both("direction", "dir-reclaim", "EMA reclaim", { period: 21, keep: 4 }, { period: 50, keep: 4 }, (k, p) =>
    hold(reclaim(k, k.ema(p.period)), p.keep),
  )
  both("ema", "ema-pullback", "EMA pullback in trend", { fast: 21, slow: 55 }, { fast: 50, slow: 100 }, (k, p) => {
    const e = k.ema(p.fast)
    const e2 = k.ema(p.slow)
    const { c, l, h } = k.b
    return state(k.b.n, (i) => {
      if (!ok(e[i], e2[i])) return NaN
      if (e[i] > e2[i] && l[i] <= e[i] && c[i] > e[i]) return 1
      if (e[i] < e2[i] && h[i] >= e[i] && c[i] < e[i]) return -1
      return 0
    })
  })
  both("ichimoku", "ichi-tk", "Ichimoku TK", { tenkan: 9, kijun: 26, senkou: 52 }, { tenkan: 20, kijun: 60, senkou: 120 }, (k, p) => {
    const x = k.ichi(p.tenkan, p.kijun, p.senkou)
    return state(k.b.n, (i) => (ok(x.tenkan[i], x.kijun[i]) ? x.tenkan[i] - x.kijun[i] : NaN))
  })
  both("ichimoku", "ichi-cloud", "Ichimoku cloud", { tenkan: 9, kijun: 26, senkou: 52 }, { tenkan: 20, kijun: 60, senkou: 120 }, (k, p) => {
    const x = k.ichi(p.tenkan, p.kijun, p.senkou)
    const c = k.b.c
    return state(k.b.n, (i) => {
      if (!ok(x.spanA[i], x.spanB[i])) return NaN
      const top = Math.max(x.spanA[i], x.spanB[i])
      const bot = Math.min(x.spanA[i], x.spanB[i])
      return c[i] > top && x.tenkan[i] > x.kijun[i] ? 1 : c[i] < bot && x.tenkan[i] < x.kijun[i] ? -1 : 0
    })
  })
  both("channel", "aroon", "Aroon", { period: 14, level: 70 }, { period: 25, level: 70 }, (k, p) => {
    const { up, dn } = k.aroon(p.period)
    const hi = p.level
    const lo = 100 - p.level
    return state(k.b.n, (i) => (up[i] > hi && dn[i] < lo ? 1 : dn[i] > hi && up[i] < lo ? -1 : 0))
  })
  both("smooth", "hma", "HMA slope", { period: 16 }, { period: 55 }, (k, p) => {
    const x = k.hma(p.period)
    return state(k.b.n, (i) => (i > 0 && ok(x[i], x[i - 1]) ? x[i] - x[i - 1] : NaN))
  })
  both("smooth", "trix", "TRIX", { period: 9 }, { period: 15 }, (k, p) => {
    const x = k.trix(p.period)
    return state(k.b.n, (i) => x[i])
  })
  both("smooth", "kama", "KAMA", { period: 10 }, { period: 20 }, (k, p) => {
    const x = k.kama(p.period)
    const c = k.b.c
    return state(k.b.n, (i) =>
      i > 0 && ok(x[i], x[i - 1]) ? (c[i] > x[i] && x[i] > x[i - 1] ? 1 : c[i] < x[i] && x[i] < x[i - 1] ? -1 : 0) : NaN,
    )
  })
  both("smooth", "ha", "Heikin-Ashi", { bars: 1 }, { bars: 3 }, (k, p) => {
    const x = k.ha()
    const n = Math.max(1, Math.round(p.bars))
    return state(k.b.n, (i) => {
      if (i < n - 1) return NaN
      let up = 0
      let dn = 0
      for (let j = i - n + 1; j <= i; j++) {
        if (x.c[j] > x.o[j]) up++
        else if (x.c[j] < x.o[j]) dn++
      }
      return up === n ? 1 : dn === n ? -1 : 0
    })
  })

  // ── momentum / direction / move ─────────────────────────
  both("rsi", "rsi-mom", "RSI momentum", { period: 14, level: 45 }, { period: 21, level: 20 }, (k, p) => {
    const r = k.rsi(p.period)
    return state(k.b.n, (i) => (r[i] > 100 - p.level ? 1 : r[i] < p.level ? -1 : 0))
  })
  both("macd", "macd-cross", "MACD signal cross", { fast: 12, slow: 26, signal: 9, keep: 6 }, { fast: 8, slow: 21, signal: 5, keep: 6 }, (k, p) => {
    const { line, signal } = k.macd(p.fast, p.slow, p.signal)
    return hold(
      state(k.b.n, (i) =>
        i > 0 && ok(signal[i - 1])
          ? line[i - 1] < signal[i - 1] && line[i] > signal[i]
            ? 1
            : line[i - 1] > signal[i - 1] && line[i] < signal[i]
              ? -1
              : 0
          : 0,
      ),
      p.keep,
    )
  })
  both("macd", "macd-hist", "MACD histogram rising", { fast: 12, slow: 26, signal: 9 }, { fast: 19, slow: 39, signal: 9 }, (k, p) => {
    const { hist } = k.macd(p.fast, p.slow, p.signal)
    return state(k.b.n, (i) =>
      i > 1 && ok(hist[i - 2])
        ? hist[i] > hist[i - 1] && hist[i - 1] > hist[i - 2]
          ? 1
          : hist[i] < hist[i - 1] && hist[i - 1] < hist[i - 2]
            ? -1
            : 0
        : NaN,
    )
  })
  both("macd", "macd-zero", "MACD zero line", { fast: 12, slow: 26 }, { fast: 19, slow: 39 }, (k, p) => {
    const { line } = k.macd(p.fast, p.slow, 9)
    return state(k.b.n, (i) => line[i])
  })
  both("move", "move-impulse", "Impulse", { bars: 6, multiplier: 1.5, keep: 4 }, { bars: 20, multiplier: 2.5, keep: 4 }, (k, p) => {
    const a = k.atr(14)
    const c = k.b.c
    const n = Math.max(1, Math.round(p.bars))
    return hold(
      state(k.b.n, (i) => (i >= n && ok(a[i]) && Math.abs(c[i] - c[i - n]) > p.multiplier * a[i] ? c[i] - c[i - n] : 0)),
      p.keep,
    )
  })
  both("move", "move-cont", "Continuation pullback", { longRoc: 12, shortRoc: 3, thresholdPct: 0.4 }, { longRoc: 24, shortRoc: 3, thresholdPct: 0.6 }, (k, p) => {
    const r12 = k.roc(p.longRoc)
    const r3 = k.roc(p.shortRoc)
    const t = p.thresholdPct / 100
    return state(k.b.n, (i) =>
      ok(r12[i], r3[i]) ? (r12[i] > t && r3[i] < 0 ? 1 : r12[i] < -t && r3[i] > 0 ? -1 : 0) : NaN,
    )
  })
  both("direction", "dir-thrust", "Bar thrust", { bars: 3, keep: 3 }, { bars: 4, keep: 3 }, (k, p) => {
    const { c, o } = k.b
    const n = Math.max(2, Math.round(p.bars))
    return hold(
      state(k.b.n, (i) => {
        if (i < n - 1) return 0
        let u = true
        let d = true
        for (let j = i - n + 1; j <= i; j++) {
          if (!(c[j] > o[j] && (j === i - n + 1 || c[j] > c[j - 1]))) u = false
          if (!(c[j] < o[j] && (j === i - n + 1 || c[j] < c[j - 1]))) d = false
        }
        return u ? 1 : d ? -1 : 0
      }),
      p.keep,
    )
  })
  both("active", "act-hf", "HF momentum", { bars: 3 }, { bars: 8 }, (k, p) => {
    const a = k.atr(14)
    const c = k.b.c
    const n = Math.max(1, Math.round(p.bars))
    return state(k.b.n, (i) => {
      if (i < n || !ok(a[i])) return NaN
      const d = c[i] - c[i - n]
      return Math.abs(d) > 0.9 * a[i] * Math.sqrt(n / 3) ? d : 0
    })
  })

  // ── oscillator (reversion) ──────────────────────────────
  both("rsi", "rsi-extreme", "RSI reversion", { period: 14, level: 30 }, { period: 7, level: 20 }, (k, p) => {
    const r = k.rsi(p.period)
    return state(k.b.n, (i) => (r[i] < p.level ? 1 : r[i] > 100 - p.level ? -1 : 0))
  })
  both("rsi", "rsi-div", "RSI divergence", { period: 14, lookback: 10, keep: 4 }, { period: 14, lookback: 20, keep: 4 }, (k, p) => {
    const r = k.rsi(p.period)
    const c = k.b.c
    const n = Math.max(1, Math.round(p.lookback))
    return hold(
      state(k.b.n, (i) => {
        if (i < n || !ok(r[i], r[i - n])) return 0
        if (c[i] < c[i - n] && r[i] > r[i - n] + 4 && r[i] < 45) return 1
        if (c[i] > c[i - n] && r[i] < r[i - n] - 4 && r[i] > 55) return -1
        return 0
      }),
      p.keep,
    )
  })
  both("osc", "cci-revert", "CCI reversion", { period: 20, level: 100 }, { period: 40, level: 200 }, (k, p) => {
    const x = k.cci(p.period)
    return state(k.b.n, (i) => (x[i] < -p.level ? 1 : x[i] > p.level ? -1 : 0))
  })
  both("osc", "srsi", "Stochastic RSI", { period: 14, level: 20 }, { period: 14, level: 10 }, (k, p) => {
    const x = k.stochRsi(p.period)
    return state(k.b.n, (i) => (x[i] < p.level ? 1 : x[i] > 100 - p.level ? -1 : 0))
  })
  both("osc", "z", "Z-score", { period: 20, threshold: 2 }, { period: 50, threshold: 2.5 }, (k, p) => {
    const x = k.z(p.period)
    return state(k.b.n, (i) => (x[i] < -p.threshold ? 1 : x[i] > p.threshold ? -1 : 0))
  })
  both("ema", "ema-stoch", "EMA trend + Stochastic dip", { fast: 21, slow: 55, kPeriod: 14, level: 25 }, { fast: 21, slow: 55, kPeriod: 14, level: 20 }, (k, p) => {
    const e = k.ema(p.fast)
    const e2 = k.ema(p.slow)
    const { k: st } = k.stoch(p.kPeriod, 3)
    return state(k.b.n, (i) =>
      ok(e[i], e2[i], st[i]) ? (e[i] > e2[i] && st[i] < p.level ? 1 : e[i] < e2[i] && st[i] > 100 - p.level ? -1 : 0) : NaN,
    )
  })
  both("active", "act-chop", "Chop fade", { adxMax: 18, rsiPeriod: 7, level: 30 }, { adxMax: 15, rsiPeriod: 7, level: 25 }, (k, p) => {
    const { adx } = k.dmi(14)
    const r = k.rsi(p.rsiPeriod)
    return state(k.b.n, (i) =>
      ok(adx[i], r[i]) && adx[i] < p.adxMax ? (r[i] < p.level ? 1 : r[i] > 100 - p.level ? -1 : 0) : 0,
    )
  })

  // ── volatility / breaks ─────────────────────────────────
  both("break", "break-don", "Donchian break", { period: 20, keep: 6 }, { period: 55, keep: 6 }, (k, p) => {
    const { hi, lo } = k.don(p.period)
    const c = k.b.c
    return hold(state(k.b.n, (i) => (c[i] > hi[i] ? 1 : c[i] < lo[i] ? -1 : 0)), p.keep)
  })
  both("break", "break-vol", "Break + volume", { period: 20, volumeRatio: 1.6, keep: 6 }, { period: 20, volumeRatio: 2, keep: 6 }, (k, p) => {
    const { hi, lo } = k.don(p.period)
    const c = k.b.c
    const v = k.b.v
    const vs = k.volSma(20)
    return hold(
      state(k.b.n, (i) => (v[i] > p.volumeRatio * vs[i] ? (c[i] > hi[i] ? 1 : c[i] < lo[i] ? -1 : 0) : 0)),
      p.keep,
    )
  })
  both("break", "break-atr", "ATR expansion", { multiplier: 1.15, keep: 4 }, { multiplier: 2, keep: 4 }, (k, p) => {
    const a = k.atr(14)
    const c = k.b.c
    return hold(
      state(k.b.n, (i) =>
        i > 0 && ok(a[i - 1]) && Math.abs(c[i] - c[i - 1]) > p.multiplier * a[i - 1] ? c[i] - c[i - 1] : 0,
      ),
      p.keep,
    )
  })
  both("break", "break-squeeze", "BB squeeze break", { lookback: 60, tightness: 1.15, keep: 8 }, { lookback: 120, tightness: 1.25, keep: 8 }, (k, p) =>
    squeezeBreak(k, Math.max(2, Math.round(p.lookback)), p.tightness, p.keep),
  )
  both("break", "break-retest", "Break retest hold", { period: 20, window: 8, keep: 5 }, { period: 40, window: 8, keep: 5 }, (k, p) => {
    const { hi, lo } = k.don(p.period)
    const { c, l, h } = k.b
    const n = k.b.n
    const ev = new Int8Array(n)
    let lastUp = -99
    let lastDn = -99
    let lvlU = 0
    let lvlD = 0
    for (let i = 1; i < n; i++) {
      if (c[i] > hi[i]) {
        lastUp = i
        lvlU = hi[i]
      }
      if (c[i] < lo[i]) {
        lastDn = i
        lvlD = lo[i]
      }
      if (i - lastUp > 1 && i - lastUp <= p.window && l[i] <= lvlU * 1.001 && c[i] > lvlU) ev[i] = 1
      if (i - lastDn > 1 && i - lastDn <= p.window && h[i] >= lvlD * 0.999 && c[i] < lvlD) ev[i] = -1
    }
    return hold(ev, p.keep)
  })
  both("break", "break-fail", "Failed break fade", { period: 20, keep: 5 }, { period: 40, keep: 5 }, (k, p) => {
    const { hi, lo } = k.don(p.period)
    const { c, h, l } = k.b
    return hold(state(k.b.n, (i) => (h[i] > hi[i] && c[i] < hi[i] ? -1 : l[i] < lo[i] && c[i] > lo[i] ? 1 : 0)), p.keep)
  })
  both("active", "act-burst", "Range burst", { multiplier: 1.8, keep: 4 }, { multiplier: 2.5, keep: 4 }, (k, p) => {
    const rs = k.rangeSma(20)
    const { o, c, h, l } = k.b
    return hold(state(k.b.n, (i) => (i > 0 && h[i] - l[i] > p.multiplier * rs[i - 1] ? c[i] - o[i] : 0)), p.keep)
  })
  both("active", "act-shift", "Range shift", { short: 20, long: 60, ratio: 1.2 }, { short: 20, long: 60, ratio: 1.4 }, (k, p) => {
    const a = k.rangeSma(p.short)
    const b = k.rangeSma(p.long)
    const r = k.roc(10)
    return state(k.b.n, (i) => (ok(a[i], b[i], r[i]) && a[i] > p.ratio * b[i] ? r[i] : 0))
  })
  both("bollinger", "bb-walk", "BB band walk", { period: 20, stdDev: 2 }, { period: 50, stdDev: 2 }, (k, p) => {
    const { up, lo } = k.bb(p.period, p.stdDev)
    const c = k.b.c
    return state(k.b.n, (i) =>
      i > 0 && c[i] > up[i] && c[i - 1] > up[i - 1] ? 1 : i > 0 && c[i] < lo[i] && c[i - 1] < lo[i - 1] ? -1 : 0,
    )
  })
  both("bollinger", "bb-mid", "BB mid reclaim", { period: 20, keep: 4 }, { period: 50, keep: 4 }, (k, p) =>
    hold(reclaim(k, k.bb(p.period, 2).mid), p.keep),
  )
  both("bollinger", "bb-wick", "BB wick tag", { period: 20, keep: 3 }, { period: 50, keep: 3 }, (k, p) => {
    const { up, lo } = k.bb(p.period, 2)
    const { c, h, l } = k.b
    return hold(state(k.b.n, (i) => (l[i] < lo[i] && c[i] > lo[i] ? 1 : h[i] > up[i] && c[i] < up[i] ? -1 : 0)), p.keep)
  })
  both("channel", "kelt", "Keltner break", { period: 20, multiplier: 2, keep: 4 }, { period: 20, multiplier: 2.5, keep: 4 }, (k, p) => {
    const { up, lo } = k.kelt(p.period, p.multiplier)
    const c = k.b.c
    return hold(state(k.b.n, (i) => (c[i] > up[i] ? 1 : c[i] < lo[i] ? -1 : 0)), p.keep)
  })
  both("channel", "squeeze", "BB/Keltner squeeze release", { period: 20, kcMultiplier: 1.5, keep: 6 }, { period: 30, kcMultiplier: 1.5, keep: 6 }, (k, p) => {
    const bb = k.bb(p.period, 2)
    const kc = k.kelt(p.period, p.kcMultiplier)
    const c = k.b.c
    return hold(
      state(k.b.n, (i) => {
        if (i < 1 || !ok(bb.up[i], kc.up[i], bb.up[i - 1], kc.up[i - 1])) return 0
        const was = bb.up[i - 1] < kc.up[i - 1] && bb.lo[i - 1] > kc.lo[i - 1]
        const now = bb.up[i] < kc.up[i] && bb.lo[i] > kc.lo[i]
        return was && !now ? c[i] - kc.mid[i] : 0
      }),
      p.keep,
    )
  })

  // ── volume ──────────────────────────────────────────────
  both("volume", "mfi", "MFI reversion", { period: 14, level: 20 }, { period: 14, level: 10 }, (k, p) => {
    const x = k.mfi(p.period)
    return state(k.b.n, (i) => (x[i] < p.level ? 1 : x[i] > 100 - p.level ? -1 : 0))
  })
  both("volume", "obv-ema", "OBV vs EMA", { period: 20 }, { period: 50 }, (k, p) => {
    const o = k.obv()
    const e = k.memo(`obvema${p.period}`, () => I.ema(o, p.period))
    return state(k.b.n, (i) => (ok(e[i]) ? o[i] - e[i] : NaN))
  })
  both("volume", "cmf", "Chaikin money flow", { period: 20, threshold: 0.05 }, { period: 20, threshold: 0.1 }, (k, p) => {
    const x = k.cmf(p.period)
    return state(k.b.n, (i) => (x[i] > p.threshold ? 1 : x[i] < -p.threshold ? -1 : 0))
  })

  // ── structure ───────────────────────────────────────────
  both("move", "move-swing", "Swing position", { period: 8 }, { period: 32 }, (k, p) => {
    const { hi, lo } = k.don(p.period)
    const c = k.b.c
    return state(k.b.n, (i) =>
      ok(hi[i], lo[i])
        ? c[i] > hi[i] - (hi[i] - lo[i]) * 0.25
          ? 1
          : c[i] < lo[i] + (hi[i] - lo[i]) * 0.25
            ? -1
            : 0
        : NaN,
    )
  })
}

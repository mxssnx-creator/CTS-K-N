// Ported from CTS-A-O src/core/indications/micro.ts: the single-symbol Micro events only (stretch events, the 4×
// higher-timeframe trend filter, the quiet filter, continuation / break / activity / RSI / pattern events). The
// market-relation events (mc-lag, mc-rsrev, mc-mturn, mc-act-*, mc-irsi2, mc-mrsi2, mc-iz, mc-ivwapd) need the
// multi-symbol universe and are not ported: Common indications are evaluated per symbol. Rule bodies are the
// reference's; do not change one here without changing it there.
import type { SeriesCache } from "./series-cache"

const fin = (...xs: number[]) => xs.every((x) => Number.isFinite(x));

/** one-bar event series: f returns +1 / −1 on the firing bar, 0 otherwise (NaN in warm-up = 0) */
function events(n: number, f: (i: number) => number): Int8Array {
  const out = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const v = f(i);
    out[i] = v > 0 ? 1 : v < 0 ? -1 : 0;
  }
  return out;
}

// ── the stretch events (memoized per series: the trend variants reuse them) ─────────────────────────────────────

/** RSI(2) below lo (+1) / above 100 − lo (−1) */
export const rsi2Ev = (k: SeriesCache, lo: number) =>
  k.memo(`mc:rsi2:${lo}`, () => {
    const r = k.rsi(2);
    return events(k.b.n, (i) => (fin(r[i]) ? (r[i] < lo ? 1 : r[i] > 100 - lo ? -1 : 0) : 0));
  });

/** a close outside Bollinger(20, m) and the next bar turning back */
export const bbxEv = (k: SeriesCache, m: number) =>
  k.memo(`mc:bbx:${m}`, () => {
    const { up, lo } = k.bb(20, m);
    const c = k.b.c;
    return events(k.b.n, (i) => {
      if (i < 1 || !fin(up[i - 1], lo[i - 1])) return 0;
      if (c[i - 1] < lo[i - 1] && c[i] > c[i - 1]) return 1;
      if (c[i - 1] > up[i - 1] && c[i] < c[i - 1]) return -1;
      return 0;
    });
  });

/** a spike bar (range ≥ x × the prior 20-bar average) rejected: it closes in its opposite third */
export const spikeEv = (k: SeriesCache, x: number) =>
  k.memo(`mc:spike:${x}`, () => {
    const rs = k.rangeSma(20);
    const { o, h, l, c } = k.b;
    return events(k.b.n, (i) => {
      if (i < 1 || !fin(rs[i - 1])) return 0;
      const r = h[i] - l[i];
      if (!(r >= x * rs[i - 1]) || !(r > 0)) return 0;
      const pos = (c[i] - l[i]) / r;
      if (c[i] < o[i] && pos > 0.6) return 1;
      if (c[i] > o[i] && pos < 0.4) return -1;
      return 0;
    });
  });

/** n closes in a row the same way: fade the run on its n-th bar */
export const streakEv = (k: SeriesCache, n: number) =>
  k.memo(`mc:streak:${n}`, () => {
    const c = k.b.c;
    return events(k.b.n, (i) => {
      if (i < n) return 0;
      let up = 0;
      let dn = 0;
      for (let j = i - n + 1; j <= i; j++) {
        if (c[j] > c[j - 1]) up++;
        else if (c[j] < c[j - 1]) dn++;
      }
      return dn === n ? 1 : up === n ? -1 : 0;
    });
  });

/** distance from the rolling 60-bar VWAP beyond d × ATR(14) */
export const vwapdEv = (k: SeriesCache, d: number) =>
  k.memo(`mc:vwapd:${d}`, () => {
    const vw = k.vwap(60);
    const a = k.atr(14);
    const c = k.b.c;
    return events(k.b.n, (i) => {
      if (!fin(vw[i], a[i]) || !(a[i] > 0)) return 0;
      const z = (c[i] - vw[i]) / a[i];
      return z < -d ? 1 : z > d ? -1 : 0;
    });
  });

/** z-score of the close over 30 bars beyond z */
export const zEv = (k: SeriesCache, z: number) =>
  k.memo(`mc:z:${z}`, () => {
    const zs = k.z(30);
    return events(k.b.n, (i) => (fin(zs[i]) ? (zs[i] < -z ? 1 : zs[i] > z ? -1 : 0) : 0));
  });

// ── trend and confirmation ───────────────────────────────────────────────────────────────────────────────────────

/** Higher-timeframe factor and EMA period of the Micro trend filter. */
export const MICRO_TREND = { factor: 4, ema: 50 } as const;

/**
 * Trend of the 4× timeframe at each bar: +1 when the last COMPLETED higher bar closed above its EMA(50), −1 below,
 * 0 before the first one (or warm-up). Causal: a higher bar counts only from the lane bar it closes with.
 */
export function microTrend(k: SeriesCache): Int8Array {
  return k.memo(`mc:trend:${MICRO_TREND.factor}:${MICRO_TREND.ema}`, () => {
    const { k: hk, map } = k.htf(MICRO_TREND.factor);
    const e = hk.ema(MICRO_TREND.ema);
    const hc = hk.b.c;
    const out = new Int8Array(k.b.n);
    for (let i = 0; i < k.b.n; i++) {
      const j = map[i];
      if (j < 0 || !fin(e[j])) continue;
      out[i] = hc[j] > e[j] ? 1 : hc[j] < e[j] ? -1 : 0;
    }
    return out;
  });
}

/** the stretch event only where it points with the trend */
export function withTrend(k: SeriesCache, ev: Int8Array): Int8Array {
  const tr = microTrend(k);
  return events(k.b.n, (i) => (ev[i] !== 0 && ev[i] === tr[i] ? ev[i] : 0));
}

/**
 * The turn after a stretch, with the trend: the stretch fired on the previous bar, this bar closes beyond the
 * stretched bar's high (long) / low (short), and the trend points the same way.
 */
export function turnWithTrend(k: SeriesCache, ev: Int8Array): Int8Array {
  const tr = microTrend(k);
  const { h, l, c } = k.b;
  return events(k.b.n, (i) => {
    if (i < 1) return 0;
    const d = ev[i - 1];
    if (!d || tr[i] !== d) return 0;
    return d > 0 && c[i] > h[i - 1] ? 1 : d < 0 && c[i] < l[i - 1] ? -1 : 0;
  });
}

/** Quiet-market filter of the Micro range reversion: ADX(14) below this and the Bollinger width below its median. */
export const MICRO_QUIET = { adx: 12, widthRank: 0.5, lookback: 100 } as const;

/**
 * Rank of the Bollinger(20, 2) width at each bar among the previous `lookback` widths (0 = the narrowest, NaN in
 * warm-up). Causal: bar i compares with bars i − lookback … i − 1.
 */
export function bbWidthRank(k: SeriesCache, lookback: number = MICRO_QUIET.lookback): Float64Array {
  return k.memo(`mc:wrank:${lookback}`, () => {
    const { width } = k.bb(20, 2);
    const out = new Float64Array(k.b.n).fill(NaN);
    for (let i = lookback; i < k.b.n; i++) {
      if (!Number.isFinite(width[i])) continue;
      let below = 0;
      let cnt = 0;
      for (let j = i - lookback; j < i; j++)
        if (Number.isFinite(width[j])) {
          cnt++;
          if (width[j] < width[i]) below++;
        }
      if (cnt > lookback / 2) out[i] = below / cnt;
    }
    return out;
  });
}

/** the stretch event only in a quiet, trendless market (ADX(14) < 12 and the band narrower than its median) */
export function inQuiet(k: SeriesCache, ev: Int8Array): Int8Array {
  const { adx } = k.dmi(14);
  const wr = bbWidthRank(k);
  return events(k.b.n, (i) => (ev[i] !== 0 && fin(adx[i], wr[i]) && adx[i] < MICRO_QUIET.adx && wr[i] < MICRO_QUIET.widthRank ? ev[i] : 0));
}


// ── continuation, break, own activity, RSI and pattern events (operator, 5 Oct: "extend indications — trend, break,
// active, rsi and others"). Every one is causal (bar i reads bars ≤ i) and mirrors by construction; Base decides
// per window which of them carry an edge at Micro's distances. ───────────────────────────────────────────────────

/** pullback to the EMA(p) in the 4× trend, resumed: the previous close at or through the EMA, this close back beyond it */
export const tpullEv = (k: SeriesCache, p: number) =>
  k.memo(`mc:tpull:${p}`, () => {
    const tr = microTrend(k);
    const e = k.ema(p);
    const c = k.b.c;
    return events(k.b.n, (i) => {
      if (i < 1 || !fin(e[i - 1], e[i])) return 0;
      if (tr[i] > 0 && c[i - 1] <= e[i - 1] && c[i] > e[i]) return 1;
      if (tr[i] < 0 && c[i - 1] >= e[i - 1] && c[i] < e[i]) return -1;
      return 0;
    });
  });

/** EMA(f) crossing the EMA(s) with the trend */
export const tcrossEv = (k: SeriesCache, f: number, s: number) =>
  k.memo(`mc:tcross:${f}:${s}`, () => {
    const tr = microTrend(k);
    const ef = k.ema(f);
    const es = k.ema(s);
    return events(k.b.n, (i) => {
      if (i < 1 || !fin(ef[i - 1], es[i - 1], ef[i], es[i])) return 0;
      if (tr[i] > 0 && ef[i - 1] <= es[i - 1] && ef[i] > es[i]) return 1;
      if (tr[i] < 0 && ef[i - 1] >= es[i - 1] && ef[i] < es[i]) return -1;
      return 0;
    });
  });

/** n closes in a row with the trend right after a counter-trend close: the resumption bar */
export const tmomEv = (k: SeriesCache, n: number) =>
  k.memo(`mc:tmom:${n}`, () => {
    const tr = microTrend(k);
    const c = k.b.c;
    return events(k.b.n, (i) => {
      if (i < n + 1 || tr[i] === 0) return 0;
      const d = tr[i];
      for (let j = i - n + 1; j <= i; j++) if (!(d * (c[j] - c[j - 1]) > 0)) return 0;
      const j0 = i - n;
      return d * (c[j0] - c[j0 - 1]) < 0 ? d : 0;
    });
  });

/** close beyond the prior p-bar high / low on a bar at least 1.2 × the average range */
export const brkEv = (k: SeriesCache, p: number) =>
  k.memo(`mc:brk:${p}`, () => {
    const { hi, lo } = k.don(p);
    const rs = k.rangeSma(20);
    const { h, l, c } = k.b;
    return events(k.b.n, (i) => {
      if (i < 1 || !fin(hi[i], lo[i], rs[i - 1]) || !(h[i] - l[i] >= 1.2 * rs[i - 1])) return 0;
      return c[i] > hi[i] ? 1 : c[i] < lo[i] ? -1 : 0;
    });
  });

/** inside bar (bar i − 1 within bar i − 2) broken by this close */
export const ibrkEv = (k: SeriesCache) =>
  k.memo("mc:ibrk", () => {
    const { h, l, c } = k.b;
    return events(k.b.n, (i) => {
      if (i < 2 || !(h[i - 1] <= h[i - 2] && l[i - 1] >= l[i - 2])) return 0;
      return c[i] > h[i - 2] ? 1 : c[i] < l[i - 2] ? -1 : 0;
    });
  });

/** a close breaking out of Bollinger(20, 2) with the range expanding (the breakout; mc-bbx fades the turn back) */
export const bbrkEv = (k: SeriesCache) =>
  k.memo("mc:bbrk", () => {
    const { up, lo } = k.bb(20, 2);
    const rs = k.rangeSma(20);
    const { h, l, c } = k.b;
    return events(k.b.n, (i) => {
      if (i < 1 || !fin(up[i - 1], lo[i - 1], up[i], lo[i], rs[i - 1]) || !(h[i] - l[i] > rs[i - 1])) return 0;
      if (c[i - 1] <= up[i - 1] && c[i] > up[i]) return 1;
      if (c[i - 1] >= lo[i - 1] && c[i] < lo[i]) return -1;
      return 0;
    });
  });

/** the close crossing the rolling 60-bar VWAP on volume ≥ a × its 60-bar average */
export const vwapxEv = (k: SeriesCache, a: number) =>
  k.memo(`mc:vwapx:${a}`, () => {
    const vw = k.vwap(60);
    const vs = k.volSma(60);
    const { c, v } = k.b;
    return events(k.b.n, (i) => {
      if (i < 1 || !fin(vw[i - 1], vw[i], vs[i - 1]) || !(v[i] >= a * vs[i - 1])) return 0;
      if (c[i - 1] <= vw[i - 1] && c[i] > vw[i]) return 1;
      if (c[i - 1] >= vw[i - 1] && c[i] < vw[i]) return -1;
      return 0;
    });
  });

/** own activity (volume × range) of the bar against its 60-bar average, up to the previous bar */
const activity = (k: SeriesCache) =>
  k.memo("mc:activity", () => {
    const { h, l, v } = k.b;
    const act = new Float64Array(k.b.n);
    for (let i = 0; i < k.b.n; i++) act[i] = v[i] * (h[i] - l[i]);
    const avg = new Float64Array(k.b.n).fill(NaN);
    let s = 0;
    for (let i = 0; i < k.b.n; i++) {
      s += act[i];
      if (i >= 60) s -= act[i - 60];
      if (i >= 59) avg[i] = s / 60;
    }
    return { act, avg };
  });

/** an activity burst (≥ x × the average) on a directional bar, entered with the bar */
export const burstEv = (k: SeriesCache, x: number) =>
  k.memo(`mc:burst:${x}`, () => {
    const { act, avg } = activity(k);
    const { o, c } = k.b;
    return events(k.b.n, (i) => {
      if (i < 1 || !fin(avg[i - 1]) || !(avg[i - 1] > 0) || !(act[i] >= x * avg[i - 1])) return 0;
      return c[i] > o[i] ? 1 : c[i] < o[i] ? -1 : 0;
    });
  });

/** an activity burst out of a quiet stretch (the band narrower than its median on the previous bar) */
export const qburstEv = (k: SeriesCache, x: number) =>
  k.memo(`mc:qburst:${x}`, () => {
    const ev = burstEv(k, x);
    const wr = bbWidthRank(k);
    return events(k.b.n, (i) => (i >= 1 && ev[i] !== 0 && fin(wr[i - 1]) && wr[i - 1] < MICRO_QUIET.widthRank ? ev[i] : 0));
  });

/** RSI(p) below lo (+1) / above 100 − lo (−1) */
export const rsiEv = (k: SeriesCache, p: number, lo: number) =>
  k.memo(`mc:rsi:${p}:${lo}`, () => {
    const r = k.rsi(p);
    return events(k.b.n, (i) => (fin(r[i]) ? (r[i] < lo ? 1 : r[i] > 100 - lo ? -1 : 0) : 0));
  });

/**
 * RSI(p) turning back out of its extreme: below lo on the previous bar and at or above it now (+1), above 100 − lo
 * and back at or below it (−1) — the confirmation bar, where the level form fires on every stretched bar
 */
export const rsiTurnEv = (k: SeriesCache, p: number, lo: number) =>
  k.memo(`mc:rsit:${p}:${lo}`, () => {
    const r = k.rsi(p);
    return events(k.b.n, (i) => {
      if (i < 1 || !fin(r[i - 1], r[i])) return 0;
      if (r[i - 1] < lo && r[i] >= lo) return 1;
      if (r[i - 1] > 100 - lo && r[i] <= 100 - lo) return -1;
      return 0;
    });
  });

/**
 * The Micro RSI grid (operator, 6 Oct: "RSI completely, fine tuned for Micro"): every period × threshold, as the
 * level (RSI beyond lo / 100 − lo) and as the turn back out of it. Base tunes it — each variant is judged at Micro's
 * own cells per pair and lane, only the ones that pass build sets.
 */
export const MICRO_RSI_P = [2, 3, 4, 5, 7, 9, 14] as const;
export const MICRO_RSI_LO = [5, 10, 15, 20, 25, 30] as const;
/**
 * the most extreme threshold each period reaches: a longer RSI travels less far, so RSI(14) below 5 / 10 / 15 / 20
 * or RSI(7) below 5 / 10 practically never fires — dead variants, not tuning
 */
export const MICRO_RSI_MIN_LO: Readonly<Record<number, number>> = { 2: 5, 3: 5, 4: 5, 5: 10, 7: 15, 9: 15, 14: 25 };

/** RSI(p) divergence over `look` bars: a new closing low with the RSI above its low of the window (and the mirror) */
export const rsidivEv = (k: SeriesCache, p: number, look: number) =>
  k.memo(`mc:rsidiv:${p}:${look}`, () => {
    const r = k.rsi(p);
    const c = k.b.c;
    return events(k.b.n, (i) => {
      if (i < look || !fin(r[i])) return 0;
      let cmin = Infinity;
      let cmax = -Infinity;
      let rmin = Infinity;
      let rmax = -Infinity;
      for (let j = i - look; j < i; j++) {
        if (!fin(r[j])) return 0;
        if (c[j] < cmin) cmin = c[j];
        if (c[j] > cmax) cmax = c[j];
        if (r[j] < rmin) rmin = r[j];
        if (r[j] > rmax) rmax = r[j];
      }
      if (c[i] < cmin && r[i] > rmin + 2) return 1;
      if (c[i] > cmax && r[i] < rmax - 2) return -1;
      return 0;
    });
  });

/** RSI(p) crossing 50 with the trend */
export const rsimidEv = (k: SeriesCache, p: number) =>
  k.memo(`mc:rsimid:${p}`, () => {
    const tr = microTrend(k);
    const r = k.rsi(p);
    return events(k.b.n, (i) => {
      if (i < 1 || !fin(r[i - 1], r[i])) return 0;
      if (tr[i] > 0 && r[i - 1] <= 50 && r[i] > 50) return 1;
      if (tr[i] < 0 && r[i - 1] >= 50 && r[i] < 50) return -1;
      return 0;
    });
  });

/** MACD(12, 26, 9) histogram turning back toward zero from beyond it */
export const macdhEv = (k: SeriesCache) =>
  k.memo("mc:macdh", () => {
    const { hist } = k.macd(12, 26, 9);
    return events(k.b.n, (i) => {
      if (i < 2 || !fin(hist[i - 2], hist[i - 1], hist[i])) return 0;
      if (hist[i] < 0 && hist[i - 1] < hist[i - 2] && hist[i] > hist[i - 1]) return 1;
      if (hist[i] > 0 && hist[i - 1] > hist[i - 2] && hist[i] < hist[i - 1]) return -1;
      return 0;
    });
  });

/** lowest low / highest high of the previous p bars (bar i excluded) */
const extremeOfPrior = (k: SeriesCache, p: number) =>
  k.memo(`mc:ext:${p}`, () => k.don(p));

/** an engulfing bar at a p-bar extreme: the body covers the previous bar's body the other way */
export const engulfEv = (k: SeriesCache, p: number) =>
  k.memo(`mc:engulf:${p}`, () => {
    const { hi, lo } = extremeOfPrior(k, p);
    const { o, h, l, c } = k.b;
    return events(k.b.n, (i) => {
      if (i < 1 || !fin(hi[i], lo[i])) return 0;
      const bull = c[i - 1] < o[i - 1] && c[i] > o[i] && o[i] <= c[i - 1] && c[i] >= o[i - 1];
      const bear = c[i - 1] > o[i - 1] && c[i] < o[i] && o[i] >= c[i - 1] && c[i] <= o[i - 1];
      if (bull && Math.min(l[i - 1], l[i]) <= lo[i]) return 1;
      if (bear && Math.max(h[i - 1], h[i]) >= hi[i]) return -1;
      return 0;
    });
  });

/** a rejection wick ≥ x × the body at a 20-bar extreme, the close in the far half of the bar */
export const wickEv = (k: SeriesCache, x: number) =>
  k.memo(`mc:wick:${x}`, () => {
    const { hi, lo } = extremeOfPrior(k, 20);
    const { o, h, l, c } = k.b;
    return events(k.b.n, (i) => {
      if (!fin(hi[i], lo[i])) return 0;
      const r = h[i] - l[i];
      if (!(r > 0)) return 0;
      const body = Math.abs(c[i] - o[i]);
      const lower = Math.min(o[i], c[i]) - l[i];
      const upper = h[i] - Math.max(o[i], c[i]);
      if (l[i] <= lo[i] && lower >= x * Math.max(body, r * 0.05) && (c[i] - l[i]) / r >= 0.5) return 1;
      if (h[i] >= hi[i] && upper >= x * Math.max(body, r * 0.05) && (h[i] - c[i]) / r >= 0.5) return -1;
      return 0;
    });
  });


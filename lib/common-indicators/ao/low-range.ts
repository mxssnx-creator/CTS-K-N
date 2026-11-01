// Ported from CTS-A-O low-range-research.ts: entry rules only.
// K-N owns protection, cost and stage qualification. Batch-only cache adapter.
import type { Bars, SeriesCache } from "./series-cache";
import type { AoBoth } from "./define";

/** Candidate lookbacks from the shortest closed-bar window through medium and long intraday context. */
export const LOW_RANGE_WINDOWS = [1, 2, 3, 6, 9, 12, 18, 24, 36, 48] as const;
/** Frozen pre-expansion windows, retained only for historical vector and protocol audits. */
export const LOW_RANGE_LEGACY_WINDOWS = [12, 24, 48] as const;
export const LOW_RANGE_METHODS = ["edge-turn", "failed-break", "breakout", "mid-reclaim", "compression-break"] as const;
// The original identities and calculations remain stable. New past-move relations
// are distinct candidates: none inherits a sibling's validation or execution.
export const LOW_RANGE_RELATIONS = ["standalone", "trend", "breakout", "activity", "trend-breakout",
  "move-follow", "move-reverse", "trend-move-follow", "trend-move-reverse",
  "breakout-move-follow", "breakout-move-reverse", "trend-breakout-move-follow", "trend-breakout-move-reverse"] as const;
export type LowRangeMethod = (typeof LOW_RANGE_METHODS)[number];
export type LowRangeRelation = (typeof LOW_RANGE_RELATIONS)[number];
export type LowRangeWindow = number;
export const LOW_RANGE_IDS = LOW_RANGE_WINDOWS.flatMap((window) =>
  LOW_RANGE_METHODS.flatMap((method) => LOW_RANGE_RELATIONS.map((relation) =>
    `low-range-${window}-${method}-${relation}`,
  )),
);

type Signals = { edge: Int8Array; failed: Int8Array; breakout: Int8Array; mid: Int8Array;
  compression: Int8Array; trend: Int8Array; shortBreak: Int8Array; activity: Int8Array; move: Int8Array };
const SIGNAL_COLUMNS = ["edge", "failed", "breakout", "mid", "compression", "trend", "shortBreak", "activity", "move"] as const;

function valid(b: Bars, i: number): boolean {
  return b.tfMin > 0 && Number.isSafeInteger(b.t[i]) &&
    [b.o[i], b.h[i], b.l[i], b.c[i], b.v[i]].every(Number.isFinite) &&
    b.l[i] > 0 && b.h[i] >= Math.max(b.o[i], b.c[i]) &&
    b.l[i] <= Math.min(b.o[i], b.c[i]) && b.v[i] >= 0;
}

/** Shared prior-window geometry. Invalid bars and gaps force a complete fresh warmup. */
function features(k: SeriesCache, window: LowRangeWindow): Signals {
  return k.memo(`low-range:features:${window}`, () => {
    const b = k.b;
    const compute = (i: number, out: Signals, s: { run: number }) => {
      const contiguous = i > 0 && b.t[i] - b.t[i - 1] === b.tfMin * 60_000;
      if (!contiguous) s.run = 0;
      if (!valid(b, i)) { s.run = 0; return; }
      if (s.run >= window) {
        let high = -Infinity, low = Infinity, sum = 0, volume = 0, shortHigh = -Infinity, shortLow = Infinity;
        for (let j = i - window; j < i; j++) {
          high = Math.max(high, b.h[j]);
          low = Math.min(low, b.l[j]);
          sum += b.c[j];
          volume += b.v[j];
          if (j >= i - 6) { shortHigh = Math.max(shortHigh, b.h[j]); shortLow = Math.min(shortLow, b.l[j]); }
        }
        const width = high - low, previous = b.c[i - 1], close = b.c[i];
        // This fixed research definition is an entry filter, not a profitability claim.
        if (width > 0 && width / previous <= 0.025) {
          out.edge[i] = previous <= low + width * 0.25 && close > previous ? 1
            : previous >= high - width * 0.25 && close < previous ? -1 : 0;
          const rejectLong = b.l[i] < low && close > low;
          const rejectShort = b.h[i] > high && close < high;
          out.failed[i] = rejectLong === rejectShort ? 0 : rejectLong ? 1 : -1;
          out.breakout[i] = close > high ? 1 : close < low ? -1 : 0;
          const mid = (high + low) / 2;
          out.mid[i] = previous < mid && close >= mid ? 1 : previous > mid && close <= mid ? -1 : 0;
          if (s.run >= 2 * window) {
            let olderHigh = high, olderLow = low;
            for (let j = i - 2 * window; j < i - window; j++) {
              olderHigh = Math.max(olderHigh, b.h[j]); olderLow = Math.min(olderLow, b.l[j]);
            }
            if (olderHigh > olderLow && width / (olderHigh - olderLow) <= 0.65)
              out.compression[i] = out.breakout[i];
          }
          if (window < 12 && s.run >= window + 2) {
            // New short-window candidates use the immediately preceding context as their trend baseline;
            // comparing a one-bar close to its own one-bar average is identically neutral.
            const baseline = b.c[i - window - 2];
            out.trend[i] = previous > baseline ? 1 : previous < baseline ? -1 : 0;
          } else if (window >= 12) out.trend[i] = previous > sum / window ? 1 : previous < sum / window ? -1 : 0;
          out.shortBreak[i] = close > shortHigh ? 1 : close < shortLow ? -1 : 0;
          out.activity[i] = volume > 0 && b.v[i] >= 1.2 * volume / window ? 1 : 0;
          // Prior closed-bar log displacement, relative to the same prior
          // channel's log width. A smaller move is neutral. Log geometry makes
          // follow/reverse direction symmetric under reciprocal price mirrors;
          // log1p retains small moves. The current bar is excluded. The fixed
          // 20% threshold is exploratory, not an established trading edge.
          const anchorIndex = window === 1 ? i - 2 : i - window;
          if (anchorIndex >= 0) {
            const anchor = b.c[anchorIndex];
            const displacement = Math.log1p((previous - anchor) / anchor);
            const threshold = 0.2 * Math.log1p(width / low);
            out.move[i] = displacement >= threshold ? 1 : displacement <= -threshold ? -1 : 0;
          }
        }
      }
      s.run++;
    };
    const out: Signals = { edge: new Int8Array(b.n), failed: new Int8Array(b.n), breakout: new Int8Array(b.n),
      mid: new Int8Array(b.n), compression: new Int8Array(b.n), trend: new Int8Array(b.n),
      shortBreak: new Int8Array(b.n), activity: new Int8Array(b.n), move: new Int8Array(b.n) };
    const state = { run: 0 };
    for (let i = 0; i < b.n; i++) compute(i, out, state);
    return out;
  });
}

export function lowRangeState(k: SeriesCache, window: LowRangeWindow, method: LowRangeMethod, relation: LowRangeRelation): Int8Array {
  const f = features(k, window);
  const base = method === "edge-turn" ? f.edge : method === "failed-break" ? f.failed :
    method === "mid-reclaim" ? f.mid : method === "compression-break" ? f.compression : f.breakout;
  const passes = (i: number) => {
    const side = base[i];
    if (!side) return false;
    const trend = f.trend[i] === side, breakout = f.shortBreak[i] === side;
    const follow = f.move[i] === side, reverse = f.move[i] === -side;
    switch (relation) {
      case "standalone": return true;
      case "trend": return trend;
      case "breakout": return breakout;
      case "activity": return f.activity[i] === 1;
      case "trend-breakout": return trend && breakout;
      case "move-follow": return follow;
      case "move-reverse": return reverse;
      case "trend-move-follow": return trend && follow;
      case "trend-move-reverse": return trend && reverse;
      case "breakout-move-follow": return breakout && follow;
      case "breakout-move-reverse": return breakout && reverse;
      case "trend-breakout-move-follow": return trend && breakout && follow;
      case "trend-breakout-move-reverse": return trend && breakout && reverse;
    }
  };
  const name = `low-range:state:${window}:${method}:${relation}`;
  return k.memo(name, () => {
    const out = new Int8Array(k.b.n);
    for (let i = 0; i < out.length; i++) out[i] = passes(i) ? base[i] : 0;
    return out;
  });
}

export function registerLowRange(both: AoBoth): void {
  for (const method of LOW_RANGE_METHODS) {
    both("move", `r-low-range-${method}`, `Low-Range ${method}`,
      { window: 12, relation: 0 }, { window: 48, relation: 4 },
      (k, p) => lowRangeState(k, Math.max(1, Math.floor(p.window)), method,
        LOW_RANGE_RELATIONS[Math.max(0, Math.min(LOW_RANGE_RELATIONS.length - 1, Math.floor(p.relation)))]));
  }
}

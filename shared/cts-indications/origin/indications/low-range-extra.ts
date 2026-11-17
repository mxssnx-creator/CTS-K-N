/** Additional closed-bar research candidates. These adaptations have no implied profitability. */
import type { Bars } from "../domain/types.ts";
import type { IndicationSpec } from "./registry.ts";
import { SeriesCache } from "./cache.ts";

export const LOW_RANGE_EXTRA_WINDOWS = [6, 12, 24] as const;
export const LOW_RANGE_EXTRA_METHODS = ["band-reclaim", "squeeze-break", "rsi2-reclaim"] as const;
export const LOW_RANGE_EXTRA_FILTERS = ["standalone", "trend", "activity"] as const;
type Method = (typeof LOW_RANGE_EXTRA_METHODS)[number];
type Filter = (typeof LOW_RANGE_EXTRA_FILTERS)[number];
type Columns = {
  band: Int8Array;
  squeeze: Int8Array;
  rsi: Int8Array;
  trend: Int8Array;
  activity: Int8Array;
};
const columns = ["band", "squeeze", "rsi", "trend", "activity"] as const;
const valid = (b: Bars, i: number) =>
  Number.isSafeInteger(b.t[i]) &&
  [b.o[i], b.h[i], b.l[i], b.c[i], b.v[i]].every(Number.isFinite) &&
  b.l[i] > 0 &&
  b.v[i] >= 0 &&
  b.h[i] >= Math.max(b.o[i], b.c[i]) &&
  b.l[i] <= Math.min(b.o[i], b.c[i]);

function features(k: SeriesCache, window: number): Columns {
  return k.memo(`low-range:extra:${window}`, () => {
    const b = k.b;
    type State = { run: number; gain: number; loss: number; priorRsi: number };
    const init = (): State => ({ run: 0, gain: 0, loss: 0, priorRsi: NaN });
    const bands = (end: number) => {
      // Center values before squaring to avoid catastrophic cancellation on tiny price ranges.
      const anchor = b.c[end - 1];
      let sum = 0;
      for (let j = end - window; j < end; j++) sum += b.c[j] - anchor;
      const mean = anchor + sum / window;
      let variance = 0;
      for (let j = end - window; j < end; j++) variance += (b.c[j] - mean) ** 2;
      const sd = Math.sqrt(variance / window);
      return { mean, lower: mean - 2 * sd, upper: mean + 2 * sd, width: (4 * sd) / mean };
    };
    const compute = (i: number, out: Columns, s: State) => {
      if (i === 0 || b.t[i] - b.t[i - 1] !== b.tfMin * 60_000 || !valid(b, i))
        Object.assign(s, init());
      if (!valid(b, i)) return;
      let rsi = NaN;
      if (s.run > 0) {
        const change = b.c[i] - b.c[i - 1],
          gain = Math.max(0, change),
          loss = Math.max(0, -change);
        if (s.run <= 2) {
          s.gain += gain / 2;
          s.loss += loss / 2;
        } else {
          s.gain = (s.gain + gain) / 2;
          s.loss = (s.loss + loss) / 2;
        }
        if (s.run >= 2) rsi = s.gain + s.loss > 0 ? (100 * s.gain) / (s.gain + s.loss) : 50;
      }
      if (s.run >= window + 1) {
        const prior = bands(i),
          previous = bands(i - 1),
          close = b.c[i],
          prevClose = b.c[i - 1];
        if (prior.width > 0 && prior.width <= 0.025) {
          let volume = 0;
          for (let j = i - window; j < i; j++) volume += b.v[j];
          out.activity[i] = volume > 0 && b.v[i] >= (1.2 * volume) / window ? 1 : 0;
          // Keep the trend horizon separate from the reclaim trigger. Comparing an oversold
          // previous close to its own band mean made the trend/reclaim conjunction unreachable.
          const trendClose = s.run >= 2 * window ? b.c[i - 2 * window] : NaN;
          out.trend[i] = prevClose > trendClose ? 1 : prevClose < trendClose ? -1 : 0;
          // A band touch alone is not a reversal: require a completed return inside the band.
          out.band[i] =
            prevClose <= previous.lower && close > prior.lower && close > prevClose
              ? 1
              : prevClose >= previous.upper && close < prior.upper && close < prevClose
                ? -1
                : 0;
          if (s.run >= 2 * window) {
            const older = bands(i - window);
            if (older.width > 0 && prior.width <= 0.65 * older.width && out.activity[i])
              out.squeeze[i] = close > prior.upper ? 1 : close < prior.lower ? -1 : 0;
          }
          out.rsi[i] =
            s.priorRsi <= 20 && rsi > 20 && close > prevClose
              ? 1
              : s.priorRsi >= 80 && rsi < 80 && close < prevClose
                ? -1
                : 0;
        }
      }
      s.priorRsi = rsi;
      s.run++;
    };
    if (k.streamMath)
      return k.streamMath.run<Columns, State>(
        `low-range:extra:${window}`,
        b.n,
        [...columns],
        init,
        compute,
        [...columns],
      );
    const out: Columns = {
      band: new Int8Array(b.n),
      squeeze: new Int8Array(b.n),
      rsi: new Int8Array(b.n),
      trend: new Int8Array(b.n),
      activity: new Int8Array(b.n),
    };
    const state = init();
    for (let i = 0; i < b.n; i++) compute(i, out, state);
    return out;
  });
}

export function lowRangeExtraState(
  k: SeriesCache,
  window: number,
  method: Method,
  filter: Filter,
  inverse = false,
): Int8Array {
  const f = features(k, window),
    base = method === "band-reclaim" ? f.band : method === "squeeze-break" ? f.squeeze : f.rsi;
  const name = `low-range:extra-state:${window}:${method}:${filter}:${inverse}`;
  const put = (i: number, out: { value: Int8Array }) => {
    const side = base[i];
    out.value[i] =
      side &&
      (filter === "standalone" ||
        (filter === "trend" && f.trend[i] === side) ||
        (filter === "activity" && f.activity[i]))
        ? side * (inverse ? -1 : 1)
        : 0;
  };
  return k.memo(name, () => {
    if (k.streamMath)
      return k.streamMath.run<{ value: Int8Array }, null>(name, k.b.n, ["value"], () => null, put, [
        "value",
      ]).value;
    const out = { value: new Int8Array(k.b.n) };
    for (let i = 0; i < k.b.n; i++) put(i, out);
    return out.value;
  });
}

export function lowRangeExtraSpecs(): IndicationSpec[] {
  return LOW_RANGE_EXTRA_WINDOWS.flatMap((window) =>
    LOW_RANGE_EXTRA_METHODS.flatMap((method) =>
      LOW_RANGE_EXTRA_FILTERS.flatMap((filter) =>
        [false, true].map((inverse) => ({
          id: `low-range-research-${window}-${method}-${filter}${inverse ? "-inverse" : ""}`,
          kind: "low-range" as const,
          label: `Low-Range · ${method} · ${window} bars · ${filter}${inverse ? " · Inverse" : ""}`,
          params: { window },
          fn: (k: SeriesCache) => lowRangeExtraState(k, window, method, filter, inverse),
        })),
      ),
    ),
  );
}

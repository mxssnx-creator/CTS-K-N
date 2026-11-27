/** Settings use percentage points of entry price. Both categories own the inclusive TP overlap. */
export const STOP_BANDS = {
  short: { minTpPct: 0.1, maxTpPct: 1.6, stops: Array.from({ length: 15 }, (_, i) => (i + 2) / 10) },
  long: { minTpPct: 1.2, maxTpPct: 5, stops: Array.from({ length: 12 }, (_, i) => (i + 2) / 5) },
} as const;
export type StopBand = keyof typeof STOP_BANDS;
export type FixedStopSelections = Partial<Record<StopBand, readonly number[]>>;
export type FixedStopChoice = { band: StopBand; stopPct: number };

export function stopSelections(raw: FixedStopSelections = {}): Record<StopBand, number[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(k => !(k === "short" || k === "long")))
    throw new RangeError("Fixed SL settings must contain Short and Long selections.");
  const read = (band: StopBand) => {
    const allowed = STOP_BANDS[band].stops;
    const values = raw[band] === undefined ? allowed : raw[band];
    if (!Array.isArray(values) || values.some(v => typeof v !== "number" || !allowed.includes(v)))
      throw new RangeError(`Invalid ${band} fixed SL percentage.`);
    return allowed.filter(v => values.includes(v));
  };
  return { short: read("short"), long: read("long") };
}

export function matchesStopBand(band: StopBand, tpPct: number): boolean {
  const b = STOP_BANDS[band];
  return Number.isFinite(tpPct) && tpPct >= b.minTpPct - 1e-10 && tpPct <= b.maxTpPct + 1e-10;
}

export const DEFAULT_MAX_STOP_RATIO = 2.5;
export function maxStopRatio(value?: unknown): number {
  if (value === undefined || value === null || value === 0) return DEFAULT_MAX_STOP_RATIO;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 5)
    throw new RangeError("Maximum SL / TP ratio must be positive and at most 5.");
  return value;
}

export function stopFitsTarget(stopPct: number, targetPct: number, ceiling: number): boolean {
  return Number.isFinite(stopPct) && stopPct > 0 && Number.isFinite(targetPct) && targetPct > 0 &&
    stopPct <= targetPct * ceiling + 1e-10;
}

export function fixedStopsAt(tpPct: number, stops: ReturnType<typeof stopSelections>, ceiling = DEFAULT_MAX_STOP_RATIO): FixedStopChoice[] {
  const rows: FixedStopChoice[] = [];
  for (const band of ["short", "long"] as const) {
    if (!matchesStopBand(band, tpPct)) continue;
    for (const stopPct of stops[band]) if (stopFitsTarget(stopPct, tpPct, ceiling)) rows.push({ band, stopPct });
  }
  return rows;
}

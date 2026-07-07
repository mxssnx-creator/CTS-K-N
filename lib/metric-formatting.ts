export function formatSampledMetric(value: number | null | undefined, sampleSize: number | null | undefined, digits = 2) {
  if (!sampleSize || sampleSize <= 0 || value === null || value === undefined || Number.isNaN(value)) return "—"
  if (!Number.isFinite(value) || value >= 999) return "∞"
  return value.toFixed(digits)
}

export function grossProfitFactorTitle(value: number | null | undefined, sampleSize: number | null | undefined) {
  if (!sampleSize || sampleSize <= 0) return "No samples available"
  if (value !== null && value !== undefined && (!Number.isFinite(value) || value >= 999)) {
    return "Gross losses are zero while gross wins are positive, so profit factor is infinite."
  }
  return undefined
}

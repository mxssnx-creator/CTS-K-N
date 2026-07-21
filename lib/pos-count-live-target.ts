export type CombinedPosCountDelta =
  | { action: "increase"; quantity: number }
  | { action: "reduce"; quantity: number }
  | { action: "none"; quantity: 0 }

export function resolveCombinedPosCountDelta(currentQuantity: number, targetQuantity: number): CombinedPosCountDelta {
  const current = Math.max(0, Number.isFinite(currentQuantity) ? currentQuantity : 0)
  const target = Math.max(0, Number.isFinite(targetQuantity) ? targetQuantity : 0)
  const tolerance = Math.max(1e-12, Math.max(current, target) * 1e-8)
  const delta = target - current
  if (Math.abs(delta) <= tolerance) return { action: "none", quantity: 0 }
  const quantity = Number(Math.abs(delta).toFixed(12))
  return delta > 0
    ? { action: "increase", quantity }
    : { action: "reduce", quantity }
}

/** Resolve a combined pos-count target without inflating a sub-minimum ratio.
 * Ordinary live signals use the venue clamp. Pos-count Sets first hedge and
 * combine their raw 0.05 ratios and create one physical order only after the
 * combined target reaches the venue minimum. */
export function resolveCombinedPosCountTargetQuantity(volumeResult: {
  calculatedVolume?: number
  finalVolume?: number
  volume?: number
  exchangeMinVolume?: number
} | null | undefined): number {
  const raw = Number(volumeResult?.calculatedVolume || 0)
  const minimum = Number(volumeResult?.exchangeMinVolume || 0)
  if (!(raw > 0)) return 0
  const tolerance = Math.max(1e-12, minimum * 1e-8)
  if (minimum > 0 && raw + tolerance < minimum) return 0
  const clamped = Number(volumeResult?.finalVolume || volumeResult?.volume || raw)
  return Number.isFinite(clamped) && clamped > 0 ? clamped : raw
}

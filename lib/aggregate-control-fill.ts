export interface AggregateFillAllocation {
  id: string
  originalQuantity: number
  cumulativeQuantity: number
  fraction: number
}

/**
 * Attribute a confirmed cumulative venue fill using the immutable membership
 * captured before applying any row reduction. Repeated/late snapshots produce
 * the same row totals. A partial fill never implies the unfilled remainder.
 */
export function allocateAggregateControlFill(
  members: Readonly<Record<string, number>>,
  cumulativeFill: number,
): AggregateFillAllocation[] {
  const entries = Object.entries(members).filter(([, quantity]) => Number.isFinite(quantity) && quantity > 0)
    .sort(([a], [b]) => a.localeCompare(b))
  const total = entries.reduce((sum, [, quantity]) => sum + quantity, 0)
  if (!(total > 0) || !Number.isFinite(cumulativeFill) || cumulativeFill <= 0) return []
  const filled = Math.min(total, cumulativeFill)
  let allocated = 0
  return entries.map(([id, originalQuantity], index) => {
    const fraction = originalQuantity / total
    const cumulativeQuantity = Math.min(originalQuantity, Math.max(0, index === entries.length - 1
      ? filled - allocated
      : Number((filled * fraction).toPrecision(15))))
    allocated += cumulativeQuantity
    return { id, originalQuantity, cumulativeQuantity, fraction }
  })
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {}

const measured = (value: unknown): number => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

/** Current counts and exchange results must never fall through to lifetime or evaluation rows. */
export function projectOverviewCurrentCounts(payload: unknown) {
  const response = record(payload)
  const active = record(response.activeCounts)
  const indications = record(active.indications)
  const strategies = record(active.strategies)
  const live = record(response.liveExecution)
  return {
    stratLive: measured(live.positionsCreated),
    activeIndDirection: measured(indications.direction),
    activeIndMove: measured(indications.move),
    activeIndActive: measured(indications.active),
    activeIndOptimal: measured(indications.optimal),
    activeIndTotal: measured(indications.total),
    activeStratBase: measured(strategies.base),
    activeStratMain: measured(strategies.main),
    activeStratReal: measured(strategies.real),
    // Real is the final filtered pipeline output. Parent stages overlap it,
    // and older APIs may retain a historical total when this sample is zero.
    activeStratTotal: measured(strategies.real),
    liveWinRate: Math.min(100, measured(live.winRate)),
    liveFillRate: Math.min(100, measured(live.fillRate)),
  }
}

export const LIVE_OPEN_STATUSES = [
  "open",
  "filled",
  "partially_filled",
  "placed",
  "pending",
  "pending_fill",
  "placed_unconfirmed",
] as const

export type LiveOpenStatus = (typeof LIVE_OPEN_STATUSES)[number]

const LIVE_OPEN_STATUS_SET = new Set<string>(LIVE_OPEN_STATUSES)

export function isLiveOpenStatus(status: unknown): status is LiveOpenStatus {
  return LIVE_OPEN_STATUS_SET.has(String(status || ""))
}

export function countLiveOpenPositions<T extends { status?: unknown }>(positions: T[]): number {
  return positions.filter((position) => isLiveOpenStatus(position.status)).length
}

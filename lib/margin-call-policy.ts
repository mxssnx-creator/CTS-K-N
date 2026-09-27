export const DEFAULT_MARGIN_CALL_EQUITY_PERCENT = 30
export const MARGIN_CALL_OBSERVATION_MS = 15_000

export type MarginCallSession = {
  version: 1
  sessionId: string
  startedAt: number
  startEquity: number
  currentEquity: number
  lastObservedAt: number
  status: "active" | "closing" | "closed"
  triggeredAt?: number
  closedAt?: number
  remainingPositions?: number
  remainingOrders?: number
  lastError?: string
}

export function marginCallEnabled(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true
  if (value === false || value === 0) return false
  const normalized = String(value).trim().toLowerCase()
  if (["0", "false", "off", "no", "disabled"].includes(normalized)) return false
  if (["1", "true", "on", "yes", "enabled"].includes(normalized)) return true
  return true
}

export function marginCallPercent(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_MARGIN_CALL_EQUITY_PERCENT
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0 || number > 100) {
    throw new Error("Margin-call equity threshold must be greater than 0 and at most 100 percent")
  }
  return number
}

export function finiteAccountNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined
  if (typeof value === "string" && value.trim() === "") return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

export function marginCallIsBreached(startEquity: number, currentEquity: number, percent: number): boolean {
  if (!(startEquity > 0) || !Number.isFinite(startEquity) || !Number.isFinite(currentEquity)) {
    throw new Error("A valid session baseline and current equity are required")
  }
  return currentEquity < startEquity * marginCallPercent(percent) / 100
}

/**
 * System-wide master switch (system settings `margin_call_enabled`).
 * Unlike the per-connection flag it defaults to OFF: margin control only runs
 * when an operator explicitly enables it in Settings.
 */
export function marginCallGloballyEnabled(value: unknown): boolean {
  if (value === true || value === 1) return true
  // Default-off master: only an explicit "on" token enables it. Unknown or
  // malformed values keep it off (the per-connection flag defaults to on).
  return ["1", "true", "on", "yes", "enabled"].includes(String(value ?? "").trim().toLowerCase())
}

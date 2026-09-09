/** Shared operator contract; safe to import from browser code. */
export const LIVE_CONFIG_LOSS_WINDOW_DEFAULT = 12
export const LIVE_CONFIG_LOSS_WINDOW_MIN = 5
export const LIVE_CONFIG_LOSS_WINDOW_MAX = 25

export function normalizeLiveConfigLossWindow(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return LIVE_CONFIG_LOSS_WINDOW_DEFAULT
  const value = Number(raw)
  return Number.isFinite(value)
    ? Math.max(LIVE_CONFIG_LOSS_WINDOW_MIN, Math.min(LIVE_CONFIG_LOSS_WINDOW_MAX, Math.round(value)))
    : LIVE_CONFIG_LOSS_WINDOW_DEFAULT
}

export function liveConfigLossPolicy(settings: Record<string, unknown> = {}) {
  const flag = settings.liveConfigAutoDeactivateEnabled
  return {
    enabled: flag === undefined || flag === null || flag === ""
      ? true
      : flag === true || flag === 1 || flag === "1" || flag === "true",
    window: normalizeLiveConfigLossWindow(settings.liveConfigLossWindow),
  }
}

export interface DeactivatedLiveConfig {
  id: string
  setKey: string
  symbol: string
  direction: string
  executionIntent: string
  disabledAt: number
  window: number
  sampleCount: number
  netPnl: number
  reason: "negative_live_window"
}

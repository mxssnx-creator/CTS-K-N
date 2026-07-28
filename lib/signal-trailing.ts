/**
 * Canonical Signal trailing contract.
 *
 * Ratios use 1 = 100 %. Percent settings are converted exactly once when the
 * strategy Base Set is built.
 */
export const SIGNAL_TRAILING_MIN_STOP_PCT_FLOOR = 0.8
export const SIGNAL_TRAILING_DEFAULT_START_PCT = 0
export const SIGNAL_TRAILING_DEFAULT_MIN_STOP_PCT = 0.8
export const SIGNAL_TRAILING_DEFAULT_POSITIVE_MOVE_RATIO = 0.4
export const SIGNAL_TRAILING_DEFAULT_UPDATE_STOP_RANGE_RATIO = 0.5

export type TrailingProfile = {
  startRatio: number
  stopRatio: number
  stepRatio: number
  mode?: "fixed" | "signal_dynamic"
  minStopRatio?: number
  positiveMoveRatio?: number
  updateStopRangeRatio?: number
}

export type SignalTrailingSettings = {
  trailingStartPct: number
  trailingMinStopPct: number
  trailingPositiveMoveRatio: number
  trailingUpdateStopRangeRatio: number
}

export type SignalExecutionLane = "default" | "signal_trailing"

export type SignalExecutionSlotInput = {
  executionLane?: unknown
  indicationType?: unknown
  trailingProfile?: TrailingProfile | null
  setKey?: unknown
  parentSetKey?: unknown
  signalRisk?: {
    sourceId?: unknown
    sourceIds?: unknown
    configId?: unknown
    configIds?: unknown
    signalLanes?: unknown
  } | null
}

export function buildSignalTrailingProfile(
  settings: SignalTrailingSettings,
): TrailingProfile {
  const startRatio = Math.max(0, Number(settings.trailingStartPct) || 0) / 100
  const minStopRatio = Math.max(
    SIGNAL_TRAILING_MIN_STOP_PCT_FLOOR,
    Number(settings.trailingMinStopPct) || SIGNAL_TRAILING_DEFAULT_MIN_STOP_PCT,
  ) / 100
  const positiveMoveRatio = Math.max(
    0.05,
    Math.min(1, Number(settings.trailingPositiveMoveRatio) || SIGNAL_TRAILING_DEFAULT_POSITIVE_MOVE_RATIO),
  )
  const updateStopRangeRatio = Math.max(
    0.1,
    Math.min(1, Number(settings.trailingUpdateStopRangeRatio) || SIGNAL_TRAILING_DEFAULT_UPDATE_STOP_RANGE_RATIO),
  )

  return {
    mode: "signal_dynamic",
    startRatio,
    // Compatibility anchors for existing Live/Pseudo consumers. Dynamic
    // trailing uses the explicit fields below for every ratchet.
    stopRatio: minStopRatio,
    stepRatio: minStopRatio * updateStopRangeRatio,
    minStopRatio,
    positiveMoveRatio,
    updateStopRangeRatio,
  }
}

export function isSignalDynamicTrailingProfile(
  profile: TrailingProfile | null | undefined,
): profile is TrailingProfile & { mode: "signal_dynamic" } {
  return profile?.mode === "signal_dynamic"
}

export function resolveSignalExecutionLane(position: {
  executionLane?: unknown
  indicationType?: unknown
  trailingProfile?: TrailingProfile | null
}): SignalExecutionLane {
  if (position.executionLane === "signal_trailing") return "signal_trailing"
  return String(position.indicationType || "").toLowerCase() === "signal" &&
    isSignalDynamicTrailingProfile(position.trailingProfile)
    ? "signal_trailing"
    : "default"
}

function stableSlotHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).padStart(7, "0")
}

function executionSlotPart(value: unknown, fallback: string): string {
  const raw = String(value ?? "").trim().toLowerCase()
  if (!raw) return fallback
  const readable = raw.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48)
  return `${readable || fallback}-${stableSlotHash(raw)}`
}

/**
 * Return the exact physical/logical execution identity.
 *
 * Main/Default positions retain the historical two-lane contract. Signal
 * positions additionally include source and TP/SL/trailing configuration so
 * one open Binance/BTC/Long config cannot collapse an independent OKX config
 * or another protection range into the same dedup slot. The compact stable
 * hash prevents punctuation-normalisation collisions while keeping Redis lock
 * keys readable.
 */
export function resolveSignalExecutionSlot(
  position: SignalExecutionSlotInput,
): string {
  const lane = resolveSignalExecutionLane(position)
  const risk = position.signalRisk && typeof position.signalRisk === "object"
    ? position.signalRisk
    : undefined
  const indicationType = String(position.indicationType || "").trim().toLowerCase()
  const isSignal =
    indicationType === "signal" ||
    // Compatibility for pre-type Signal rows. Once another indication type
    // owns the physical position, merged Signal risk is attribution metadata
    // only and must not rename its Redis lock/reconciliation slot.
    (!indicationType && Boolean(risk))
  if (!isSignal) return lane

  const signalLanes = Array.isArray(risk?.signalLanes)
    ? risk.signalLanes.filter((entry): entry is Record<string, unknown> =>
        Boolean(entry && typeof entry === "object"))
    : []
  const sourceIds = Array.isArray(risk?.sourceIds)
    ? risk.sourceIds.map(String).map((value) => value.trim()).filter(Boolean).sort()
    : []
  const configIds = Array.isArray(risk?.configIds)
    ? risk.configIds.map(String).map((value) => value.trim()).filter(Boolean).sort()
    : []
  const sourceId =
    risk?.sourceId ??
    signalLanes[0]?.sourceId ??
    (sourceIds.length > 0 ? sourceIds.join("+") : "source")
  const configId =
    risk?.configId ??
    signalLanes[0]?.configId ??
    (configIds.length > 0
      ? configIds.join("+")
      : position.parentSetKey || position.setKey || "dynamic")

  return [
    "signal",
    lane,
    executionSlotPart(sourceId, "source"),
    executionSlotPart(configId, "dynamic"),
  ].join(":")
}

export type SignalTrailingTickInput = {
  entryPrice: number
  currentPrice: number
  side: "long" | "short"
  profile: TrailingProfile
  active: boolean
  anchor: number
  stopPrice: number
  stopRangeRatio?: number
}

export type SignalTrailingTickResult = {
  changed: boolean
  active: boolean
  anchor: number
  stopPrice: number
  stopRangeRatio: number
  favorableMoveRatio: number
}

/**
 * Calculate one Signal trailing tick without side effects.
 *
 * Stop range:
 *   max(configured minimum (never below 0.8 %), favorable move × ratio)
 *
 * Ratchet threshold:
 *   previous stop range × update ratio
 *
 * The returned stop never loosens, even if price gaps back before the next
 * processing tick.
 */
export function calculateSignalTrailingTick(
  input: SignalTrailingTickInput,
): SignalTrailingTickResult {
  const { entryPrice, currentPrice, side, profile } = input
  const minStopRatio = Math.max(
    SIGNAL_TRAILING_MIN_STOP_PCT_FLOOR / 100,
    Number(profile.minStopRatio ?? profile.stopRatio) || 0,
  )
  const positiveMoveRatio = Math.max(0.05, Math.min(1, Number(profile.positiveMoveRatio) || 0.4))
  const updateRatio = Math.max(0.1, Math.min(1, Number(profile.updateStopRangeRatio) || 0.5))
  const startRatio = Math.max(0, Number(profile.startRatio) || 0)
  const favorableMoveRatio = entryPrice > 0 && currentPrice > 0
    ? Math.max(
        0,
        side === "long"
          ? (currentPrice - entryPrice) / entryPrice
          : (entryPrice - currentPrice) / entryPrice,
      )
    : 0
  const currentRange = Math.max(
    minStopRatio,
    Number(input.stopRangeRatio) || minStopRatio,
  )
  const unchanged: SignalTrailingTickResult = {
    changed: false,
    active: input.active,
    anchor: input.anchor,
    stopPrice: input.stopPrice,
    stopRangeRatio: currentRange,
    favorableMoveRatio,
  }

  if (!(entryPrice > 0) || !(currentPrice > 0)) return unchanged
  if (!input.active && favorableMoveRatio < startRatio) return unchanged

  if (input.active && input.anchor > 0) {
    const threshold = input.anchor * currentRange * updateRatio
    const advanced = side === "long"
      ? currentPrice >= input.anchor + threshold
      : currentPrice <= input.anchor - threshold
    if (!advanced) return unchanged
  }

  const nextRange = Math.max(minStopRatio, favorableMoveRatio * positiveMoveRatio)
  const candidateStop = side === "long"
    ? currentPrice * (1 - nextRange)
    : currentPrice * (1 + nextRange)
  const monotonicStop = input.stopPrice > 0
    ? side === "long"
      ? Math.max(input.stopPrice, candidateStop)
      : Math.min(input.stopPrice, candidateStop)
    : candidateStop

  return {
    changed:
      !input.active ||
      input.anchor !== currentPrice ||
      input.stopPrice !== monotonicStop ||
      currentRange !== nextRange,
    active: true,
    anchor: currentPrice,
    stopPrice: monotonicStop,
    stopRangeRatio: nextRange,
    favorableMoveRatio,
  }
}

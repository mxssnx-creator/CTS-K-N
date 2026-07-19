export type DcaTakeProfitMode = "average" | "first_entry" | "breakeven_plus"

export interface DcaProfile {
  maxSteps: number
  /** Quantity multipliers relative to the confirmed initial position size. */
  stepVolumeMultipliers: number[]
  /** Adverse move from the original entry, expressed in percentage points. */
  stepDistancesPct: number[]
  takeProfitMode: DcaTakeProfitMode
  breakevenProfitPct: number
  cooldownSeconds: number
}

export const DEFAULT_DCA_PROFILE: DcaProfile = {
  maxSteps: 4,
  stepVolumeMultipliers: [1.5, 2.0, 2.3, 2.5],
  stepDistancesPct: [0.5, 1.0, 1.5, 2.0],
  takeProfitMode: "average",
  breakevenProfitPct: 0.2,
  cooldownSeconds: 30,
}

export interface DcaLegState {
  setKey: string
  step: number
  baseQuantity: number
  volumeMultiplier: number
  triggerDistancePct: number
  requestedQuantity: number
  quantity: number
  referencePrice: number
  positionQuantityAfter?: number
  clientOrderId?: string
  orderId?: string
  filledPrice?: number
  filledAt?: number
}

/**
 * Stable exact-Set identity for one confirmed DCA leg.
 *
 * The Real-stage DCA candidate itself is stable across cycles (for example
 * `base#dca`). Reusing that key as the accumulation dedupe identity made the
 * first fill suppress steps 2..4 forever. Each configured step is a distinct
 * confirmed Set entry, while retries of the same step remain idempotent.
 */
export function buildDcaStepSetKey(setKey: string, step: number): string {
  const base = String(setKey || "").trim().replace(/#step:\d+$/i, "")
  const normalizedStep = Math.max(1, Math.min(4, Math.floor(Number(step) || 1)))
  return base ? `${base}#step:${normalizedStep}` : `dca#step:${normalizedStep}`
}

function parseArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== "string" || !raw.trim()) return []
  const trimmed = raw.trim()
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed)
      return Array.isArray(parsed) ? parsed : []
    } catch { return [] }
  }
  return trimmed.split(/[\s,|]+/).filter(Boolean)
}

function finiteInRange(raw: unknown, fallback: number, min: number, max: number): number {
  const value = Number(raw)
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}

function resolveStepArray(
  rawArray: unknown,
  source: Record<string, unknown>,
  legacyPrefix: string,
  defaults: number[],
  min: number,
  max: number,
): number[] {
  const parsed = parseArray(rawArray)
  const values: number[] = []
  for (let index = 0; index < 4; index++) {
    const legacy = source[`${legacyPrefix}${index + 1}`]
    values.push(finiteInRange(parsed[index] ?? legacy, defaults[index], min, max))
  }
  return values
}

/** Normalize nested, flat, JSON-string, and legacy per-step settings. */
export function normalizeDcaProfile(raw: unknown): DcaProfile {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const maxSteps = Math.floor(finiteInRange(
    source.maxSteps ?? source.dcaMaxSteps,
    DEFAULT_DCA_PROFILE.maxSteps,
    1,
    4,
  ))
  const stepVolumeMultipliers = resolveStepArray(
    source.stepVolumeMultipliers ?? source.dcaStepVolumeMultipliers,
    source,
    "dcaStepVolume",
    DEFAULT_DCA_PROFILE.stepVolumeMultipliers,
    0.1,
    2.5,
  )
  const rawDistances = resolveStepArray(
    source.stepDistancesPct ?? source.dcaStepDistancesPct,
    source,
    "dcaStepDistance",
    DEFAULT_DCA_PROFILE.stepDistancesPct,
    0.1,
    20,
  )
  const stepDistancesPct: number[] = []
  for (const value of rawDistances) {
    const previous = stepDistancesPct[stepDistancesPct.length - 1]
    stepDistancesPct.push(previous === undefined ? value : Math.max(value, previous))
  }
  const takeProfitModeRaw = String(
    source.takeProfitMode ?? source.dcaTakeProfitMode ?? source.dcaTakeProfitAdjustment ?? "average",
  )
  const takeProfitMode: DcaTakeProfitMode =
    takeProfitModeRaw === "first_entry" || takeProfitModeRaw === "breakeven_plus"
      ? takeProfitModeRaw
      : "average"

  return {
    maxSteps,
    stepVolumeMultipliers,
    stepDistancesPct,
    takeProfitMode,
    breakevenProfitPct: finiteInRange(
      source.breakevenProfitPct ?? source.dcaBreakevenProfitPct,
      DEFAULT_DCA_PROFILE.breakevenProfitPct,
      0.05,
      5,
    ),
    cooldownSeconds: Math.round(finiteInRange(
      source.cooldownSeconds ?? source.dcaCooldownSeconds,
      DEFAULT_DCA_PROFILE.cooldownSeconds,
      0,
      3600,
    )),
  }
}

function hasOwn(source: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key)
}

/**
 * Merge partial DCA setting layers in ascending priority.
 *
 * Persisted hashes use flat `dca*` field names while a position snapshot uses
 * normalized names. A plain object spread leaves both aliases present, after
 * which `normalizeDcaProfile` would prefer the older normalized value. This
 * helper canonicalizes every supplied layer as it is applied so the newest
 * operator save always wins, including legacy per-step fields.
 */
export function mergeDcaProfileSources(...sources: unknown[]): DcaProfile {
  const merged: Record<string, unknown> = {}
  for (const raw of sources) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const source = raw as Record<string, unknown>
    const current = normalizeDcaProfile(merged)
    Object.assign(merged, source)

    if (hasOwn(source, "maxSteps") || hasOwn(source, "dcaMaxSteps")) {
      merged.maxSteps = source.maxSteps ?? source.dcaMaxSteps
    }

    if (hasOwn(source, "stepVolumeMultipliers") || hasOwn(source, "dcaStepVolumeMultipliers")) {
      merged.stepVolumeMultipliers = source.stepVolumeMultipliers ?? source.dcaStepVolumeMultipliers
    } else if ([1, 2, 3, 4].some((step) => hasOwn(source, `dcaStepVolume${step}`))) {
      const values: unknown[] = [...current.stepVolumeMultipliers]
      for (let index = 0; index < 4; index++) {
        const key = `dcaStepVolume${index + 1}`
        if (hasOwn(source, key)) values[index] = source[key]
      }
      merged.stepVolumeMultipliers = values
    }

    if (hasOwn(source, "stepDistancesPct") || hasOwn(source, "dcaStepDistancesPct")) {
      merged.stepDistancesPct = source.stepDistancesPct ?? source.dcaStepDistancesPct
    } else if ([1, 2, 3, 4].some((step) => hasOwn(source, `dcaStepDistance${step}`))) {
      const values: unknown[] = [...current.stepDistancesPct]
      for (let index = 0; index < 4; index++) {
        const key = `dcaStepDistance${index + 1}`
        if (hasOwn(source, key)) values[index] = source[key]
      }
      merged.stepDistancesPct = values
    }

    if (
      hasOwn(source, "takeProfitMode") ||
      hasOwn(source, "dcaTakeProfitMode") ||
      hasOwn(source, "dcaTakeProfitAdjustment")
    ) {
      merged.takeProfitMode = source.takeProfitMode ?? source.dcaTakeProfitMode ?? source.dcaTakeProfitAdjustment
    }
    if (hasOwn(source, "breakevenProfitPct") || hasOwn(source, "dcaBreakevenProfitPct")) {
      merged.breakevenProfitPct = source.breakevenProfitPct ?? source.dcaBreakevenProfitPct
    }
    if (hasOwn(source, "cooldownSeconds") || hasOwn(source, "dcaCooldownSeconds")) {
      merged.cooldownSeconds = source.cooldownSeconds ?? source.dcaCooldownSeconds
    }
  }
  return normalizeDcaProfile(merged)
}

export function adverseMovePct(direction: "long" | "short", referencePrice: number, currentPrice: number): number {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) return 0
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return 0
  const move = direction === "short"
    ? (currentPrice - referencePrice) / referencePrice
    : (referencePrice - currentPrice) / referencePrice
  return Math.max(0, move * 100)
}

export function resolveNextDcaStep(args: {
  direction: "long" | "short"
  referencePrice: number
  currentPrice: number
  profile: DcaProfile
  legs?: DcaLegState[]
  pendingStep?: number
  now?: number
}): { step: number; volumeMultiplier: number; triggerDistancePct: number; adverseMovePct: number } | null {
  const now = args.now ?? Date.now()
  if (args.pendingStep && args.pendingStep > 0) return null
  const legs = Array.isArray(args.legs) ? args.legs : []
  const completed = new Set(legs.filter((leg) => Number(leg.quantity) > 0).map((leg) => Math.floor(Number(leg.step))))
  const lastFilledAt = legs.reduce((latest, leg) => Math.max(latest, Number(leg.filledAt || 0)), 0)
  if (lastFilledAt > 0 && now - lastFilledAt < args.profile.cooldownSeconds * 1000) return null

  const adverse = adverseMovePct(args.direction, args.referencePrice, args.currentPrice)
  for (let step = 1; step <= args.profile.maxSteps; step++) {
    if (completed.has(step)) continue
    const triggerDistancePct = args.profile.stepDistancesPct[step - 1]
    if (adverse + 1e-12 < triggerDistancePct) return null
    return { step, volumeMultiplier: args.profile.stepVolumeMultipliers[step - 1], triggerDistancePct, adverseMovePct: adverse }
  }
  return null
}

/**
 * Calculate DCA add quantity using ratio-based volume system.
 * 
 * System uses ratio multipliers where ratio 1.0 = base/internal system default
 * Higher ratios (>1.0) = larger volumes for aggregation
 * Lower ratios (<1.0) = smaller volumes for conservative testing
 * 
 * Live exchange volumes = baseQuantity * ratio
 * Strategy internal calculations can use higher ratios for optimization
 * 
 * @param baseQuantity - Base quantity at ratio 1.0 (system default)
 * @param volumeMultiplier - Ratio multiplier (default 1.0 for system baseline)
 * @returns quantity = baseQuantity * volumeMultiplier
 */
export function calculateDcaAddQuantity(baseQuantity: number, volumeMultiplier: number): number {
  if (!Number.isFinite(baseQuantity) || baseQuantity <= 0) return 0
  // Default ratio 1.0 means no multiplier applied (identity)
  const ratio = Number.isFinite(volumeMultiplier) && volumeMultiplier > 0 ? volumeMultiplier : 1.0
  return baseQuantity * ratio
}

export function upsertDcaLeg(legs: DcaLegState[] | undefined, next: DcaLegState): DcaLegState[] {
  const out = Array.isArray(legs) ? [...legs] : []
  const index = out.findIndex((leg) => leg.step === next.step && leg.setKey === next.setKey)
  if (index >= 0) out[index] = { ...out[index], ...next }
  else out.push(next)
  return out.sort((a, b) => a.step - b.step).slice(-4)
}

export function calculateDcaTakeProfitPrice(args: {
  direction: "long" | "short"
  profile: DcaProfile
  initialEntryPrice: number
  averageEntryPrice: number
  takeProfitPct: number
}): number {
  const average = Number(args.averageEntryPrice)
  const initial = Number(args.initialEntryPrice)
  if (!Number.isFinite(average) || average <= 0) return 0
  const reference = args.profile.takeProfitMode === "first_entry" && initial > 0 ? initial : average
  const targetPct = args.profile.takeProfitMode === "breakeven_plus"
    ? args.profile.breakevenProfitPct
    : Math.max(0, Number(args.takeProfitPct) || 0)
  if (targetPct <= 0) return 0
  return args.direction === "short"
    ? reference * (1 - targetPct / 100)
    : reference * (1 + targetPct / 100)
}

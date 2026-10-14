/**
 * The Common rule registry: one causal rule per Common type, shared by the
 * live engine (last bar), the Preset optimizer (every bar) and the preset
 * runtime. See ./legacy-rules.ts (the 17 original types) and ./new-rules.ts
 * (the types ported from CTS-A-O).
 */
import type { CommonSeriesContext } from "./context"
import { clamp, round } from "./kn-math"
import { LEGACY_COMMON_RULES, type CommonRule, type RuleParams } from "./legacy-rules"
import { NEW_COMMON_RULES } from "./new-rules"
import type { CommonRuleSample, TechnicalDirection } from "./types"

export type { CommonRule, RuleParams }

export const COMMON_RULES: ReadonlyMap<string, CommonRule> = new Map(
  [...LEGACY_COMMON_RULES, ...NEW_COMMON_RULES].map((rule) => [rule.type, rule]),
)

export function getCommonRule(type: string): CommonRule | undefined {
  return COMMON_RULES.get(type === "sar" ? "psar" : type)
}

export interface CommonRuleResult {
  type: string
  direction: TechnicalDirection
  strength: number
  value: number
  signal: number
  details: Record<string, number>
}

/** The Common result shape: strength clamped to [0, 1], every number rounded to 8 decimals. */
export function toCommonResult(type: string, sample: CommonRuleSample): CommonRuleResult {
  const details = sample.details || {}
  const roundedDetails: Record<string, number> = {}
  for (const key of Object.keys(details)) roundedDetails[key] = round(details[key])
  return {
    type,
    direction: sample.direction,
    strength: round(clamp(sample.strength, 0, 1)),
    value: round(sample.value),
    signal: round(sample.signal),
    details: roundedDetails,
  }
}

/**
 * Evaluate one rule at the last bar of the context. Returns undefined while the
 * series is shorter than the rule's warm-up (no result, as before).
 */
export function evaluateCommonRule(
  ctx: CommonSeriesContext,
  rule: CommonRule,
  rawParams: Record<string, number> | undefined,
  periodInput: number,
): CommonRuleResult | undefined {
  if (ctx.length === 0) return undefined
  const params = rule.resolve(rawParams, periodInput)
  if (ctx.length < rule.warmup(params)) return undefined
  const sample = rule.at(ctx, params, ctx.length - 1)
  return sample ? toCommonResult(rule.type, sample) : undefined
}

/**
 * The rule's direction at every bar (+1 / −1 / 0), 0 before its warm-up. Bar i
 * equals the live last-bar direction of the series cut after bar i (causal).
 */
export function commonRuleStates(
  ctx: CommonSeriesContext,
  rule: CommonRule,
  rawParams: Record<string, number> | undefined,
  periodInput = 14,
): Int8Array {
  const params = rule.resolve(rawParams, periodInput)
  const warmup = rule.warmup(params)
  const n = ctx.length
  const out = new Int8Array(n)
  if (rule.states) {
    const states = rule.states(ctx, params)
    for (let index = Math.max(0, warmup - 1); index < n; index++) out[index] = states[index]
    return out
  }
  for (let index = Math.max(0, warmup - 1); index < n; index++) {
    const sample = rule.at(ctx, params, index)
    out[index] = sample?.direction === "long" ? 1 : sample?.direction === "short" ? -1 : 0
  }
  return out
}

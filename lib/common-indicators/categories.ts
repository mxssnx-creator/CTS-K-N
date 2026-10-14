/**
 * Auto's Common vote, one vote per category.
 *
 * With 129 Common types a per-type vote would let the largest family (many
 * oscillator variants, or the always-on trend states) decide every window. Each
 * category instead casts one vote: the majority of its types' directions (a tie
 * is neutral, a neutral type abstains). `minimumSignals` and `minAgreement`
 * therefore count agreeing categories.
 */
import { COMMON_INDICATOR_DEFINITION_BY_TYPE } from "@/lib/common-indicator-config"
import { round } from "./kn-math"
import { COMMON_INDICATOR_CATEGORIES, type CommonIndicatorCategory, type TechnicalDirection } from "./types"

interface DirectionalReading {
  direction: TechnicalDirection
  strength: number
}

export interface CommonCategoryVote {
  direction: TechnicalDirection
  long: number
  short: number
  neutral: number
  strength: number
}

export interface CommonCategorySummary {
  direction: TechnicalDirection
  agreement: number
  strength: number
  longVotes: number
  shortVotes: number
  neutralVotes: number
  signals: number
  categories: Partial<Record<CommonIndicatorCategory, CommonCategoryVote>>
}

function majority(readings: readonly DirectionalReading[]): CommonCategoryVote {
  let long = 0
  let short = 0
  let longStrength = 0
  let shortStrength = 0
  for (const reading of readings) {
    if (reading.direction === "long") {
      long++
      longStrength += reading.strength
    } else if (reading.direction === "short") {
      short++
      shortStrength += reading.strength
    }
  }
  const direction: TechnicalDirection = long === short ? "neutral" : long > short ? "long" : "short"
  const strength = direction === "long" ? longStrength / long : direction === "short" ? shortStrength / short : 0
  return { direction, long, short, neutral: readings.length - long - short, strength: round(strength) }
}

/**
 * Summarize per-type results (keyed by Common type) into one vote per
 * category. The returned shape is a superset of summarizeTechnicalIndicators',
 * so Auto reads it unchanged.
 */
export function summarizeCommonCategories(
  indicators: Partial<Record<string, DirectionalReading>>,
): CommonCategorySummary {
  const byCategory = new Map<CommonIndicatorCategory, DirectionalReading[]>()
  for (const [type, reading] of Object.entries(indicators)) {
    if (!reading) continue
    const category = COMMON_INDICATOR_DEFINITION_BY_TYPE.get(type)?.category
    if (!category) continue
    const list = byCategory.get(category)
    if (list) list.push(reading)
    else byCategory.set(category, [reading])
  }
  const categories: Partial<Record<CommonIndicatorCategory, CommonCategoryVote>> = {}
  const votes: CommonCategoryVote[] = []
  for (const category of COMMON_INDICATOR_CATEGORIES) {
    const readings = byCategory.get(category)
    if (!readings || readings.length === 0) continue
    const vote = majority(readings)
    categories[category] = vote
    votes.push(vote)
  }
  const long = votes.filter((vote) => vote.direction === "long")
  const short = votes.filter((vote) => vote.direction === "short")
  const directional = long.length + short.length
  const direction: TechnicalDirection = long.length === short.length
    ? "neutral"
    : long.length > short.length
      ? "long"
      : "short"
  const selected = direction === "long" ? long : direction === "short" ? short : []
  return {
    direction,
    agreement: directional > 0 ? round(Math.max(long.length, short.length) / directional) : 0,
    strength: selected.length > 0
      ? round(selected.reduce((sum, vote) => sum + vote.strength, 0) / selected.length)
      : 0,
    longVotes: long.length,
    shortVotes: short.length,
    neutralVotes: votes.length - directional,
    signals: directional,
    categories,
  }
}

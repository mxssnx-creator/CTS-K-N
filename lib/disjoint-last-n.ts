import { AUTO_PF_CALIBRATION, LAST_N_OUTCOME_RING_CAP, blockPolicyKey, checkBlockPolicy, type BlockPolicy, type Polarity } from "@/shared/cts-lastn/blocks"
export const DEFAULT_AUTO_PF_RATIO = 4;
export function normalizeStageAutoPfRatio(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_AUTO_PF_RATIO;
  const ratio = typeof value === "string" ? Number(value) : value;
  if (typeof ratio !== "number" || !Number.isInteger(ratio) || ratio < 1 || ratio > 10)
    throw new Error("Auto PF ratio must be a whole number from 1 to 10");
  return ratio;
}
export const LAST_N_STAGES = ["base", "main", "real", "live"] as const
export type LastNStage = typeof LAST_N_STAGES[number]
export interface StageBlockGrid {
  long: number[]
  short: number[]
  minimal: number[]
  shortPolarity: Polarity[]
  minimalPolarity: Polarity[]
}
export type StageBlockPolicy = BlockPolicy & {
  grid?: StageBlockGrid
  longMode?: "configured" | "inherit" | "none" | "both"
}
export type StageBlockPolicies = Partial<Record<LastNStage, StageBlockPolicy>>

export function baseLongChoices(policies: StageBlockPolicies): number[] {
  const base = policies.base
  return base ? (base.grid?.long ?? [base.long]).filter(count => count > 0) : []
}

function gridValues<T>(value: unknown, label: string, valid: (item: unknown) => item is T): T[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(valid)) {
    throw new Error(`Invalid Last-N ${label} choices`)
  }
  return [...new Set(value)]
}

function normalizeGrid(raw: StageBlockGrid): StageBlockGrid {
  const count = (maximum: number) => (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum
  const polarity = (value: unknown): value is Polarity => value === "positive" || value === "negative"
  const grid = {
    long: gridValues(raw?.long, "Long", count(500)),
    short: gridValues(raw?.short, "Short", count(200)),
    minimal: gridValues(raw?.minimal, "Last", count(5)),
    shortPolarity: gridValues(raw?.shortPolarity, "Short condition", polarity),
    minimalPolarity: gridValues(raw?.minimalPolarity, "Last condition", polarity),
  }
  if ([grid.long, grid.short, grid.minimal].every(values => values.every(value => value === 0))) {
    throw new Error("A Last-N grid requires at least one nonempty block")
  }
  return grid
}

export function stageBlockPolicies(raw: unknown): StageBlockPolicies {
  if (raw == null || raw === "") return {}
  const value = typeof raw === "string" ? JSON.parse(raw) : raw
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Last-N block policies")
  const policies: StageBlockPolicies = {}
  for (const [name, candidate] of Object.entries(value)) {
    const stage = LAST_N_STAGES.find(item => item === name)
    if (!stage) throw new Error("Unknown Last-N stage")
    const policy = candidate as StageBlockPolicy
    checkBlockPolicy(policy)
    const { grid, longMode, ...block } = policy
    if (longMode !== undefined && (stage === "base" || !["configured", "inherit", "none", "both"].includes(longMode))) {
      throw new Error("Invalid stage Long mode")
    }
    policies[stage] = { ...block, ...(grid !== undefined && { grid: normalizeGrid(grid) }), ...(longMode && { longMode }) }
  }
  if (!usesIndependentLastNLanes(policies)) return policies
  for (const stage of LAST_N_STAGES) {
    const policy = policies[stage]
    if (!policy) continue
    const inherited = policy.longMode === "inherit" || policy.longMode === "both"
    if (inherited && baseLongChoices(policies).length === 0) throw new Error("Configure Base Long before inheriting it")
    const { long, short, minimal } = stageWindowSizes(policies, policy)
    const maxRequired = Math.max(...long) + Math.max(...short) + Math.max(...minimal)
    if (!maxRequired) throw new Error("A stage without Long needs Short or Last")
    // Runtime applies the connection's Auto PF ratio to every stage.
    if (maxRequired + AUTO_PF_CALIBRATION > LAST_N_OUTCOME_RING_CAP) {
      throw new Error(`The ${stage} Last-N window exceeds the retained outcome history`)
    }
  }
  return policies
}

/** Scalar settings from existing installations retain their existing Set keys. */
export function usesIndependentLastNLanes(policies: StageBlockPolicies): boolean {
  return LAST_N_STAGES.some(stage => {
    const policy = policies[stage]
    return policy?.grid !== undefined || Boolean(policy?.longMode && policy.longMode !== "configured")
  })
}

function stageWindowSizes(policies: StageBlockPolicies, policy: StageBlockPolicy) {
  const { longMode, grid } = policy
  const long = longMode === "both" ? [...baseLongChoices(policies), 0]
    : longMode === "inherit" ? baseLongChoices(policies)
    : longMode === "none" ? [0]
    : grid?.long ?? [policy.long]
  return { long, short: grid?.short ?? [policy.short], minimal: grid?.minimal ?? [policy.minimal] }
}

export function stageLastNChoices(policies: StageBlockPolicies, stage: LastNStage): BlockPolicy[] {
  // An unconfigured downstream stage inherits the nearest configured stage's
  // choices. Each choice is evaluated again on each immediate parent path.
  const origin = LAST_N_STAGES.slice(0, LAST_N_STAGES.indexOf(stage) + 1).reverse().find(item => policies[item])
  const policy = origin ? policies[origin] : undefined
  if (!policy) return []
  const { grid, autoPfRatio } = policy
  const sizes = stageWindowSizes(policies, policy)
  const choices = new Map<string, BlockPolicy>()
  for (const long of sizes.long) for (const short of sizes.short) {
    for (const minimal of sizes.minimal) {
      if (long + short + minimal === 0) continue
      for (const shortPolarity of short === 0 ? ["positive"] as const : grid?.shortPolarity ?? [policy.shortPolarity]) {
        for (const minimalPolarity of minimal === 0 ? ["positive"] as const : grid?.minimalPolarity ?? [policy.minimalPolarity]) {
          const choice = { long, short, minimal, shortPolarity, minimalPolarity, autoPfRatio }
          choices.set(blockPolicyKey(choice), choice)
        }
      }
    }
  }
  return Array.from(choices.values())
}

/** Only signed ancestors of this exact path receive its outcomes. */
export function stageLastNAncestors(setKey: string): string[] {
  if (!setKey.includes("#lastn-")) return []
  const [root, ...segments] = setKey.split("#")
  const ancestors: string[] = []
  let prefix = root
  for (const segment of segments) {
    prefix += `#${segment}`
    if (/^lastn-(base|main|real|live):l\d+:s\d+[pn]:m\d+[pn]:a\d+$/.test(segment)) ancestors.push(prefix)
  }
  return ancestors
}

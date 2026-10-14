import type { SeriesCache } from "./series-cache"

/** A CTS-A-O rule: a causal per-bar state (+1 long, −1 short, 0 none) of one series for one parameter tuple. */
export type AoRuleFn = (k: SeriesCache, p: Record<string, number>) => Int8Array

/** One CTS-A-O rule as registered by its source module, with the reference's short and medium parameters. */
export interface AoRuleSource {
  id: string
  kind: string
  label: string
  short: Record<string, number>
  medium: Record<string, number>
  fn: AoRuleFn
}

/** The registration shim the ported research modules call in place of CTS-A-O's `both(…)`. */
export type AoBoth = (
  kind: string,
  id: string,
  label: string,
  short: Record<string, number>,
  medium: Record<string, number>,
  fn: AoRuleFn,
) => void

export function collectAoRules(register: (both: AoBoth) => void): Map<string, AoRuleSource> {
  const rules = new Map<string, AoRuleSource>()
  register((kind, id, label, short, medium, fn) => {
    if (rules.has(id)) throw new Error(`duplicate CTS-A-O rule ${id}`)
    rules.set(id, { id, kind, label, short, medium, fn })
  })
  return rules
}

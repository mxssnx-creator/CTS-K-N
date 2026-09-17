/**
 * Historic Test — admission gate for live dispatch.
 *
 * Maps a strategy Set onto the combination the Historic Test validated and
 * decides whether the engine may act on it.
 *
 * The gate is deliberately conservative in one direction only: with the test
 * disabled nothing changes, and with it enabled a Set is admitted only if its
 * exact combination was validated. A Set whose identity cannot be resolved —
 * no symbol, no indication — is NOT admitted while the test is on, because
 * admitting an unidentifiable Set would silently reopen the gate the operator
 * closed.
 *
 * Signal lanes keep their independent admission and are never gated here, the
 * same exemption they have from the family switches.
 */
import { classifyStrategyExecutionFamily } from "@/lib/strategy-execution-policy"
import { combinationKeyOf } from "@/lib/historic-test-scoring"
import type { HistoricTestSettings, HistoricTestStrategyFamily } from "@/lib/historic-test-settings"

const HISTORIC_FAMILIES = new Set<HistoricTestStrategyFamily>(["normal", "trailing", "axis", "block", "dca"])

export interface HistoricAdmissionIdentity {
  symbol: string
  indication: string
  family: HistoricTestStrategyFamily
  variant?: string
}

/** Block count carried by a Set, if any — it is what makes a Block Set its own config. */
export function resolveSetBlockCount(set: any): number | null {
  const direct = Number(set?.blockCount ?? set?.axisWindows?.cont)
  if (Number.isFinite(direct) && direct > 0) return Math.floor(direct)
  const fromKey = String(set?.setKey || "").match(/#block:(?:row_live:)?(\d+)/)
  if (fromKey) {
    const count = Number(fromKey[1])
    if (Number.isFinite(count) && count > 0) return count
  }
  return null
}

/**
 * Resolve the validated-combination identity of a Set. Returns null when the
 * Set is not something the Historic Test scores (a Signal row, or a family
 * outside the five).
 */
export function resolveHistoricAdmissionIdentity(set: any): HistoricAdmissionIdentity | null {
  const family = classifyStrategyExecutionFamily(set)
  if (family === "signal") return null
  if (!HISTORIC_FAMILIES.has(family as HistoricTestStrategyFamily)) return null
  const symbol = String(set?.symbol || "").trim().toUpperCase()
  const indication = String(set?.indicationType || set?.indication || "").trim().toLowerCase()
  if (!symbol || !indication) return null
  const identity: HistoricAdmissionIdentity = {
    symbol,
    indication,
    family: family as HistoricTestStrategyFamily,
  }
  if (family === "block") {
    const count = resolveSetBlockCount(set)
    if (count != null) identity.variant = `count:${count}`
  }
  return identity
}

/**
 * Whether the engine may dispatch this Set under the Historic Test.
 *
 * Disabled -> always. Enabled -> only a validated combination; an unresolvable
 * identity is refused rather than waved through.
 */
export function isSetHistoricAdmitted(
  set: any,
  settings: HistoricTestSettings | null | undefined,
  validatedKeys: ReadonlySet<string>,
): boolean {
  if (!settings?.enabled) return true
  const family = classifyStrategyExecutionFamily(set)
  // Signal lanes are independent of this gate, as they are of the family
  // switches.
  if (family === "signal") return true
  const identity = resolveHistoricAdmissionIdentity(set)
  if (!identity) return false
  return validatedKeys.has(combinationKeyOf(identity))
}

/** Filter dispatch candidates through the gate, preserving order. */
export function filterHistoricAdmittedSets<T>(
  candidates: readonly T[],
  settings: HistoricTestSettings | null | undefined,
  validatedKeys: ReadonlySet<string>,
): T[] {
  if (!settings?.enabled) return [...(candidates || [])]
  return (candidates || []).filter((set) => isSetHistoricAdmitted(set, settings, validatedKeys))
}

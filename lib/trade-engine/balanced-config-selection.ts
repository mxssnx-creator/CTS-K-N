/**
 * Deterministically select a bounded, type-balanced configuration core.
 *
 * Historic bootstrap previously processed the first 100 indication and first
 * 100 strategy configs. Apart from being too expensive for a 12-symbol cold
 * start, insertion order could let one type consume nearly the whole budget.
 * Round-robin selection keeps every configured type represented and preserves
 * the original order within each type.
 */
export function selectBalancedConfigs<T extends { type?: string }>(
  configs: readonly T[],
  requestedLimit: number,
): T[] {
  const limit = Math.max(1, Math.min(configs.length, Math.floor(requestedLimit)))
  if (configs.length <= limit) return [...configs]

  const groups = new Map<string, T[]>()
  for (const config of configs) {
    const type = String(config.type || "unknown")
    const group = groups.get(type)
    if (group) group.push(config)
    else groups.set(type, [config])
  }

  const cursors = new Map<string, number>()
  const selected: T[] = []
  while (selected.length < limit) {
    let added = false
    for (const [type, group] of groups) {
      const cursor = cursors.get(type) || 0
      if (cursor >= group.length) continue
      selected.push(group[cursor])
      cursors.set(type, cursor + 1)
      added = true
      if (selected.length >= limit) break
    }
    if (!added) break
  }
  return selected
}

export function resolvePrehistoricConfigLimit(
  domain: "indication" | "strategy",
  available: number,
): number {
  const domainEnv = domain === "indication"
    ? process.env.PREHISTORIC_INDICATION_CONFIG_LIMIT
    : process.env.PREHISTORIC_STRATEGY_CONFIG_LIMIT
  const raw = Number(domainEnv ?? process.env.PREHISTORIC_CONFIG_LIMIT ?? 32)
  const normalized = Number.isFinite(raw) ? Math.floor(raw) : 32
  return Math.max(4, Math.min(Math.max(4, available), normalized))
}

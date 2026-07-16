/**
 * Exact Set/Base lineages owned by one non-terminal Live position.
 * Accumulated Block/DCA/axis Sets remain active until the owning position
 * reaches a terminal state, while duplicate/blank values are discarded.
 */
export function getLivePositionSetLineageKeys(position: {
  setKey?: string
  parentSetKey?: string
  accumulatedSetKeys?: string[]
}): string[] {
  const keys = new Set<string>()
  const add = (raw: unknown) => {
    const key = String(raw || "").trim()
    if (!key) return
    keys.add(key)
    const parent = key.split("#")[0]
    if (parent) keys.add(parent)
  }
  add(position.setKey)
  add(position.parentSetKey)
  for (const key of position.accumulatedSetKeys || []) add(key)
  return [...keys]
}

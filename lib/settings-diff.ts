function normalizeScalar(value: unknown): unknown {
  if (typeof value !== "string") return value
  const trimmed = value.trim()
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  if (trimmed === "null") return null
  if (trimmed !== "" && /^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) {
    const numeric = Number(trimmed)
    if (Number.isFinite(numeric)) return numeric
  }
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try { return JSON.parse(trimmed) } catch { /* retain malformed scalar */ }
  }
  return value
}

function canonicalize(value: unknown): unknown {
  const normalized = normalizeScalar(value)
  if (Array.isArray(normalized)) return normalized.map(canonicalize)
  if (normalized && typeof normalized === "object") {
    return Object.fromEntries(
      Object.entries(normalized as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    )
  }
  return normalized
}

export function settingsValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
}

export function changedSettingKeys(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  candidateKeys: Iterable<string>,
): string[] {
  const previous = before || {}
  const next = after || {}
  return Array.from(new Set(candidateKeys)).filter(
    (key) => !settingsValuesEqual(previous[key], next[key]),
  )
}

const QUICKSTART_AUDIT_FIELDS = new Set([
  "updated_at",
  "last_test_at",
  "last_test_balance",
  "last_test_status",
  "state_switch_version",
  "state_switch_action",
])

function normalizedComparable(value: unknown): unknown {
  if (value === undefined || value === null || value === "") return ""
  if (Array.isArray(value)) return value.map((entry) => normalizedComparable(entry))
  if (typeof value === "boolean") return value ? "1" : "0"
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : ""
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizedComparable(entry)]),
    )
  }

  const text = String(value).trim()
  if (/^(?:true|false)$/i.test(text)) return text.toLowerCase() === "true" ? "1" : "0"
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) {
    const numeric = Number(text)
    if (Number.isFinite(numeric)) return String(numeric)
  }
  if ((text.startsWith("[") && text.endsWith("]")) || (text.startsWith("{") && text.endsWith("}"))) {
    try {
      return normalizedComparable(JSON.parse(text))
    } catch {
      // A malformed legacy value is different from the canonical replacement.
    }
  }
  return text
}

export function quickStartValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizedComparable(left)) === JSON.stringify(normalizedComparable(right))
}

export function sameOrderedSymbols(left: unknown[], right: unknown[]): boolean {
  if (left.length !== right.length) return false
  return left.every((symbol, index) => (
    String(symbol || "").trim().toUpperCase() === String(right[index] || "").trim().toUpperCase()
  ))
}

/**
 * Return only processing-relevant QuickStart changes. QuickStart also refreshes
 * audit timestamps and the state-switch fence on every click; treating those
 * volatile fields (or unchanged settings snapshots) as symbol/PF changes reset
 * Historic/Main progress even when the operator submitted the same values.
 */
export function collectQuickStartChangedFields(input: {
  beforeConnection: Record<string, unknown>
  beforeSettings: Record<string, unknown>
  nextConnection: Record<string, unknown>
  nextSettings: Record<string, unknown>
}): string[] {
  const changed = new Set<string>()
  for (const [field, value] of Object.entries(input.nextConnection)) {
    if (QUICKSTART_AUDIT_FIELDS.has(field)) continue
    if (!quickStartValuesEqual(input.beforeConnection[field], value)) changed.add(field)
  }
  for (const [field, value] of Object.entries(input.nextSettings)) {
    if (QUICKSTART_AUDIT_FIELDS.has(field)) continue
    if (!quickStartValuesEqual(input.beforeSettings[field], value)) {
      changed.add(`connection_settings.${field}`)
    }
  }
  return Array.from(changed)
}

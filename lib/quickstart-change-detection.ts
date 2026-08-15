const QUICKSTART_AUDIT_FIELDS = new Set([
  "updated_at",
  "last_test_at",
  "last_test_balance",
  "last_test_status",
  "state_switch_version",
  "state_switch_action",
])

const QUICKSTART_SYMBOL_ALIAS_FIELDS = new Set([
  "symbols",
  "force_symbols",
  "active_symbols",
  "selected_symbols",
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

function parseComparableSymbols(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(
      value.map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean),
    ))
  }
  if (typeof value !== "string" || !value.trim()) return []
  try {
    const decoded = JSON.parse(value)
    if (Array.isArray(decoded)) return parseComparableSymbols(decoded)
  } catch {
    // Legacy comma/newline/pipe-separated mirrors remain comparable.
  }
  return parseComparableSymbols(value.split(/[\n,|]/))
}

export function resolveQuickStartPreviousSymbolBasket(
  beforeConnection: Record<string, unknown> | null | undefined,
  beforeSettings: Record<string, unknown> | null | undefined,
  beforeEngineState: Record<string, unknown> | null | undefined = undefined,
): string[] {
  const connection = beforeConnection || {}
  const settings = beforeSettings || {}
  const engineState = beforeEngineState || {}
  // Operator settings are the durable source of intent. Runtime connection
  // aliases may be absent or lag one write during a process hand-off, so a
  // missing alias on one mirror must not manufacture a basket change when
  // another canonical mirror already owns the exact ordered selection. The
  // engine-state aliases are deliberately last: startup/bootstrap workers may
  // briefly publish a volatility-ranked runtime basket from the previous
  // owner, but that must not rotate the user's unchanged selection epoch.
  const candidates = [
    settings.force_symbols,
    settings.selected_symbols,
    connection.force_symbols,
    connection.selected_symbols,
    settings.symbols,
    settings.active_symbols,
    connection.active_symbols,
    connection.symbols,
    engineState.force_symbols,
    engineState.selected_symbols,
    engineState.active_symbols,
    engineState.symbols,
  ]
  return candidates.map(parseComparableSymbols).find((symbols) => symbols.length > 0) || []
}

/**
 * Return only processing-relevant QuickStart changes. QuickStart also refreshes
 * audit timestamps and the state-switch fence on every click; treating those
 * volatile fields (or unchanged settings snapshots) as symbol/PF changes reset
 * Historic/Main progress even when the operator submitted the same values.
 */
export function collectQuickStartChangedFields(input: {
  beforeConnection: Record<string, unknown> | null | undefined
  beforeSettings: Record<string, unknown> | null | undefined
  nextConnection: Record<string, unknown>
  nextSettings: Record<string, unknown>
}): string[] {
  const changed = new Set<string>()
  const beforeConnection = input.beforeConnection || {}
  const beforeSettings = input.beforeSettings || {}
  const beforeSymbols = resolveQuickStartPreviousSymbolBasket(beforeConnection, beforeSettings)
  const symbolAliasUnchanged = (field: string, value: unknown) =>
    QUICKSTART_SYMBOL_ALIAS_FIELDS.has(field) &&
    beforeSymbols.length > 0 &&
    sameOrderedSymbols(beforeSymbols, parseComparableSymbols(value))
  for (const [field, value] of Object.entries(input.nextConnection)) {
    if (QUICKSTART_AUDIT_FIELDS.has(field)) continue
    if (symbolAliasUnchanged(field, value)) continue
    if (!quickStartValuesEqual(beforeConnection[field], value)) changed.add(field)
  }
  for (const [field, value] of Object.entries(input.nextSettings)) {
    if (QUICKSTART_AUDIT_FIELDS.has(field)) continue
    if (symbolAliasUnchanged(field, value)) continue
    if (!quickStartValuesEqual(beforeSettings[field], value)) {
      changed.add(`connection_settings.${field}`)
    }
  }
  return Array.from(changed)
}

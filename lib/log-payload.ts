/** Diagnostic snapshots must not retain an engine's candle/Set object graph. */
export function compactLogValue(value: unknown): any {
  let remainingNodes = 128
  let remainingCharacters = 6_000
  const seen = new WeakSet<object>()
  const text = (value: string) => {
    const result = value.slice(0, Math.min(512, remainingCharacters))
    remainingCharacters -= result.length
    return result.length < value.length ? `${result}…` : result
  }
  function visit(value: unknown, depth: number): any {
    if (--remainingNodes < 0 || remainingCharacters <= 0) return "[truncated]"
    if (value === null || value === undefined || typeof value === "boolean") return value ?? null
    if (typeof value === "string") return text(value)
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value)
    if (typeof value === "bigint") return text(String(value))
    if (typeof value !== "object") return `[${typeof value}]`
    if (depth >= 4) return "[depth limited]"
    if (seen.has(value)) return "[circular]"
    seen.add(value)
    if (value instanceof Error) return { name: text(value.name), message: text(value.message), stack: text(value.stack || "") }
    if (Array.isArray(value)) {
      const result = []
      for (let i = 0; i < Math.min(value.length, 12) && remainingNodes > 0; i++) result.push(visit(value[i], depth + 1))
      if (result.length < value.length) result.push(`[${value.length - result.length} more items]`)
      return result
    }
    const result: Record<string, any> = Object.create(null)
    let count = 0
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue
      if (count++ >= 24 || remainingNodes <= 0 || remainingCharacters <= 0) {
        result._truncated = true
        break
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      result[text(key)] = /secret|password|authorization|api.?key|access.?token|private.?key/i.test(key)
        ? "[redacted]"
        : descriptor && "value" in descriptor ? visit(descriptor.value, depth + 1) : "[accessor omitted]"
    }
    return result
  }
  try { return visit(value, 0) } catch { return { _truncated: true, reason: "unreadable diagnostic value" } }
}

export function serializeLogValue(value: unknown): string {
  const encoded = JSON.stringify(compactLogValue(value))
  // JSON escapes may expand a bounded string. Keep the result valid JSON.
  return encoded.length <= 8_192 ? encoded : JSON.stringify({ _truncated: true, preview: encoded.slice(0, 1_000) })
}

export function boundedLogLimit(value: unknown, fallback = 100, maximum = 500): number {
  const parsed = Number(value)
  return value == null || !Number.isFinite(parsed) ? fallback : Math.max(1, Math.min(maximum, Math.floor(parsed)))
}

export function isTruthyFlag(value: unknown): boolean {
  if (value === true || value === 1) return true
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
  }
  return false
}

export function parseBooleanInput(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value === 1
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (["1", "true", "yes", "on"].includes(normalized)) return true
    if (["0", "false", "no", "off"].includes(normalized)) return false
  }
  return fallback
}

export function toRedisFlag(value: unknown, fallback = false): "1" | "0" {
  return parseBooleanInput(value, fallback) ? "1" : "0"
}

export interface IndicationLaneIdentityInput {
  connectionId: string
  symbol: string
  type: string
  name: string
  direction: "long" | "short"
  config: unknown
}

function stableConfig(value: unknown): string {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (Array.isArray(value)) return `[${value.map(stableConfig).join(",")}]`
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${encodeURIComponent(key)}:${stableConfig(item)}`)
      .join(",")}}`
  }
  return encodeURIComponent(String(value))
}

function lanePart(value: unknown): string {
  return encodeURIComponent(String(value ?? "").trim().toLowerCase())
}

/**
 * Exact indication execution identity.
 *
 * No timeout, admission slot, result history, or status record may use a
 * broader key than this tuple:
 *   connection × symbol × type × name × complete config/Set × direction.
 */
export function canonicalIndicationLaneIdentity(
  input: IndicationLaneIdentityInput,
): string {
  return [
    `connection=${lanePart(input.connectionId)}`,
    `symbol=${lanePart(input.symbol)}`,
    `type=${lanePart(input.type)}`,
    `name=${lanePart(input.name)}`,
    `direction=${lanePart(input.direction)}`,
    `config=${stableConfig(input.config)}`,
  ].join("|")
}

export function indicationValidatedCooldownKey(
  input: IndicationLaneIdentityInput,
): string {
  return `indication_validated_cooldown:${canonicalIndicationLaneIdentity(input)}`
}

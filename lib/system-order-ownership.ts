/**
 * Canonical ownership checks for every exchange-order mutation.
 *
 * A symbol/direction match is never ownership: shared accounts can contain
 * operator and third-party positions in the same physical venue slot.  CTS
 * may mutate a lifecycle row only when its persisted connection id and both
 * durable watermarks match the requested connection exactly.  Venue orders
 * additionally use a connection-scoped client-order prefix.
 */

function text(value: unknown): string {
  return String(value ?? "").trim()
}

export function connectionTrackingId(connectionId: unknown): string {
  return `conn-${text(connectionId)}`
}

export function systemTrackingPrefix(connectionId: unknown): string {
  return `sys-${text(connectionId)}-`
}

/**
 * Short hash that identifies THIS system on one connection. Other systems
 * trade the same accounts (X01: a second system with client ids "ctsax1_…";
 * the bots with "cb…"). The legacy prefix "cts" + connection is not unique to
 * this system — another CTS variant on the same connection produces exactly
 * the same prefix, and its orders would then be taken for ours (mapped,
 * called orphaned, even cancelled). New client ids therefore start with
 * "kn" + a 6-character hash of the system id (CTS_SYSTEM_ID, default
 * "cts-k-n") and the connection id.
 */
export function systemOrderHash(connectionId: unknown): string {
  const input = `${text(process.env.CTS_SYSTEM_ID) || "cts-k-n"}|${text(connectionId)}`
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).padStart(6, "0").slice(-6)
}
export function clientOrderSystemPrefix(connectionId: unknown): string {
  return `kn${systemOrderHash(connectionId)}`
}
/**
 * The order's type inside this system, one character after the system hash:
 * m = main, p = preset, s = signal, d = direct trade, b = bot. The connection
 * is part of the hash, so an id names system, connection AND type — each part
 * of the system can tell its own orders from another part's.
 */
export type SystemOrderType = "main" | "preset" | "signal" | "direct" | "bot"
const TYPE_CODE: Record<SystemOrderType, string> = { main: "m", preset: "p", signal: "s", direct: "d", bot: "b" }
const CODE_TYPE: Record<string, SystemOrderType> = { m: "main", p: "preset", s: "signal", d: "direct", b: "bot" }
export function normalizeSystemOrderType(value: unknown): SystemOrderType {
  const v = text(value).toLowerCase()
  return (["main", "preset", "signal", "direct", "bot"] as const).includes(v as SystemOrderType) ? v as SystemOrderType : "main"
}
/** "kt" + system/connection hash: the prefix of ids that carry a type character. */
export function clientOrderTypedPrefix(connectionId: unknown): string {
  return `kt${systemOrderHash(connectionId)}`
}
export function clientOrderSystemTypePrefix(connectionId: unknown, type: unknown): string {
  return `${clientOrderTypedPrefix(connectionId)}${TYPE_CODE[normalizeSystemOrderType(type)]}`
}
/** The type of one of our orders; "legacy" for ids before the short hash, null when not ours. */
export function clientOrderTypeOf(clientOrderId: unknown, connectionId: unknown): SystemOrderType | "legacy" | null {
  const id = text(clientOrderId).toLowerCase()
  // Only a TYPED id ("kt" + hash + type character) carries a type. An id with
  // the plain "kn" + hash prefix (#498, before the type character existed) has
  // NO type: reading the character after its hash as a type turned the "s" of
  // "sl…" (stop loss) into a Signal order and could make the slot audit miss an
  // own control ("stop missing"). Those, and pre-hash ids, stay "legacy": owned,
  // untyped.
  const typed = clientOrderTypedPrefix(connectionId).toLowerCase()
  if (id.length > typed.length + 1 && id.startsWith(typed)) return CODE_TYPE[id.charAt(typed.length)] ?? "legacy"
  return isConnectionOwnedClientOrderId(id, connectionId) ? "legacy" : null
}
/**
 * Orders placed before the short hash carry the legacy prefix. They stay ours
 * so running positions keep their protection; set
 * CTS_ACCEPT_LEGACY_ORDER_PREFIX=0 once none of them remain.
 */
export function legacyOrderPrefixAccepted(): boolean {
  return text(process.env.CTS_ACCEPT_LEGACY_ORDER_PREFIX) !== "0"
}
export function clientOrderConnectionPrefix(connectionId: unknown): string {
  const compact = text(connectionId)
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 8)
    .toLowerCase()
  return `cts${compact || "x"}`
}

export function isExactSystemPositionOwner(
  position: Record<string, any> | null | undefined,
  connectionId: unknown,
): boolean {
  if (!position) return false
  const expectedConnectionId = text(connectionId)
  if (!expectedConnectionId) return false

  const persistedConnectionId = text(
    position.connectionId ?? position.connection_id,
  )
  const systemTrackingId = text(
    position.system_tracking_id ?? position.systemTrackingId,
  )
  const persistedConnectionTrackingId = text(
    position.connection_tracking_id ?? position.connectionTrackingId,
  )
  const prefix = systemTrackingPrefix(expectedConnectionId)

  return (
    persistedConnectionId === expectedConnectionId &&
    systemTrackingId.startsWith(prefix) &&
    systemTrackingId.length > prefix.length &&
    persistedConnectionTrackingId === connectionTrackingId(expectedConnectionId)
  )
}

export function isConnectionOwnedClientOrderId(
  clientOrderId: unknown,
  connectionId: unknown,
): boolean {
  const id = text(clientOrderId).toLowerCase()
  if (!id) return false
  const systemPrefix = clientOrderSystemPrefix(connectionId).toLowerCase()
  if (id.length > systemPrefix.length && id.startsWith(systemPrefix)) return true
  const typedPrefix = clientOrderTypedPrefix(connectionId).toLowerCase()
  if (id.length > typedPrefix.length && id.startsWith(typedPrefix)) return true
  if (!legacyOrderPrefixAccepted()) return false
  const legacyPrefix = clientOrderConnectionPrefix(connectionId)
  return id.length > legacyPrefix.length && id.startsWith(legacyPrefix)
}


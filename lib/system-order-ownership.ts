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
  if (!legacyOrderPrefixAccepted()) return false
  const legacyPrefix = clientOrderConnectionPrefix(connectionId)
  return id.length > legacyPrefix.length && id.startsWith(legacyPrefix)
}


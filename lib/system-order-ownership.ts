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
  const prefix = clientOrderConnectionPrefix(connectionId)
  return id.length > prefix.length && id.startsWith(prefix)
}


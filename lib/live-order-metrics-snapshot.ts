type ProgressionHash = Record<string, string> | null | undefined

const ORDER_FIELD = /^(?:live_orders_|live_positions_|live_simulated_|live_volume_)/

/**
 * recordLiveOrderProgression always writes the connection-wide ledger.
 * Engine generations reset independently, so merging individual fields from
 * their hashes mixes time windows (for example 1 attempt and 300,689 failures).
 * Select one whole ledger, including explicit zero values. Never manufacture
 * a complete snapshot from a partial or failed read.
 */
export function selectLiveOrderMetricsSnapshot(
  connectionLedger: ProgressionHash,
  engineLedger: ProgressionHash,
) {
  const hasOrders = (hash: ProgressionHash): hash is Record<string, string> =>
    Boolean(hash && Object.keys(hash).some((field) => ORDER_FIELD.test(field)))

  if (hasOrders(connectionLedger)) {
    return { values: connectionLedger, available: true, scope: "connection_lifetime" as const }
  }
  if (hasOrders(engineLedger)) {
    return { values: engineLedger, available: true, scope: "engine_snapshot" as const }
  }
  return { values: {} as Record<string, string>, available: false, scope: "unavailable" as const }
}

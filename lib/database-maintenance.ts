export const DATABASE_MAINTENANCE_STATUS_KEY = "system:database:maintenance"
export const DATABASE_MAINTENANCE_LOCK_KEY = "system:database:maintenance:lock"

function hasOwn(record: Record<string, any>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field)
}

/** Fill only missing canonical fields; never overwrite live progression data. */
export async function ensureUnifiedProgressionKeysWithClient(
  client: any,
  connectionId: string,
): Promise<boolean> {
  const key = `progression:${connectionId}`
  const [currentRaw, oldCycles, oldIndications, oldEngineStateRaw, oldTradeEngineStateRaw] = await Promise.all([
    client.hgetall(key).catch(() => ({})),
    client.get(`${key}:cycles`).catch(() => null),
    client.get(`${key}:indications`).catch(() => null),
    client.hgetall(`engine_state:${connectionId}`).catch(() => ({})),
    client.hgetall(`trade_engine_state:${connectionId}`).catch(() => ({})),
  ])
  const current = (currentRaw || {}) as Record<string, any>
  const oldEngineState = (oldEngineStateRaw || {}) as Record<string, any>
  const oldTradeEngineState = (oldTradeEngineStateRaw || {}) as Record<string, any>
  const candidates: Record<string, string> = {
    cycles_completed: String(current.cycles_completed ?? oldCycles ?? "0"),
    successful_cycles: String(current.successful_cycles ?? "0"),
    failed_cycles: String(current.failed_cycles ?? "0"),
    phase: String(current.phase ?? oldTradeEngineState.phase ?? "idle"),
    phase_progress: String(current.progress ?? oldEngineState.progress ?? "0"),
    phase_message: String(current.detail ?? oldEngineState.detail ?? ""),
    engine_started: String(oldEngineState.started_at ?? oldTradeEngineState.started_at ?? ""),
    last_cycle: String(current.last_cycle ?? ""),
    last_indication_count: String(current.indication_count ?? oldIndications ?? "0"),
    last_strategy_count: String(current.strategy_count ?? "0"),
    symbols_count: String(oldTradeEngineState.symbols_count ?? "0"),
  }
  const patch = Object.fromEntries(
    Object.entries(candidates).filter(([field]) => !hasOwn(current, field)),
  ) as Record<string, string>
  if (Object.keys(patch).length === 0) return false

  patch.structure_migrated_at = new Date().toISOString()
  await client.hset(key, patch)
  await Promise.all([
    client.expire(`${key}:cycles`, 86_400).catch(() => 0),
    client.expire(`${key}:indications`, 86_400).catch(() => 0),
    client.expire(`engine_state:${connectionId}`, 86_400).catch(() => 0),
  ])
  return true
}

function fingerprintHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

export function createDatabaseMaintenanceFingerprint(schemaVersion: number, connections: any[]): string {
  const rows = connections.map((connection) => [
    connection?.id,
    connection?.exchange,
    connection?.is_assigned,
    connection?.is_active_inserted,
    connection?.is_dashboard_inserted,
    connection?.is_enabled_dashboard,
    connection?.is_inserted,
    connection?.is_enabled,
    connection?.last_test_status ?? connection?.test_status ?? connection?.connection_status,
  ].map((value) => String(value ?? "")).join("|"))
  rows.sort()
  return `v${schemaVersion}:${rows.length}:${fingerprintHash(rows.join("\n"))}`
}

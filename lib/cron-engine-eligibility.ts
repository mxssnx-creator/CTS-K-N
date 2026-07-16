import { isConnectionReadyForEngine } from "@/lib/connection-state-helpers"

type CronOwnershipClient = {
  get: (key: string) => Promise<unknown>
  hgetall: (key: string) => Promise<Record<string, string> | null>
}

function isTruthyRunningFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true"
}

function readConnectionHeartbeatMs(state: Record<string, string> | null | undefined): number {
  const numeric = Number(state?.last_processor_heartbeat || 0)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  const iso = Date.parse(String(state?.last_live_positions_run || state?.updated_at || ""))
  return Number.isFinite(iso) ? iso : 0
}

/**
 * Remove connections already owned by a fresh TradeEngineManager.
 *
 * `generate-indications` is an engine-down/serverless fallback. Running its
 * full Indication -> Strategy -> Real/Live pipeline beside a healthy manager
 * duplicates Sets, races position dispatch, and roughly doubles cold-start
 * memory. Local ownership is authoritative; distributed ownership requires
 * both the per-connection running flag and a fresh per-connection heartbeat.
 * A global heartbeat cannot prove ownership of a specific connection: using
 * it as a fallback lets one healthy engine suppress recovery for every stale
 * sibling connection indefinitely.
 */
export async function filterCronFallbackConnections(
  connections: any[],
  client: CronOwnershipClient,
  isLocallyRunning: (connectionId: string) => boolean = () => false,
  now = Date.now(),
): Promise<{ eligible: any[]; skippedFreshOwners: number }> {
  if (connections.length === 0) return { eligible: [], skippedFreshOwners: 0 }

  const owned = await Promise.all(connections.map(async (connection) => {
    const connectionId = String(connection?.id || "")
    if (!connectionId) return false
    if (isLocallyRunning(connectionId)) return true

    const [runningFlag, settingsState, rawState] = await Promise.all([
      client.get(`engine_is_running:${connectionId}`).catch(() => null),
      client.hgetall(`settings:trade_engine_state:${connectionId}`).catch(() => null),
      client.hgetall(`trade_engine_state:${connectionId}`).catch(() => null),
    ])
    if (!isTruthyRunningFlag(runningFlag)) return false

    const newestConnectionHeartbeat = Math.max(
      readConnectionHeartbeatMs(settingsState),
      readConnectionHeartbeatMs(rawState),
    )
    const connectionHeartbeatFresh =
      newestConnectionHeartbeat > 0 && now - newestConnectionHeartbeat < 90_000
    return connectionHeartbeatFresh
  }))

  return {
    eligible: connections.filter((_, index) => !owned[index]),
    skippedFreshOwners: owned.filter(Boolean).length,
  }
}

export async function getCronEngineEligibleConnections(
  getAssignedAndEnabledConnections: () => Promise<any[]>,
  getQueuedEngineRefreshRequests: () => Promise<Array<{ request: any }>>,
  getConnection: (connectionId: string) => Promise<any>,
): Promise<any[]> {
  const activeConnections = await getAssignedAndEnabledConnections()
  const byId = new Map<string, any>()
  for (const connection of activeConnections) {
    if (connection?.id && isConnectionReadyForEngine(connection)) {
      byId.set(connection.id, connection)
    }
  }

  const queuedRequests = await getQueuedEngineRefreshRequests().catch(() => [] as Array<{ request: any }>)
  for (const { request } of queuedRequests) {
    if (request?.action !== "start" || !request.connectionId) continue

    const requestTime = new Date(request.timestamp).getTime()
    if (!Number.isFinite(requestTime) || Date.now() - requestTime >= 120_000) continue

    const connection = await getConnection(request.connectionId).catch(() => null)
    if (!connection || !isConnectionReadyForEngine(connection)) continue

    const currentVersion = String(connection.state_switch_version ?? 0)
    const requestedVersion = String(request.state_switch_version ?? "")
    if (requestedVersion && currentVersion !== requestedVersion) continue

    byId.set(connection.id, connection)
  }

  return Array.from(byId.values())
}

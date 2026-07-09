import { getRedisClient } from "./redis-db"

/**
 * The trade engine publishes its liveness heartbeat (`last_processor_heartbeat`,
 * `last_indication_run`) to `settings:trade_engine_state:{connectionId}`.
 *
 * Several ownership/cleanup paths (startEngine lock check, remote-restart marking,
 * boot-time orphan flag cleanup) historically read the RAW `trade_engine_state:{connectionId}`
 * hash instead. The engine does NOT keep that raw hash's heartbeat in sync, so a live,
 * healthy engine looked "stalled" to those readers — which then issued `stop_requested`,
 * force-broke the distributed lock, and restarted the engine. That restart loop is the
 * "multiple reinits / doubled progression / stalling stats" symptom.
 *
 * Always reconcile BOTH hashes and use the freshest heartbeat value.
 */

const HEARTBEAT_KEYS = ["last_processor_heartbeat", "last_indication_run"] as const

function toEpochMs(value: unknown): number {
  if (value == null || value === "") return 0
  const n = Number(value)
  if (Number.isFinite(n) && n > 0) return n
  const d = new Date(String(value)).getTime()
  return Number.isFinite(d) && d > 0 ? d : 0
}

export async function getFreshestProcessorHeartbeat(connectionId: string): Promise<number> {
  try {
    const client = getRedisClient()
    if (!client) return 0
    const [raw, settings] = await Promise.all([
      client.hgetall(`trade_engine_state:${connectionId}`).catch(() => ({} as Record<string, string>)),
      client.hgetall(`settings:trade_engine_state:${connectionId}`).catch(() => ({} as Record<string, string>)),
    ])
    let freshest = 0
    for (const src of [raw, settings]) {
      if (!src) continue
      for (const key of HEARTBEAT_KEYS) {
        const t = toEpochMs((src as Record<string, unknown>)[key])
        if (t > freshest) freshest = t
      }
    }
    return freshest
  } catch {
    return 0
  }
}

export async function isProcessorHeartbeatFresh(
  connectionId: string,
  freshnessMs = 90_000,
): Promise<boolean> {
  const ts = await getFreshestProcessorHeartbeat(connectionId)
  return ts > 0 && Date.now() - ts < freshnessMs
}

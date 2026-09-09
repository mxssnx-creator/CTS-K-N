import { createHash } from "node:crypto"
import { getAppSettings, getRedisClient, withSharedPersistenceLease } from "@/lib/redis-db"
import { liveConfigLossPolicy, type DeactivatedLiveConfig } from "@/lib/live-config-loss-policy"

type Row = Record<string, any>
interface Outcome { id: string; closedAt: number; pnl: number }
interface State { samples: Outcome[]; disabled?: DeactivatedLiveConfig }

/** Only exact participating Sets; never add an unexecuted parent or trim a config suffix. */
function identities(position: Row) {
  const symbol = String(position.symbol || "").trim().toUpperCase().replace(/[-_/]/g, "")
  const direction = String(position.direction || position.side || "").toLowerCase()
  const executionIntent = String(position.executionIntent || "main")
  if (!symbol || !["long", "short"].includes(direction)) return []
  return [...new Set([position.setKey, ...(Array.isArray(position.accumulatedSetKeys) ? position.accumulatedSetKeys : [])]
    .filter((key): key is string => typeof key === "string" && key.trim().length > 0))]
    .map((setKey) => ({
      id: createHash("sha256").update(JSON.stringify([symbol, direction, executionIntent, setKey])).digest("hex"),
      setKey, symbol, direction, executionIntent,
    }))
}

export function confirmedLiveConfigOutcome(position: Row): Outcome | null {
  if (position.executionMode !== "live" || position.status !== "closed"
    || position.realizedPnlComplete !== true || position.realizedPnlSource !== "exchange_settlement"
    || !position.id || !position.connectionId || !position.orderId
    || !(Math.max(Number(position.executedQuantity) || 0, Number(position.totalExecutedQuantity) || 0, Number(position.closedQuantity) || 0) > 0)
    || Number(position.remainingQuantity) > 0
    || !Number.isFinite(position.realizedPnL) || !(Number(position.closedAt) > 0)) return null
  return { id: String(position.id), closedAt: Number(position.closedAt), pnl: position.realizedPnL }
}

// One atomic update stores the bounded window, permanent latch and paginated
// statistics index. Replayed saves cannot consume another sample; old closes
// cannot displace the actual last 25. No key is created by a rejected entry.
export const RECORD_LIVE_CONFIG_OUTCOME_LUA = `
local state = cjson.decode(redis.call('HGET', KEYS[1], ARGV[1]) or '{"samples":[]}')
local sample = cjson.decode(ARGV[2])
local meta = cjson.decode(ARGV[3])
local window = tonumber(ARGV[4])
local samples = {}
for _, v in ipairs(state.samples) do
  if v.id ~= sample.id then table.insert(samples, v) end
end
table.insert(samples, sample)
table.sort(samples, function(a,b) if a.closedAt == b.closedAt then return a.id > b.id end return a.closedAt > b.closedAt end)
while #samples > 25 do table.remove(samples) end
state.samples = samples
if not state.disabled and ARGV[5] == '1' and #samples >= window then
  local net = 0
  for i=1,window do net = net + samples[i].pnl end
  if net < 0 then
    meta.disabledAt = tonumber(ARGV[6])
    meta.window = window
    meta.sampleCount = window
    meta.netPnl = net
    meta.reason = 'negative_live_window'
    state.disabled = meta
  end
end
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(state))
if state.disabled then
  redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(state.disabled))
  redis.call('ZADD', KEYS[3], -state.disabled.disabledAt, ARGV[1])
end
return cjson.encode(state)
`

export function updateLiveConfigOutcome(state: State, sample: Outcome,
  meta: Omit<DeactivatedLiveConfig, "disabledAt" | "window" | "sampleCount" | "netPnl" | "reason">,
  policy: ReturnType<typeof liveConfigLossPolicy>, now: number): State {
  const samples = [...state.samples.filter((v) => v.id !== sample.id), sample]
    .sort((a, b) => b.closedAt - a.closedAt || (a.id > b.id ? -1 : a.id < b.id ? 1 : 0)).slice(0, 25)
  const netPnl = samples.slice(0, policy.window).reduce((sum, v) => sum + v.pnl, 0)
  const disabled = state.disabled || (policy.enabled && samples.length >= policy.window && netPnl < 0
    ? { ...meta, disabledAt: now, window: policy.window, sampleCount: policy.window, netPnl, reason: "negative_live_window" as const }
    : undefined)
  return { samples, ...(disabled && { disabled }) }
}

const inlineWrites = new Map<string, Promise<unknown>>()
const keysFor = (connectionId: string) => [
  `live:config-outcomes:${connectionId}`,
  `live:deactivated-configs:${connectionId}`,
  `live:deactivated-configs:${connectionId}:index`,
]

export async function recordLiveConfigOutcome(position: Row): Promise<void> {
  const sample = confirmedLiveConfigOutcome(position)
  if (!sample) return
  const members = identities(position)
  if (!members.length) return
  const policy = liveConfigLossPolicy(await getAppSettings())
  const client = getRedisClient()
  const keys = keysFor(position.connectionId)
  for (const meta of members) {
    const now = Date.now()
    if (client.eval) {
      await client.eval(RECORD_LIVE_CONFIG_OUTCOME_LUA, {
        keys, arguments: [meta.id, JSON.stringify(sample), JSON.stringify(meta), String(policy.window), policy.enabled ? "1" : "0", String(now)],
      })
    } else {
      // Snapshot backends share a durable lease; process-local queues also
      // serialize concurrent closes in the deliberately single-process adapter.
      const scope = keys[0]
      const pending = (inlineWrites.get(scope) || Promise.resolve()).catch(() => undefined).then(() =>
        withSharedPersistenceLease("live-config-outcome", async () => {
          const raw = await client.hget(keys[0], meta.id)
          const state = updateLiveConfigOutcome(raw ? JSON.parse(String(raw)) : { samples: [] }, sample, meta, policy, now)
          await client.hset(keys[0], { [meta.id]: JSON.stringify(state) })
          if (state.disabled) {
            await client.hset(keys[1], { [meta.id]: JSON.stringify(state.disabled) })
            await client.zadd(keys[2], -state.disabled.disabledAt, meta.id)
          }
        }))
      inlineWrites.set(scope, pending)
      try { await pending } finally { if (inlineWrites.get(scope) === pending) inlineWrites.delete(scope) }
    }
  }
}

export async function findDeactivatedLiveConfig(connectionId: string, position: Row,
  settings: Record<string, unknown>): Promise<DeactivatedLiveConfig | null> {
  if (!liveConfigLossPolicy(settings).enabled) return null
  const client = getRedisClient()
  for (const meta of identities(position)) {
    const raw = await client.hget(keysFor(connectionId)[1], meta.id)
    if (raw) return JSON.parse(String(raw)) as DeactivatedLiveConfig
  }
  return null
}

export async function listDeactivatedLiveConfigs(connectionId: string, offset = 0, limit = 50) {
  const client = getRedisClient()
  const keys = keysFor(connectionId)
  const ids = await client.zrange(keys[2], offset, offset + limit - 1)
  const rows = await Promise.all(ids.map(async (id) => {
    const raw = await client.hget(keys[1], id)
    return raw ? JSON.parse(String(raw)) as DeactivatedLiveConfig : null
  }))
  return { rows: rows.filter((row): row is DeactivatedLiveConfig => row !== null), total: await client.zcard(keys[2]) }
}

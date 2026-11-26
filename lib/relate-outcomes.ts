import { getRedisClient } from "@/lib/redis-db"
import { relateLossLevel } from "@/shared/cts-relate/policy"
import type { RelateSettings } from "@/lib/relate-allocation"

const LIMIT = 500
const TTL_SECONDS = 90 * 24 * 60 * 60
const relationKey = (connId: string, relation: string, venue: boolean) =>
  `relate_outcomes_v1:${connId}:${venue ? "venue" : "paper"}:${relation}`

const RECORD_RELATE = `
  local inserted = 0
  for _, key in ipairs(KEYS) do
    local ids = key .. ':ids'
    if redis.call('HSETNX', ids, ARGV[1], ARGV[3]) == 1 then
      redis.call('ZADD', key, ARGV[2], ARGV[3])
      local excess = redis.call('ZCARD', key) - ${LIMIT}
      if excess > 0 then
        local stale = redis.call('ZRANGE', key, 0, excess - 1)
        for _, value in ipairs(stale) do redis.call('HDEL', ids, cjson.decode(value)[1]) end
        redis.call('ZREMRANGEBYRANK', key, 0, excess - 1)
      end
      redis.call('EXPIRE', ids, ${TTL_SECONDS})
      redis.call('EXPIRE', key, ${TTL_SECONDS})
      inserted = inserted + 1
    end
  end
  return inserted
`

/** Capture one verified close per owned position in each entry-time relation. */
export async function recordRelateOutcome(connId: string, id: string, relations: string[] | undefined,
  closedAt: number, pnlPct: number | undefined, venue: boolean): Promise<void> {
  if (!relations?.length || !connId || !id || !Number.isSafeInteger(closedAt) || closedAt <= 0 || !Number.isFinite(pnlPct)) return
  const client = getRedisClient()
  const keys = [...new Set(relations)].map(relation => relationKey(connId, relation, venue))
  const member = JSON.stringify([id, pnlPct])
  if (typeof client.eval === "function") {
    try {
      await client.eval(RECORD_RELATE, { keys, arguments: [id, String(closedAt), member] })
      return
    } catch {
      // The memory adapter uses deterministic sorted-set members.
    }
  }
  const batch = client.multi()
  for (const key of keys) {
    batch.zadd(key, closedAt, member)
    batch.zremrangebyrank(key, 0, -LIMIT - 1)
    batch.expire(key, TTL_SECONDS)
  }
  await batch.exec()
}

export async function getRelateLevels(connId: string, relations: readonly string[], policy: RelateSettings,
  before: number, venue: boolean): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>()
  if (!relations.length) return result
  const client = getRedisClient()
  for (let start = 0; start < relations.length; start += 100) {
    const keys = relations.slice(start, start + 100)
    const batch = client.multi()
    for (const key of keys) batch.zrangebyscore(relationKey(connId, key, venue), "-inf", before - 1)
    const replies = await batch.exec()
    keys.forEach((key, index) => {
      const reply = replies?.[index]
      const rows = Array.isArray(reply) && reply.length === 2 && reply[0] === null && Array.isArray(reply[1]) ? reply[1] : reply
      if (!Array.isArray(rows) || rows.length < policy.minTrades) return
      const samples = rows.slice(-policy.lastN).reverse().map(row => {
        try {
          const value: unknown = JSON.parse(String(row))[1]
          return typeof value === "number" ? value : undefined
        } catch {
          return undefined
        }
      })
      result.set(key, relateLossLevel(samples, policy))
    })
  }
  return result
}

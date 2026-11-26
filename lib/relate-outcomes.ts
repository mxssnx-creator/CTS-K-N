import { getRedisClient } from "@/lib/redis-db"
import { relateLossLevel } from "@/shared/cts-relate/policy"
import type { RelateCloseWindow, RelateSettings, RelateTrialStamps } from "@/lib/relate-allocation"
import type { RelateTrial } from "@/shared/cts-relate/recovery"

const LIMIT = 500
const TTL_SECONDS = 90 * 24 * 60 * 60
const relationKey = (connId: string, relation: string, venue: boolean) =>
  `relate_outcomes_v1:${connId}:${venue ? "venue" : "paper"}:${relation}`

const RECORD_RELATE = `
  local inserted = 0
  for index, key in ipairs(KEYS) do
    local ids = key .. ':ids'
    local member = ARGV[index + 2]
    if redis.call('HSETNX', ids, ARGV[1], member) == 1 then
      redis.call('ZADD', key, ARGV[2], member)
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
  closedAt: number, pnlPct: number | undefined, venue: boolean, receipt?: unknown): Promise<void> {
  if (!relations?.length || !connId || !id || !Number.isSafeInteger(closedAt) || closedAt <= 0 || !Number.isFinite(pnlPct)) return
  const client = getRedisClient()
  let stamps: RelateTrialStamps | undefined
  try { stamps = typeof receipt === "string" ? JSON.parse(receipt) : receipt as RelateTrialStamps | undefined } catch {}
  const keys = [...new Set(relations)].map(relation => {
    const trial = stamps?.[relation]
    const known = trial && Number.isInteger(trial.step) && trial.step > 0 && trial.step <= 15 &&
      Number.isFinite(trial.size) && trial.size >= 1 && trial.size <= 8
    return [relationKey(connId, relation, venue),
      JSON.stringify(known ? [id, pnlPct, closedAt, trial.step, trial.size] : [id, pnlPct])] as const
  })
  if (typeof client.eval === "function") {
    try {
      await client.eval(RECORD_RELATE, { keys: keys.map(([key]) => key),
        arguments: [id, String(closedAt), ...keys.map(([, member]) => member)] })
      return
    } catch {
      // The memory adapter uses deterministic sorted-set members.
    }
  }
  const batch = client.multi()
  for (const [key, member] of keys) {
    batch.zadd(key, closedAt, member)
    batch.zremrangebyrank(key, 0, -LIMIT - 1)
    batch.expire(key, TTL_SECONDS)
  }
  await batch.exec()
}

export async function getRelateCloseWindows(connId: string, relations: readonly string[], lastN: number,
  before: number, venue: boolean): Promise<Map<string, RelateCloseWindow>> {
  const result = new Map<string, RelateCloseWindow>()
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
      if (!Array.isArray(rows) || !rows.length) return
      const trials: RelateTrial[] = []
      const recent = rows.slice(-lastN).reverse().map(row => {
        try {
          const [, value, at, step, size] = JSON.parse(String(row))
          if (Number.isSafeInteger(at) && at > 0 && at < before && Number.isInteger(step) && step > 0 && step <= 15 &&
              Number.isFinite(size) && size >= 1 && size <= 8)
            trials.push([at, step, Number.isFinite(value) ? value : null, size])
          return Number.isFinite(value) ? value as number : undefined
        } catch {
          return undefined
        }
      })
      result.set(key, { recent, trials })
    })
  }
  return result
}

export async function getRelateLevels(connId: string, relations: readonly string[], policy: RelateSettings,
  before: number, venue: boolean): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>()
  for (const [key, window] of await getRelateCloseWindows(connId, relations, policy.lastN, before, venue))
    if (window.recent.length >= policy.minTrades) result.set(key, relateLossLevel(window.recent, policy))
  return result
}

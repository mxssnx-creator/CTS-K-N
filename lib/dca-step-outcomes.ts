import { advanceBlockCountLifecycle, type BlockCountLifecycle } from "./block-count-lifecycle"
import { DCA_INCREMENT_STEPS_DEFAULT, normalizeDcaIncrementSteps } from "./dca-strategy"

/**
 * Per-step DCA recovery, the exact mirror of the per-count Block recovery.
 *
 * Every DCA step recovers independently: while a step keeps settling
 * non-positive its level rises (bounded by the configured 1..6 range) and the
 * raised level is HELD for that step; a positive result on that step resets it
 * to level 1. The level of step N is never derived from step N-1.
 *
 * The state is persisted per connection, keyed by symbol, source Set and step,
 * so an escalated level survives the position that produced it and applies to
 * the next position opened for that same step.
 */
const COMMIT_DCA_OUTCOME = `
  if redis.call('EXISTS', KEYS[2]) == 1 then return 2 end
  local version = redis.call('HGET', KEYS[1], '__version') or '0'
  if version ~= ARGV[1] then return 0 end
  local changes = cjson.decode(ARGV[2])
  for field, value in pairs(changes) do
    if value == false then redis.call('HDEL', KEYS[1], field)
    else redis.call('HSET', KEYS[1], field, value) end
  end
  redis.call('HSET', KEYS[1], '__version', tonumber(version) + 1)
  redis.call('PERSIST', KEYS[1])
  redis.call('SET', KEYS[2], ARGV[3], 'EX', 2592000)
  return 1
`

function symbolKey(value: unknown): string {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "")
}

function parseState(value: unknown): Partial<BlockCountLifecycle> | undefined {
  try { return JSON.parse(String(value)) } catch { return undefined }
}

/** Source Set identity of a DCA leg: the parent Set without its step suffix. */
export function dcaLifecycleSourceKey(setKey: unknown): string {
  return String(setKey || "").split("#dca:")[0]
}

export function dcaStepStateKey(connectionId: unknown): string {
  return `dca_step_recovery:${String(connectionId || "")}`
}

export function dcaStepStateField(symbol: unknown, sourceKey: unknown, step: unknown): string {
  return `${symbolKey(symbol)}|${dcaLifecycleSourceKey(sourceKey)}|step${Math.max(1, Math.floor(Number(step) || 0))}`
}

/** Recovery level held by one step; 1 means no escalation. */
export function readDcaStepRecoveryLevel(
  stored: Record<string, string> | null | undefined,
  symbol: unknown,
  sourceKey: unknown,
  step: unknown,
): number {
  const state = parseState(stored?.[dcaStepStateField(symbol, sourceKey, step)])
  const level = Number(state?.incrementStep ?? 1)
  return Number.isFinite(level) && level >= 1 ? Math.floor(level) : 1
}

/**
 * Atomically applies one settled result to every DCA step lane it touched.
 *
 * Idempotent through the per-position processed marker, and guarded by the
 * same version CAS the Block recorder uses, so a concurrent writer can never
 * lose an escalation.
 */
export async function updateDcaStepLifecycleForClose(
  redis: any,
  position: Record<string, any>,
): Promise<void> {
  const connectionId = String(position.connectionId || position.connection_id || "")
  const positionId = String(position.id || "")
  const symbol = symbolKey(position.symbol)
  const direction = String(position.direction || position.side || "").toLowerCase()
  const pnl = Number(position.realizedPnL)
  if (!connectionId || !positionId || !symbol || !["long", "short"].includes(direction)) return
  if (position.status !== "closed" || position.realizedPnlComplete === false
    || position.realizedPnL == null || !Number.isFinite(pnl)) return

  const legs = Array.isArray(position.dcaLegs) ? position.dcaLegs : []
  if (legs.length === 0) return

  const key = dcaStepStateKey(connectionId)
  const processed = `dca_step_recovery_processed:${connectionId}:${positionId}`
  const incrementSteps = normalizeDcaIncrementSteps(
    position.dcaIncrementSteps ?? position.dcaProfile?.incrementSteps,
    DCA_INCREMENT_STEPS_DEFAULT,
  )

  for (let attempt = 0; attempt < 32; attempt++) {
    if (await redis.get(processed)) return
    const stored = await redis.hgetall(key) as Record<string, string>
    const changes: Record<string, string | false> = {}
    const now = Date.now()

    for (const leg of legs) {
      const step = Math.floor(Number(leg?.step) || 0)
      if (!(step > 0)) continue
      const quantity = Number(leg?.quantity || 0)
      // A step that never filled did not settle, so it must not move a level.
      if (!(quantity > 0)) continue
      const sourceKey = dcaLifecycleSourceKey(leg?.lifecycleKey || leg?.setKey || position.setKey)
      if (!sourceKey) continue
      const field = dcaStepStateField(symbol, sourceKey, step)

      // Exact per-leg result where the leg carries its own entry, otherwise the
      // settled position result. Fees are shared pro rata by executed size.
      const entry = Number(leg?.entryPrice || 0)
      const close = Number(position.closePrice || 0)
      const total = Number(position.totalExecutedQuantity || position.quantity || 0)
      const exactLegPnl = entry > 0 && close > 0 && total > 0
        ? (direction === "long" ? close - entry : entry - close) * quantity
          - Math.max(0, Number(position.tradingFees || 0)) * quantity / total
        : pnl

      changes[field] = JSON.stringify(advanceBlockCountLifecycle(parseState(stored?.[field]), {
        setKey: `${sourceKey}#dca:${step}`,
        symbol,
        direction,
        sourceKey,
        // The step number is this lane's independent count identity.
        blockCount: step,
        incrementSteps,
        executedIncrementStep: Math.max(1, Math.floor(Number(leg?.recoveryLevel ?? leg?.incrementStep ?? 1))),
        pauseCount: Math.max(1, step),
        netPnl: exactLegPnl,
        updatedAt: now,
      }))
    }

    if (Object.keys(changes).length === 0) return

    if (typeof redis.eval === "function") {
      const committed = Number(await redis.eval(COMMIT_DCA_OUTCOME, {
        keys: [key, processed],
        arguments: [String(stored?.__version || "0"), JSON.stringify(changes), String(now)],
      }))
      if (committed === 1 || committed === 2) return
      continue
    }

    // Inline Redis callers are serialized by the connection queue in the
    // public wrapper. Network Redis always uses the atomic CAS above.
    for (const [field, value] of Object.entries(changes)) {
      if (value === false) await redis.hdel(key, field)
      else await redis.hset(key, field, value)
    }
    await redis.hset(key, "__version", String(Number(stored?.__version || 0) + 1))
    await redis.set(processed, String(now))
    await redis.expire(processed, 30 * 24 * 60 * 60)
    await redis.persist(key)
    return
  }

  throw new Error("DCA step outcome changed concurrently; settled result must be retried")
}

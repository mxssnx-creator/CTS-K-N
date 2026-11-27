import {
  AUTO_HOLD_EVIDENCE_TTL_MS, HOLD_MINUTE_MS, chooseAutomaticHoldMs, normalizeHoldTimeByRange,
  normalizePositionHoldMs, positionHoldCapMs, positionHoldExpiry, positionTimestampMs, type HoldTimeTrial,
} from "@/lib/position-hold-time"
import { autoHoldCheckpoint, completeAutoHoldTrial, getAutomaticHoldMs, holdEvidenceKey, queueAutoHoldTrial } from "@/lib/auto-hold-time"
import { getRedisClient, initRedis } from "@/lib/redis-db"

const start = Date.UTC(2026, 10, 27, 9)
const minutes = (value: number) => value * HOLD_MINUTE_MS

function profitableTrials(now: number): HoldTimeTrial[] {
  return Array.from({ length: 24 }, (_, i) => ({
    closedAt: now - minutes(30 - i),
    baselineNetPct: i % 2 === 0 ? 0.14 : -0.65,
    timedNetPct: { 5: 0.07, 15: i % 2 === 0 ? 0.55 : -0.12, 30: i % 2 === 0 ? 0.91 : -0.19 },
  }))
}

test("explicit zero, an empty environment default and scoped limits use one effective timer", () => {
  expect(normalizePositionHoldMs(" ")).toBe(minutes(240))
  expect(normalizePositionHoldMs("0")).toBe(0)
  const positionHoldByRange = normalizeHoldTimeByRange('{"micro":"15","wide":480,"unknown":2,"short":-1}')
  expect(positionHoldByRange).toEqual({ micro: 15, wide: 480 })
  const settings = { maxPositionHoldMs: minutes(240), positionHoldByRange, autoHoldTimeEnabled: true }
  expect(positionHoldCapMs(settings, "micro")).toBe(minutes(15))
  expect(positionHoldCapMs(settings, "wide")).toBe(minutes(240))
  expect(positionHoldCapMs({ ...settings, maxPositionHoldMs: 0 }, "micro")).toBe(0)
  expect(positionTimestampMs(new Date(start).toISOString())).toBe(start)
  expect(positionTimestampMs(String(start / 1000))).toBe(start)

  const held = { openedAt: start, now: start + minutes(15), committedCapMs: "900000" }
  expect(positionHoldExpiry({ ...held, currentCapMs: minutes(480) })).toEqual({ heldMs: minutes(15), maxHoldMs: minutes(15) })
  expect(positionHoldExpiry({ ...held, currentCapMs: minutes(5) })?.maxHoldMs).toBe(minutes(5))
  expect(positionHoldExpiry({ ...held, currentCapMs: 0 })).toBeNull()
  expect(positionHoldExpiry({ ...held, currentCapMs: minutes(15), openedAt: 0 })).toBeNull()
})

test("paired outcomes must beat the baseline with profit after stress in both halves", () => {
  expect(chooseAutomaticHoldMs(profitableTrials(start), minutes(120), start)).toBe(minutes(15))
  const oneSide = profitableTrials(start)
  for (const trial of oneSide.slice(12)) trial.timedNetPct = { 5: 0.08, 15: 0.09, 30: 0.10 }
  expect(chooseAutomaticHoldMs(oneSide, minutes(120), start)).toBeUndefined()
  expect(chooseAutomaticHoldMs(profitableTrials(start).slice(1), minutes(120), start)).toBeUndefined()
  expect(chooseAutomaticHoldMs(profitableTrials(start), minutes(15), start)).toBeUndefined()
  expect(chooseAutomaticHoldMs(profitableTrials(start), minutes(120), start + AUTO_HOLD_EVIDENCE_TTL_MS)).toBeUndefined()
})

test("snapshots only observed prices near the checkpoint and leaves missing arms unmeasured", () => {
  const position = { opened_at: String(start), entry_price: "100", side: "short", hold_limit_ms: String(minutes(60)),
    auto_hold_key: "example", auto_hold_next_at: String(start + minutes(5)) }
  expect(autoHoldCheckpoint(position, 99.7, start + minutes(4), start + minutes(5))).toBeUndefined()
  const marked = autoHoldCheckpoint(position, 99.7, start + minutes(5), start + minutes(5))!
  expect(marked.auto_hold_next_at).toBe(String(start + minutes(15)))
  const next = { ...position, ...marked }
  expect(autoHoldCheckpoint(next, 99, start + minutes(16) + 1, start + minutes(16) + 1)).toEqual({ auto_hold_next_at: String(start + minutes(30)) })
  const terminal = start + minutes(20)
  const result = completeAutoHoldTrial(next, "take_profit", terminal, 0.6, 0.45, terminal)!
  expect(result.timedNetPct[5]).toBeCloseTo(0.15)
  expect(result.timedNetPct[15]).toBeUndefined()
  expect(result.timedNetPct[30]).toBe(0.45)
  expect(completeAutoHoldTrial(next, "max_hold_time_exceeded", terminal, 0.6, 0.45, terminal)).toBeUndefined()
  expect(completeAutoHoldTrial(next, "take_profit", terminal, 0.6, 0.45, terminal - minutes(2))).toBeUndefined()
})

test("bounded persisted evidence is eligible only for the matching Set, cost, bracket and cap", async () => {
  await initRedis()
  const now = Date.now()
  const scope = { connectionId: `auto-hold-test-${now}`, setKey: "BTC#long#row_live", symbol: "BTCUSDT", direction: "long",
    takeProfitPct: 0.9, stopLossPct: 0.6, positionCostPct: 0.1, capMs: minutes(120) }
  const key = holdEvidenceKey(scope)!
  const client = getRedisClient()
  const pipeline = client.multi()
  for (const trial of profitableTrials(now).concat(profitableTrials(now))) queueAutoHoldTrial(pipeline, key, trial)
  await pipeline.exec()
  try {
    expect(await client.llen(key)).toBe(24)
    expect(await getAutomaticHoldMs(key, scope.capMs)).toBe(minutes(15))
    for (const changes of [{ setKey: "BTC#short#row_live" }, { stopLossPct: 0.61 }, { positionCostPct: 0.11 }, { capMs: minutes(240) }]) {
      expect(await getAutomaticHoldMs(holdEvidenceKey({ ...scope, ...changes })!, scope.capMs)).toBeUndefined()
    }
  } finally {
    await client.del(key)
    await client.close?.()
  }
})

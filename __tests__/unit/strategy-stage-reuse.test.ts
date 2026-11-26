import { getRedisClient, initRedis } from "@/lib/redis-db"
import { buildStrategyIndicationFingerprint, getStrategyCoordinator, StrategyCoordinator } from "@/lib/strategy-coordinator"
import { clearFlowThrottleForConnection, StrategyProcessor } from "@/lib/trade-engine/strategy-processor"

const symbol = "BTCUSDT"
const indications = [{ setKey: "direction:long:1", validated: true }]

function stageResult(type: string) {
  return { type, symbol, totalCreated: 1, passedEvaluation: 1, failedEvaluation: 0, avgProfitFactor: 1.5, avgDrawdownTime: 2 }
}

function stubStages(connectionId: string) {
  const coordinator = new StrategyCoordinator(connectionId) as any
  for (const method of ["memoryCircuitBreaker", "loadAppPFThresholds", "loadCoordinationSettings", "loadHedgeAccumulationParams", "loadStageThresholds", "logStrategyProgression"]) {
    jest.spyOn(coordinator, method).mockResolvedValue(undefined)
  }
  const set = { setKey: "direction:long:1" }
  const base = jest.spyOn(coordinator, "createBaseSets").mockImplementation(async () => ({
    result: stageResult("base"), sets: [set], coordIndex: {
      base: { byKey: new Map(), orderedKeys: [] }, records: [], byCoordKey: new Map(), byParentKey: new Map(),
      liveSetsByVariant: new Map(), validRealKeys: new Set(), rowEvaluationKeyBySource: new Map(),
    },
  }))
  jest.spyOn(coordinator, "createMainSets").mockResolvedValue({ result: stageResult("main"), sets: [set] })
  jest.spyOn(coordinator, "evaluateRealSets").mockResolvedValue({ result: stageResult("real"), sets: [set] })
  const live = jest.spyOn(coordinator, "createLiveSets").mockResolvedValue({ result: stageResult("live"), sets: [set] })
  return { coordinator, base, live }
}

afterEach(() => jest.restoreAllMocks())
afterAll(async () => { await getRedisClient().close?.() })

test("a completed compact snapshot reuses only Base/Main/Real and advances after ledger changes", async () => {
  jest.replaceProperty(process, "env", { ...process.env, STRATEGY_LIVE_FASTPATH_MAX_ROWS: "1" })
  const { coordinator, base, live } = stubStages("compact-stage-reuse")
  const context = { ...coordinator.neutralPositionContext(), strategyLedgerRevision: "1:0:0" }
  const run = (positionContext = context) => coordinator.executeStrategyFlow(symbol, indications, false, positionContext)

  expect(await run()).toHaveLength(4)
  expect(await run()).toHaveLength(1)
  expect(base).toHaveBeenCalledTimes(1)
  expect(live.mock.calls[1][5]).toBe(1)
  expect(await run({ ...context, strategyLedgerRevision: "1:1:0" })).toHaveLength(4)
  expect(base).toHaveBeenCalledTimes(2)

  coordinator.invalidateSettingsCaches()
  expect(await run({ ...context, strategyLedgerRevision: "1:1:0" })).toHaveLength(4)
  expect(base).toHaveBeenCalledTimes(3)
})

test("oversized and failed Live snapshots retry the full stage flow on unchanged inputs", async () => {
  jest.replaceProperty(process, "env", { ...process.env, STRATEGY_LIVE_FASTPATH_MAX_ROWS: "0" })
  const { coordinator, base, live } = stubStages("overflow-stage-reuse")
  const context = coordinator.neutralPositionContext()
  const run = () => coordinator.executeStrategyFlow(symbol, indications, false, context)
  live.mockRejectedValueOnce(new Error("simulated Live stage interruption"))
  jest.spyOn(console, "error").mockImplementation(() => {})
  await expect(run()).rejects.toThrow("simulated Live stage interruption")
  expect(await run()).toHaveLength(4)
  expect(await run()).toHaveLength(4)
  expect(base).toHaveBeenCalledTimes(3)
  expect(live).toHaveBeenCalledTimes(3)
})

test("pending position-context reads are shared and an invalidated read cannot overwrite a fresh one", async () => {
  const coordinator = new StrategyCoordinator("shared-position-context") as any
  const original = coordinator.neutralPositionContext()
  const fresh = { ...original, lastWins: 2 }
  let finishOriginal!: (context: typeof original) => void
  const read = jest.spyOn(coordinator, "readPositionContext")
    .mockImplementationOnce(() => new Promise((resolve) => { finishOriginal = resolve }))
    .mockResolvedValueOnce(fresh)
  const first = coordinator.getPositionContext()
  expect(coordinator.getPositionContext()).toBe(first)
  coordinator.invalidateSettingsCaches()
  await expect(coordinator.getPositionContext()).resolves.toBe(fresh)
  finishOriginal(original)
  await expect(first).resolves.toBe(original)
  await expect(coordinator.getPositionContext()).resolves.toBe(fresh)
  expect(read).toHaveBeenCalledTimes(2)
})

test("the projected position window preserves legacy fields, timestamp order and latest eight closes", async () => {
  const connectionId = "projected-position-context"
  const coordinator = new StrategyCoordinator(connectionId) as any
  jest.spyOn(coordinator, "isLiveTradingEnabledForConnection").mockResolvedValue(false)
  await initRedis()
  const client = getRedisClient()
  const now = Date.now()
  const index = `pseudo_positions:${connectionId}:closed_time_index`
  for (let offset = 0; offset < 12; offset++) {
    const id = String(offset)
    const closedAt = now - offset * 1000
    await client.zadd(index, closedAt, id)
    await client.hset(`pseudo_position:${connectionId}:${id}`, offset % 2 === 0
      ? { status: "CLOSED", closedAt: new Date(closedAt).toISOString(), profit: "-1" }
      : { status: "closed", closed_at: String(closedAt), realized_pnl: "2", pnl: "-1" })
  }
  await client.zadd(index, now, "invalid")
  await client.hset(`pseudo_position:${connectionId}:invalid`, { status: "open", closed_at: String(now), pnl: "5" })
  expect(await client.zrangebyscore(index, now - 60_000, "+inf")).toHaveLength(13)

  await expect(coordinator.getPositionContext()).resolves.toMatchObject({
    prevPosCount: 12, prevLosses: 6, lastPosCount: 8, lastWins: 4, lastLosses: 4,
  })
})

test("in-flight and hard-throttled passes skip the indication read and reuse the validated fingerprint", async () => {
  const connectionId = "strategy-stage-admission"
  const processor = new StrategyProcessor(connectionId)
  const read = jest.spyOn(processor as any, "getActiveIndications").mockResolvedValue(indications)
  let start!: () => void
  let finish!: () => void
  const started = new Promise<void>((resolve) => { start = resolve })
  const pending = new Promise<void>((resolve) => { finish = resolve })
  const execute = jest.spyOn(getStrategyCoordinator(connectionId), "executeStrategyFlow")
    .mockImplementationOnce(async () => { start(); await pending; return [] })
    .mockResolvedValue([])
  const clock = jest.spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
  const first = processor.processStrategy(symbol)
  try {
    await started
    await processor.processStrategy(symbol)
    expect(read).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][6]).toBe(buildStrategyIndicationFingerprint(indications))
    finish()
    await first
    await processor.processStrategy(symbol)
    expect(read).toHaveBeenCalledTimes(1)
    clock.mockReturnValue(1_800_060_000_000)
    await processor.processStrategy(symbol)
    expect(read).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledTimes(2)
  } finally {
    finish()
    await first
    clearFlowThrottleForConnection(connectionId)
  }
})

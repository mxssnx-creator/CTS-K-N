import { getRedisClient, initRedis } from "@/lib/redis-db"
import { stageBlockPolicies, stageLastNAncestors, stageLastNChoices } from "@/lib/disjoint-last-n"
import { prepareStageLastNTape, selectStageLastNWindow, stageLastNLaneKey } from "@/lib/stage-last-n-lineage"
import { getStrategySetLedgerBatch, recordStrategySetCloseOutcome, strategyOutcomeRecord } from "@/lib/pos-history"
import { StrategyCoordinator } from "@/lib/strategy-coordinator"

const positive = { long: 4, short: 2, minimal: 1, shortPolarity: "positive", minimalPolarity: "positive" } as const
const shortNegative = { ...positive, shortPolarity: "negative" } as const
const lastNegative = { ...positive, minimalPolarity: "negative" } as const
const metrics = { minProfitFactor: 1.1, maxDrawdownTime: 60, maxDrawdownRatio: 0 }

const outcome = (pnlPct: number) => ({ pnl: pnlPct, pnlPct, positionCostPct: 0.1, drawdownMinutes: 6 })
const tape = (moves: number[]) => prepareStageLastNTape(moves.map(move => strategyOutcomeRecord(outcome(move))!))

afterAll(async () => { await getRedisClient().close?.() })

test("normalizes the whole signed Cartesian grid and inherits each configured Base Long count", () => {
  const base = { ...positive, grid: { long: [10, 20, 10], short: [4, 8], minimal: [1, 2],
    shortPolarity: ["positive", "negative"], minimalPolarity: ["positive", "negative"] } }
  const policies = stageBlockPolicies(JSON.stringify({ base, real: { ...base, longMode: "both" } }))
  expect(stageLastNChoices(policies, "base")).toHaveLength(32)
  expect(stageLastNChoices(policies, "main")).toHaveLength(32)
  expect(stageLastNChoices(policies, "real")).toHaveLength(48)
  expect(stageLastNChoices(policies, "live")).toHaveLength(48)
  expect(() => stageBlockPolicies({ real: { ...positive, longMode: "inherit" } })).toThrow("Configure Base Long")
  expect(() => stageBlockPolicies({ live: { ...base, longMode: "none", grid: { ...base.grid, short: [0], minimal: [0] } } }))
    .toThrow("A stage without Long needs Short or Last")
  expect(() => stageBlockPolicies({ real: { ...base, grid: { ...base.grid, long: [500], short: [100] } } }))
    .toThrow("exceeds the retained outcome history")
})

test("each signed decision takes its own blocks and only older samples calibrate Auto PF", () => {
  const exact = tape([1, -0.4, -0.4, 1, 1, 1, 1, ...Array.from({ length: 24 }, (_, i) => i % 2 ? -0.1 : 1)])
  expect(exact(positive).state).toBe("failed")
  expect(exact(shortNegative)).toMatchObject({ state: "qualified", stats: { count: 7 } })
  expect(exact({ ...shortNegative, autoPfRatio: 4 }).stats?.blockDecision?.minPf).toBeCloseTo(1.200001)
  expect(exact(lastNegative).state).toBe("failed")
  const opposite = tape([-0.2, 0.5, 0.5, 1, 1, 1, 1])
  expect(opposite(lastNegative).state).toBe("qualified")
  expect(opposite(positive).state).toBe("failed")
})

test("an insufficient exact lane can bootstrap from its parent while mature failures are final", () => {
  const maps = new Map([["parent", tape([1, 1, 1, 1, 1, 1, 1])], ["thin", tape([1])], ["failed", tape(Array(7).fill(-1))],
    ["unsettled", prepareStageLastNTape(["0|0|0||"])]] as const)
  expect(selectStageLastNWindow(["thin", "parent"], maps, positive, metrics)).toMatchObject({ historySetKey: "parent" })
  expect(selectStageLastNWindow(["failed", "parent"], maps, positive, metrics)).toBeUndefined()
  expect(selectStageLastNWindow(["unsettled", "parent"], maps, positive, metrics)).toBeUndefined()
  expect(selectStageLastNWindow(["missing"], maps, positive, metrics)).toBeUndefined()
  expect(selectStageLastNWindow(["parent"], maps, positive, { ...metrics, maxDrawdownTime: 1 })).toBeUndefined()
})

test("a settled signed child updates only its own ancestor path exactly once", async () => {
  await initRedis()
  const id = "last-n-position-attribution"
  const root = "BTCUSDT:direction:long:cfg:exact"
  const base = stageLastNLaneKey(root, "base", positive)
  const main = stageLastNLaneKey(`${base}#default`, "main", positive)
  const real = stageLastNLaneKey(main, "real", positive)
  const live = stageLastNLaneKey(`${real}#row_live`, "live", positive)
  const sibling = stageLastNLaneKey(`${real}#row_live`, "live", shortNegative)
  expect(stageLastNAncestors(live)).toEqual([base, main, real, live])
  await Promise.all([1, 2].map(() => recordStrategySetCloseOutcome(id, "fill-1", [live], outcome(0.5))))
  expect((await getStrategySetLedgerBatch(id, [root, base, main, real, live, sibling])).closed).toEqual({
    [base]: 1, [main]: 1, [real]: 1, [live]: 1,
  })
})

test("native progression creates a new child for every eligible policy at each stage", async () => {
  await initRedis()
  const id = "last-n-native-progression"
  const coordinator = new StrategyCoordinator(id) as any
  const symbol = "BTCUSDT"
  const root = `${symbol}:direction:long:cfg:${encodeURIComponent("the-exact-configuration")}`
  const indication = [{ setKey: "the-exact-configuration", type: "direction", direction: "long", confidence: 0.9, profitFactor: 2, validated: true }]
  const policy = (long: number[]) => ({ ...positive, grid: {
    long, short: [2], minimal: [1], shortPolarity: ["positive"], minimalPolarity: ["positive"],
  } })
  await getRedisClient().hset(`connection_settings:${id}`, {
    lastNBlocks: JSON.stringify({ base: policy([4, 5, 80]), main: policy([4, 5]), real: policy([4, 5]), live: policy([4, 5]) }),
    axisEnabled: "false", variantBlockEnabled: "false", variantDcaEnabled: "false", blockRowLiveEnabled: "false",
  })
  jest.spyOn(coordinator, "isLiveTradingEnabledForConnection").mockResolvedValue(false)
  jest.spyOn(coordinator, "getEnabledTrailingVariants").mockResolvedValue([])
  const mainSpy = jest.spyOn(coordinator, "createMainSets")
  const realSpy = jest.spyOn(coordinator, "evaluateRealSets")
  const liveSpy = jest.spyOn(coordinator, "createLiveSets")
  for (let i = 0; i < 14; i++) {
    await recordStrategySetCloseOutcome(id, `prehistory-${i}`, [root], outcome(0.6 + i * 0.01))
  }

  const results = await coordinator.executeStrategyFlow(symbol, indication, false, coordinator.neutralPositionContext(), true)
  expect(results.map(row => row.type)).toEqual(["base", "main", "real", "live"])
  expect(results[0].passedEvaluation).toBe(2)
  expect(results[0].rawEvaluated).toBe(3)
  const main = await mainSpy.mock.results[0].value as { sets: import("@/lib/strategy-coordinator").StrategySet[] }
  const real = await realSpy.mock.results[0].value as typeof main
  const live = await liveSpy.mock.results[0].value as typeof main
  expect(main.sets.length).toBeGreaterThanOrEqual(4)
  expect(real.sets).toHaveLength(2 * main.sets.length)
  expect(live.sets).toHaveLength(2 * real.sets.length)
  for (const [parents, children] of [[main, real], [real, live]]) {
    expect(new Set(children.sets.map(row => row.setKey)).size).toBe(children.sets.length)
    const parentKeys = new Set(parents.sets.map(row => row.setKey))
    const childrenPerParent = new Map<string, number>()
    for (const row of children.sets) {
      const key = row.lastNLane!.parentSetKey
      expect(parentKeys.has(key)).toBe(true)
      childrenPerParent.set(key, (childrenPerParent.get(key) ?? 0) + 1)
    }
    expect([...childrenPerParent.values()]).toEqual(Array(parentKeys.size).fill(2))
  }
  expect(coordinator._lastRealSets[symbol].every(row => row.lastNLane.stage === "real")).toBe(true)

  const held = { ...real.sets[0], rowEntryQualified: false, _hasLivePositions: true }
  const heldOnly = await coordinator.createLiveSets(symbol, [held], undefined, true)
  expect(heldOnly.sets).toHaveLength(0)

  const rejectedPath = live.sets[0]
  for (let i = 0; i < 8; i++) await recordStrategySetCloseOutcome(id, `unprofitable-${i}`, [rejectedPath.setKey], outcome(-1))
  const reevaluated = await coordinator.createLiveSets(symbol, real.sets, undefined, true) as typeof main
  expect(reevaluated.sets.some(row => row.setKey === rejectedPath.setKey)).toBe(false)
  const sibling = live.sets.find(row => row.lastNLane?.parentSetKey !== rejectedPath.lastNLane?.parentSetKey)!
  expect(reevaluated.sets.some(row => row.setKey === sibling.setKey)).toBe(true)
})

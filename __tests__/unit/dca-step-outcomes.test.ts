import { InlineLocalRedis } from "@/lib/redis-db"
import {
  dcaStepStateField,
  dcaStepStateKey,
  readDcaStepRecoveryLevel,
  updateDcaStepLifecycleForClose,
} from "@/lib/dca-step-outcomes"

let CONN = "bingx-x02"
let seq = 0
beforeEach(() => { CONN = `bingx-x02-dca-${++seq}` })
const SOURCE = "BTCUSDT:direction:long"

function closedPosition(over: Record<string, any> = {}) {
  return {
    id: `pos-${Math.random().toString(36).slice(2)}`,
    connectionId: CONN,
    symbol: "BTCUSDT",
    direction: "long",
    status: "closed",
    realizedPnL: -5,
    realizedPnlComplete: true,
    closePrice: 90,
    quantity: 3,
    totalExecutedQuantity: 3,
    setKey: SOURCE,
    dcaIncrementSteps: 6,
    dcaLegs: [{ step: 1, quantity: 1, entryPrice: 100 }],
    ...over,
  }
}

async function levelOf(redis: any, step: number) {
  return readDcaStepRecoveryLevel(await redis.hgetall(dcaStepStateKey(CONN)), "BTCUSDT", SOURCE, step)
}

describe("per-step DCA recovery lifecycle", () => {
  test("a losing step escalates only after its own step count and then holds the level", async () => {
    const redis = new InlineLocalRedis()
    expect(await levelOf(redis, 1)).toBe(1)
    // Step 1 escalates after every single non-positive settlement.
    await updateDcaStepLifecycleForClose(redis, closedPosition())
    expect(await levelOf(redis, 1)).toBe(2)
    await updateDcaStepLifecycleForClose(redis, closedPosition())
    expect(await levelOf(redis, 1)).toBe(3)
  })

  test("a positive settlement on that step resets it to level 1", async () => {
    const redis = new InlineLocalRedis()
    await updateDcaStepLifecycleForClose(redis, closedPosition())
    await updateDcaStepLifecycleForClose(redis, closedPosition())
    expect(await levelOf(redis, 1)).toBe(3)
    await updateDcaStepLifecycleForClose(redis, closedPosition({ realizedPnL: 12, closePrice: 130 }))
    expect(await levelOf(redis, 1)).toBe(1)
  })

  test("steps are independent — one step's escalation never moves another", async () => {
    const redis = new InlineLocalRedis()
    await updateDcaStepLifecycleForClose(redis, closedPosition({
      dcaLegs: [{ step: 2, quantity: 1, entryPrice: 100 }],
    }))
    expect(await levelOf(redis, 2)).toBe(1) // step 2 needs 2 non-positive settlements
    await updateDcaStepLifecycleForClose(redis, closedPosition({
      dcaLegs: [{ step: 2, quantity: 1, entryPrice: 100 }],
    }))
    expect(await levelOf(redis, 2)).toBe(2)
    expect(await levelOf(redis, 1)).toBe(1)
    expect(await levelOf(redis, 3)).toBe(1)
  })

  test("the same settled position is applied exactly once", async () => {
    const redis = new InlineLocalRedis()
    const position = closedPosition()
    await updateDcaStepLifecycleForClose(redis, position)
    await updateDcaStepLifecycleForClose(redis, position)
    await updateDcaStepLifecycleForClose(redis, position)
    expect(await levelOf(redis, 1)).toBe(2)
  })

  test("unsettled, unfilled or foreign rows never move a level", async () => {
    const redis = new InlineLocalRedis()
    for (const over of [
      { status: "open" },
      { realizedPnlComplete: false },
      { realizedPnL: null },
      { dcaLegs: [] },
      { dcaLegs: [{ step: 1, quantity: 0, entryPrice: 100 }] },
      { dcaLegs: [{ step: 0, quantity: 1, entryPrice: 100 }] },
      { direction: "" },
    ]) {
      await updateDcaStepLifecycleForClose(redis, closedPosition(over as Record<string, any>))
    }
    expect(await levelOf(redis, 1)).toBe(1)
  })

  test("levels are bounded by the configured range and keyed per symbol/source/step", async () => {
    const redis = new InlineLocalRedis()
    for (let i = 0; i < 20; i++) await updateDcaStepLifecycleForClose(redis, closedPosition({ dcaIncrementSteps: 3 }))
    expect(await levelOf(redis, 1)).toBe(3)
    expect(dcaStepStateField("btcusdt", `${SOURCE}#dca:2`, 2)).toBe(`BTCUSDT|${SOURCE}|step2`)
  })
})

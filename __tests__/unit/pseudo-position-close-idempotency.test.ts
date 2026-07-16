import { getRedisClient } from "@/lib/redis-db"
import { getValidPositions } from "@/lib/pos-history"
import { PseudoPositionManager } from "@/lib/trade-engine/pseudo-position-manager"

describe("PseudoPositionManager close idempotency", () => {
  const connectionId = `pseudo-close-${Date.now()}`
  const positionId = "position-1"
  const positionKey = `pseudo_position:${connectionId}:${positionId}`
  const openIndex = `pseudo_positions:${connectionId}`
  const closedIndex = `${openIndex}:closed_index`
  const parentSetKey = "BTCUSDT:direction:long"
  const strategySetKey = `${parentSetKey}#axis:p4_l1_c1_opos_dlong_u1`

  beforeAll(async () => {
    const client = getRedisClient()
    await client.hset(positionKey, {
      id: positionId,
      connection_id: connectionId,
      symbol: "BTCUSDT",
      indication_type: "direction",
      side: "long",
      entry_price: "100",
      current_price: "101",
      quantity: "1",
      max_drawdown: "0",
      status: "open",
      opened_at: new Date(Date.now() - 60_000).toISOString(),
      config_set_key: "",
      strategy_set_key: strategySetKey,
      parent_set_key: parentSetKey,
    })
    await client.sadd(openIndex, positionId)
    await client.sadd(`${openIndex}:active_by_direction:long`, positionId)
    await client.sadd(`${openIndex}:active_strategy_set_keys`, strategySetKey, parentSetKey)
  })

  afterAll(async () => {
    const client = getRedisClient()
    const patternKeys = await client.keys(`*${connectionId}*`)
    if (patternKeys.length > 0) await client.del(...patternKeys)
  })

  test("concurrent close attempts write one closed/history entry", async () => {
    const manager = new PseudoPositionManager(connectionId)
    await Promise.all([
      manager.closePosition(positionId, "test_close"),
      manager.closePosition(positionId, "test_close"),
      manager.closePosition(positionId, "test_close"),
    ])

    const client = getRedisClient()
    expect(await client.lrange(closedIndex, 0, -1)).toEqual([positionId])
    expect((await client.hgetall(positionKey)).status).toBe("closed")
    expect(await client.hget(`pi_history:${connectionId}:_overall:_overall:_overall`, "count")).toBe("1")
    expect(await client.scard(`${openIndex}:active_strategy_set_keys`)).toBe(0)
    expect(await client.hget(`strategy_set_entry_counts:${connectionId}`, strategySetKey)).toBe("1")
    expect(await client.hget(`strategy_parent_entry_counts:${connectionId}`, parentSetKey)).toBe("1")
    expect(await getValidPositions(connectionId)).toEqual({
      overall: 1,
      combined: 0,
      bySymbol: { BTCUSDT: 1 },
      byDirection: { long: 1, short: 0 },
      byType: { direction: 1 },
      byVariant: { default: 1, trailing: 0, block: 0, dca: 0 },
    })
  })
})

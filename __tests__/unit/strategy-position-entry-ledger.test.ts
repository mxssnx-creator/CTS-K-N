import { getRedisClient } from "@/lib/redis-db"
import {
  getValidPositions,
  markStrategyPositionInactive,
  recordStrategyPositionEntry,
} from "@/lib/pos-history"

describe("confirmed strategy-position entry ledger", () => {
  const connectionId = `ledger-test-${Date.now()}`
  const keys = [
    `strategy_pos_entry_ids:${connectionId}`,
    `strategy_set_entry_counts:${connectionId}`,
    `strategy_parent_entry_counts:${connectionId}`,
    `valid_positions_v2:${connectionId}`,
    `valid_positions_active_v2:${connectionId}`,
    `real_pi_acc:${connectionId}`,
    `axis_pos_acc:${connectionId}`,
    `hedge_pos_acc:${connectionId}`,
    `valid_positions:${connectionId}`,
  ]

  afterAll(async () => {
    await getRedisClient().del(...keys)
  })

  test("books one fill identity once under concurrent retries", async () => {
    const input = {
      connectionId,
      positionId: "position-1",
      entryId: "position-1:initial",
      setKey: "BTCUSDT:direction:long#axis:p4_l1_c1_opos_dlong_u1",
      parentSetKey: "BTCUSDT:direction:long",
      symbol: "BTCUSDT",
      indicationType: "direction",
      direction: "long" as const,
      axisKey: "p4_l1_c1_opos_dlong_u1",
    }

    const results = await Promise.all([
      recordStrategyPositionEntry(input),
      recordStrategyPositionEntry(input),
      recordStrategyPositionEntry(input),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)

    const snapshot = await getValidPositions(connectionId)
    expect(snapshot).toEqual({
      overall: 1,
      combined: 1,
      bySymbol: { BTCUSDT: 1 },
      byDirection: { long: 1, short: 0 },
      byType: { direction: 1 },
      byVariant: { default: 1, trailing: 0, block: 0, dca: 0 },
    })

    const client = getRedisClient()
    expect(await client.hget(`strategy_set_entry_counts:${connectionId}`, input.setKey)).toBe("1")
    expect(await client.hget(`real_pi_acc:${connectionId}`, input.parentSetKey)).toBe("1")
    expect(await client.hget(`axis_pos_acc:${connectionId}`, `${input.parentSetKey}|${input.axisKey}`)).toBe("1")
    expect(await client.hget(`valid_positions_v2:${connectionId}`, "by_variant:default")).toBe("1")
  })

  test("closing removes only active membership and preserves lifetime entries", async () => {
    await expect(markStrategyPositionInactive(connectionId, "position-1")).resolves.toBe(true)
    await expect(markStrategyPositionInactive(connectionId, "position-1")).resolves.toBe(false)

    const snapshot = await getValidPositions(connectionId)
    expect(snapshot.overall).toBe(1)
    expect(snapshot.combined).toBe(0)
  })
})

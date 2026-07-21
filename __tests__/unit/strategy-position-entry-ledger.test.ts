import { getRedisClient } from "@/lib/redis-db"
import {
  getStrategySetLedgerSnapshot,
  getStrategySetWindowBatch,
  getValidPositions,
  markStrategyPositionInactive,
  recordStrategyPositionEntry,
} from "@/lib/pos-history"

describe("confirmed strategy-position entry ledger", () => {
  const connectionId = `ledger-test-${Date.now()}`
  const keys = [
    `strategy_pos_entry_ids:${connectionId}`,
    `strategy_set_entry_counts:${connectionId}`,
    `strategy_set_active_entry_counts:${connectionId}`,
    `strategy_set_close_ids:${connectionId}`,
    `strategy_set_closed_counts:${connectionId}`,
    `strategy_set_keys:${connectionId}`,
    `strategy_active_set_keys:${connectionId}`,
    `strategy_closed_set_keys:${connectionId}`,
    `strategy_ledger_totals:${connectionId}`,
    `strategy_position_set_memberships:${connectionId}:position-1`,
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
    expect(await client.hget(`strategy_set_active_entry_counts:${connectionId}`, input.setKey)).toBe("1")
    expect(await client.smembers(`strategy_position_set_memberships:${connectionId}:position-1`)).toEqual([input.setKey])
    expect(await client.smembers(`strategy_active_set_keys:${connectionId}`)).toEqual([input.setKey])
    expect(await client.hgetall(`strategy_ledger_totals:${connectionId}`)).toMatchObject({
      exact_entries: "1",
      axis_entries: "1",
      active_memberships: "1",
    })
    expect(await client.hget(`real_pi_acc:${connectionId}`, input.parentSetKey)).toBe("1")
    expect(await client.hget(`axis_pos_acc:${connectionId}`, `${input.parentSetKey}|${input.axisKey}`)).toBe("1")
    expect(await client.hget(`valid_positions_v2:${connectionId}`, "by_variant:default")).toBe("1")
  })

  test("closing removes only active membership and preserves lifetime entries", async () => {
    await expect(markStrategyPositionInactive(connectionId, "position-1", {
      pnl: 2.5,
      drawdownMinutes: 7,
    })).resolves.toBe(true)
    await expect(markStrategyPositionInactive(connectionId, "position-1", {
      pnl: 2.5,
      drawdownMinutes: 7,
    })).resolves.toBe(false)

    const snapshot = await getValidPositions(connectionId)
    expect(snapshot.overall).toBe(1)
    expect(snapshot.combined).toBe(0)

    const setKey = "BTCUSDT:direction:long#axis:p4_l1_c1_opos_dlong_u1"
    await expect(getStrategySetLedgerSnapshot(connectionId)).resolves.toEqual({
      entries: { [setKey]: 1 },
      active: {},
      closed: { [setKey]: 1 },
    })
    const windows = await getStrategySetWindowBatch(connectionId, [setKey], 1)
    expect(windows.get(setKey)).toMatchObject({
      count: 1,
      profitFactor: 99,
      avgDDT: 7,
      recentPnls: [2.5],
    })
    expect(await getRedisClient().hgetall(`strategy_ledger_totals:${connectionId}`)).toMatchObject({
      exact_entries: "1",
      axis_entries: "1",
      active_memberships: "0",
      exact_closed: "1",
    })

    // A delayed exchange/order reconciliation retry after terminal close must
    // remain a no-op. It may not resurrect the position's active Set ownership.
    await expect(recordStrategyPositionEntry({
      connectionId,
      positionId: "position-1",
      entryId: "position-1:initial",
      setKey,
      parentSetKey: "BTCUSDT:direction:long",
      symbol: "BTCUSDT",
      indicationType: "direction",
      direction: "long",
      axisKey: "p4_l1_c1_opos_dlong_u1",
    })).resolves.toBe(false)
    await expect(getStrategySetLedgerSnapshot(connectionId)).resolves.toEqual({
      entries: { [setKey]: 1 },
      active: {},
      closed: { [setKey]: 1 },
    })
    expect(await getRedisClient().scard(`valid_positions_active_v2:${connectionId}`)).toBe(0)
  })

  test("active position and exact Set memberships have no clock and remain identical across long cycle reads", async () => {
    // This test is intentionally placed after close in source order only for
    // Jest readability; use an independent active identity so the lifecycle is
    // not coupled to the earlier terminal-position assertions.
    const activeId = "position-durable"
    const setKey = "BTCUSDT:move:long#axis:p12_l4_c8_opos_dlong_u8"
    await recordStrategyPositionEntry({
      connectionId,
      positionId: activeId,
      entryId: `${activeId}:initial`,
      setKey,
      parentSetKey: "BTCUSDT:move:long",
      symbol: "BTCUSDT",
      indicationType: "move",
      direction: "long",
      axisKey: "p12_l4_c8_opos_dlong_u8",
    })

    const activeKeys = [
      `valid_positions_active_v2:${connectionId}`,
      `strategy_position_set_memberships:${connectionId}:${activeId}`,
      `strategy_set_active_entry_counts:${connectionId}`,
      `strategy_active_set_keys:${connectionId}`,
      `strategy_ledger_totals:${connectionId}`,
    ]
    for (const key of activeKeys) expect(await getRedisClient().ttl(key)).toBe(-1)

    const snapshots = await Promise.all(Array.from({ length: 40 }, () => getStrategySetLedgerSnapshot(connectionId)))
    expect(snapshots.every((snapshot) => snapshot.active[setKey] === 1)).toBe(true)
    expect(await getRedisClient().sismember(`valid_positions_active_v2:${connectionId}`, activeId)).toBe(1)

    await expect(markStrategyPositionInactive(connectionId, activeId, { pnl: -0.5, drawdownMinutes: 12 })).resolves.toBe(true)
    expect(await getRedisClient().sismember(`valid_positions_active_v2:${connectionId}`, activeId)).toBe(0)
    await getRedisClient().del(`strategy_position_set_memberships:${connectionId}:${activeId}`)
  })
})

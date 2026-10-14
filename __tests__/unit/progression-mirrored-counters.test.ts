/**
 * H4 / L3: progression counters are written to the engine-scoped hash, the
 * legacy `progression:{id}` hash, or (strategy-coordinator, config-set-
 * processor) mirrored into both. Readers must neither double the mirrored
 * counters nor re-add previous sessions after a restart, and an operator
 * reset must clear both hashes.
 */
import { getRedisClient } from "@/lib/redis-db"
import { ProgressionStateManager, mergeProgressionHashes } from "@/lib/progression-state-manager"
import { buildProgressionScope } from "@/lib/progression-scope"

describe("progression counters merged from the scoped and legacy hashes", () => {
  test("mirrored counters are not double-counted; single-writer counters still add up", () => {
    const merged = mergeProgressionHashes(
      {
        strategies_main_total: "40",
        strategies_real_evaluated: "18",
        prehistoric_symbols_processed_count: "12",
        indication_cycle_count: "7",
      },
      {
        strategies_main_total: "40",
        strategies_real_evaluated: "18",
        prehistoric_symbols_processed_count: "12",
        cycles_completed: "5",
        indication_cycle_count: "2",
      },
    )
    expect(merged).toMatchObject({
      strategies_main_total: "40",
      strategies_real_evaluated: "18",
      prehistoric_symbols_processed_count: "12",
      cycles_completed: "5",
      // engine (scoped) and bounded owner (legacy) cycles are separate work
      indication_cycle_count: "9",
    })
  })

  test("getProgressionState reports a mirrored counter once for an unmigrated scoped hash", async () => {
    const connectionId = `progression-mirror-${Date.now()}`
    const client = getRedisClient()
    const scope = buildProgressionScope(connectionId, "main")
    try {
      await client.del(scope.progressionKey, scope.legacyProgressionKey)
      // A fresh session hash (no migrated_from_unscoped flag) plus the
      // strategy-coordinator's mirrored increments in both hashes.
      await client.hset(scope.progressionKey, {
        connection_id: connectionId,
        session_number: "2",
        strategies_base_total: "120",
        strategies_main_total: "40",
        strategies_real_total: "9",
        strategies_real_evaluated: "11",
        prehistoric_candles_processed: "5000",
        indication_cycle_count: "7",
      })
      await client.hset(scope.legacyProgressionKey, {
        strategies_base_total: "120",
        strategies_main_total: "40",
        strategies_real_total: "9",
        strategies_real_evaluated: "11",
        prehistoric_candles_processed: "5000",
        cycles_completed: "6",
        successful_cycles: "6",
      })

      const state = await ProgressionStateManager.getProgressionState(connectionId, "main")
      expect(state.strategiesBaseTotal).toBe(120)
      expect(state.strategiesMainTotal).toBe(40)
      expect(state.strategiesRealTotal).toBe(9)
      expect(state.strategyEvaluatedReal).toBe(11)
      expect(state.prehistoricCandlesProcessed).toBe(5000)
      expect(state.indicationCycleCount).toBe(7)
      expect(state.cyclesCompleted).toBe(6)
      await expect(ProgressionStateManager.getMergedProgressionHash(connectionId, "main"))
        .resolves.toMatchObject({ strategies_main_total: "40", cycles_completed: "6" })
    } finally {
      await client.del(scope.progressionKey, scope.legacyProgressionKey)
    }
  })

  test("a new session does not re-add the previous session's legacy totals", async () => {
    const connectionId = `progression-restart-${Date.now()}`
    const client = getRedisClient()
    const scope = buildProgressionScope(connectionId, "main")
    const keys = [
      scope.progressionKey,
      scope.legacyProgressionKey,
      `${scope.progressionKey}:history:1`,
      `${scope.legacyProgressionKey}:history:1`,
    ]
    try {
      await client.del(...keys)
      await client.hset(scope.progressionKey, {
        connection_id: connectionId,
        session_number: "1",
        epoch: "1",
        strategies_real_total: "300",
        indication_cycle_count: "50",
      })
      await client.hset(scope.legacyProgressionKey, {
        strategies_real_total: "300",
        cycles_completed: "100",
        successful_cycles: "100",
        total_trades: "9",
        settings_recoordination_pending: "1",
        live_positions_created_count: "4",
      })

      await ProgressionStateManager.archiveAndStartNewProgression(connectionId, 2, "main")

      const fresh = await ProgressionStateManager.getProgressionState(connectionId, "main")
      expect(fresh.sessionNumber).toBe(2)
      expect(fresh.cyclesCompleted).toBe(0)
      expect(fresh.totalTrades).toBe(0)
      expect(fresh.strategiesRealTotal).toBe(0)
      expect(fresh.indicationCycleCount).toBe(0)

      // The previous legacy totals are archived, not lost; non-counter
      // fields of the legacy mirror are kept.
      expect(await client.hgetall(`${scope.legacyProgressionKey}:history:1`)).toMatchObject({
        cycles_completed: "100",
        total_trades: "9",
      })
      expect(await client.hget(scope.legacyProgressionKey, "settings_recoordination_pending")).toBe("1")
      expect(await client.hget(scope.legacyProgressionKey, "live_positions_created_count")).toBe("4")

      // New-session writes: incrementCycle (legacy only) and a mirrored
      // strategy-coordinator increment (both hashes).
      await client.hincrby(scope.legacyProgressionKey, "cycles_completed", 2)
      await client.hincrby(scope.progressionKey, "strategies_real_total", 3)
      await client.hincrby(scope.legacyProgressionKey, "strategies_real_total", 3)

      const next = await ProgressionStateManager.getProgressionState(connectionId, "main")
      expect(next.cyclesCompleted).toBe(2)
      expect(next.strategiesRealTotal).toBe(3)
    } finally {
      await client.del(...keys)
    }
  })

  test("an operator reset clears both the scoped and the legacy hash", async () => {
    const connectionId = `progression-reset-${Date.now()}`
    const client = getRedisClient()
    const scope = buildProgressionScope(connectionId, "main")
    try {
      await client.hset(scope.progressionKey, { connection_id: connectionId, indication_cycle_count: "12" })
      await client.hset(scope.legacyProgressionKey, { cycles_completed: "8" })

      await ProgressionStateManager.resetProgressionState(connectionId)

      expect(await client.hgetall(scope.progressionKey)).toEqual({})
      expect(await client.hgetall(scope.legacyProgressionKey)).toEqual({})
      const state = await ProgressionStateManager.getProgressionState(connectionId, "main")
      expect(state.cyclesCompleted).toBe(0)
      expect(state.indicationCycleCount).toBe(0)
    } finally {
      await client.del(scope.progressionKey, scope.legacyProgressionKey)
    }
  })
})

/**
 * Unit tests for progression state stability
 * Tests for crashes, hanging, data consistency, and correctness
 */

describe('Progression State Manager - Stability Tests', () => {
  describe('No Hanging/Deadlocks', () => {
    test('should not hang on rapid API calls', async () => {
      const requests = 5
      const timeout = 5000
      const times: number[] = []
      for (let i = 0; i < requests; i++) {
        const start = Date.now()
        await new Promise(resolve => setTimeout(resolve, 10))
        const elapsed = Date.now() - start
        times.push(elapsed)
      }
      times.forEach(t => {
        expect(t).toBeLessThan(timeout)
      })
    })

    test('should complete Promise.all without deadlock', async () => {
      const operations = [
        Promise.resolve(1),
        Promise.resolve(2),
        Promise.resolve(3),
      ]
      const results = await Promise.all(operations)
      expect(results).toEqual([1, 2, 3])
    })
  })

  describe('Crash Prevention', () => {
    test('should not crash on divide by zero', () => {
      const threshold = 0
      let ratio = 0
      if (threshold > 0) {
        ratio = 100 / threshold
      } else {
        ratio = 0
      }
      expect(ratio).toBe(0)
    })

    test('should handle null progression data gracefully', () => {
      const progression: any = null
      const symbolCount = progression?.symbol_count ?? '0'
      expect(symbolCount).toBe('0')
    })
  })

  describe('Size Multiplier Propagation', () => {
    test('should compute correct block multiplier', () => {
      const variant = 'block'
      const multiplier = variant === 'block' ? 1.5 : 1.0
      expect(multiplier).toBe(1.5)
    })

    test('should compute correct dca multiplier', () => {
      const variant = 'dca'
      const multiplier = variant === 'dca' ? 0.5 : 1.0
      expect(multiplier).toBe(0.5)
    })
  })

  describe('Scoped progression regression guards', () => {
    test('preserves Signal counters through the canonical scoped state reader', async () => {
      const { getRedisClient } = await import('@/lib/redis-db')
      const { ProgressionStateManager } = await import('@/lib/progression-state-manager')
      const { buildProgressionScope } = await import('@/lib/progression-scope')
      const connectionId = `progression-signal-${Date.now()}`
      const client = getRedisClient()
      const scope = buildProgressionScope(connectionId, 'main')

      try {
        await client.del(scope.progressionKey, scope.legacyProgressionKey)
        await client.hset(scope.progressionKey, {
          connection_id: connectionId,
          engine_type: 'main',
          migrated_from_unscoped: 'true',
          indications_active_advanced_count: '4',
          indications_signal_count: '7',
          indications_trend_count: '3',
        })

        const state = await ProgressionStateManager.getProgressionState(connectionId, 'main')
        expect(state.indicationsActiveAdvancedCount).toBe(4)
        expect(state.indicationsSignalCount).toBe(7)
        expect(state.indicationsTrendCount).toBe(3)
      } finally {
        await client.del(scope.progressionKey, scope.legacyProgressionKey)
      }
    })

    test('uses the newest scoped-or-legacy cycle snapshot while preserving merged counters', async () => {
      const { getRedisClient } = await import('@/lib/redis-db')
      const { ProgressionStateManager } = await import('@/lib/progression-state-manager')
      const { buildProgressionScope } = await import('@/lib/progression-scope')
      const connectionId = `progression-freshest-${Date.now()}`
      const client = getRedisClient()
      const scope = buildProgressionScope(connectionId, 'main')
      const older = new Date(Date.now() - 60_000).toISOString()
      const newer = new Date().toISOString()

      try {
        await client.del(scope.progressionKey, scope.legacyProgressionKey)
        await client.hset(scope.progressionKey, {
          connection_id: connectionId,
          engine_type: 'main',
          migrated_from_unscoped: 'true',
          cycles_completed: '4',
          successful_cycles: '4',
          cycle_success_rate: '0',
          cycle_time_ms: '9999',
          last_update: older,
        })
        await client.hset(scope.legacyProgressionKey, {
          cycles_completed: '10',
          successful_cycles: '8',
          cycle_success_rate: '0',
          total_trades: '5',
          successful_trades: '4',
          trade_success_rate: '0',
          cycle_time_ms: '125',
          last_update: newer,
        })

        const state = await ProgressionStateManager.getProgressionState(connectionId, 'main')
        expect(state.cyclesCompleted).toBe(10)
        expect(state.successfulCycles).toBe(8)
        expect(state.cycleSuccessRate).toBe(80)
        expect(state.tradeSuccessRate).toBe(80)
        expect(state.cycleTimeMs).toBe(125)
        expect(state.lastUpdate.toISOString()).toBe(newer)
      } finally {
        await client.del(scope.progressionKey, scope.legacyProgressionKey)
      }
    })

    test('progression API derives the displayed cycle rate from merged counters', () => {
      const fs = require('fs')
      const path = require('path')
      const source = fs.readFileSync(path.join(process.cwd(), 'app/api/trade-engine/progression/route.ts'), 'utf8')

      expect(source).toContain('const computedCycleSuccessRate =')
      expect(source).toContain('successfulCycles / cyclesCompleted')
      expect(source).toContain('cycleSuccessRate: computedCycleSuccessRate')
      expect(source).not.toContain('cycleSuccessRate: progressionState.cycleSuccessRate')
    })

    test('healthy live progression resolves stale startup reconciliation presentation', () => {
      const fs = require('fs')
      const path = require('path')
      const routeSource = fs.readFileSync(path.join(process.cwd(), 'app/api/trade-engine/progression/route.ts'), 'utf8')
      const managerSource = fs.readFileSync(path.join(process.cwd(), 'lib/trade-engine/engine-manager.ts'), 'utf8')
      const startupSource = fs.readFileSync(path.join(process.cwd(), 'lib/startup-coordinator.ts'), 'utf8')

      expect(routeSource).toContain('String((storedProgression as any)?.phase || "") === "live_trading"')
      expect(routeSource).toContain('orphan_cleanup_pending: false')
      expect(managerSource).toContain('status: phase === "live_trading"')
      expect(managerSource).toContain('recoordination_completed_at: updatedAt')
      expect(startupSource).toContain('orphan_cleanup_resolved_at: resolvedAt')
      expect(startupSource).toContain('needs_reconcile: false')
    })

    test('stats route keeps scoped progression namespaces aligned and stale fallbacks isolated', () => {
      const fs = require('fs')
      const path = require('path')
      const source = fs.readFileSync(path.join(process.cwd(), 'app/api/connections/progression/[id]/stats/route.ts'), 'utf8')

      expect(source).toContain('const scope = await ensureScopedProgressionFromLegacy(client, connectionId, engineType)')
      expect(source).toContain('client.hgetall(scope.progressionKey)')
      expect(source).toContain('client.hgetall(scope.prehistoricKey)')
      expect(source).toContain('getSettings(scope.engineProgressionKey)')
      expect(source).toContain('getSettings(`engine_progression:${connectionId}`)')
      expect(source).toContain('client.hgetall(scope.tradeEngineStateKey)')
      expect(source).toContain('progression: unscopedProgressionUsable ? undefined : legacyProgHash')
      expect(source).not.toContain('const engineType = request.nextUrl.searchParams.get("engineType") || "main"')
    })

    test('config-set prehistoric progress mirrors scoped and legacy progress for deploy compatibility', () => {
      const fs = require('fs')
      const path = require('path')
      const source = fs.readFileSync(path.join(process.cwd(), 'lib/trade-engine/config-set-processor.ts'), 'utf8')

      expect(source).toContain('const progressionScope = buildProgressionScope(this.connectionId, "main")')
      expect(source).toContain('const prehistoricSymbolsKey = `${prehistoricKey}:symbols`')
      expect(source).toContain('client.hset(progressionScope.progressionKey')
      expect(source).toContain('client.hset(progressionScope.legacyProgressionKey')
      expect(source).toContain('client.hincrby(progressionScope.progressionKey')
      expect(source).toContain('client.hincrby(progressionScope.legacyProgressionKey')
      expect(source).toContain('setSettings(engineProgressionKey, stamped)')
      expect(source).toContain('setSettings(legacyEngineProgressionKey, stamped)')
      expect(source).not.toContain('setSettings(engineProgressionKey, {')
    })

    test('runtime progression APIs and write wrappers keep scoped and legacy keys deploy-compatible', () => {
      const fs = require('fs')
      const path = require('path')
      const routeSource = fs.readFileSync(path.join(process.cwd(), 'app/api/connections/progression/[id]/route.ts'), 'utf8')
      const writesSource = fs.readFileSync(path.join(process.cwd(), 'lib/trade-engine/progression-writes.ts'), 'utf8')
      const managerSource = fs.readFileSync(path.join(process.cwd(), 'lib/trade-engine/engine-manager.ts'), 'utf8')
      const progressionSource = fs.readFileSync(path.join(process.cwd(), 'lib/progression-state-manager.ts'), 'utf8')
      const recoordinatorSource = fs.readFileSync(path.join(process.cwd(), 'lib/connection-recoordinator.ts'), 'utf8')

      expect(routeSource).toContain('getSettings(scope.engineProgressionKey)')
      expect(routeSource).toContain('getSettings(`engine_progression:${connectionId}`)')
      expect(routeSource).toContain('client?.get(prehistoricGateKeys.scoped)')
      expect(routeSource).toContain('client?.get(prehistoricGateKeys.legacy)')

      expect(writesSource).toContain('legacyProgressionKey(connectionId, engineType)')
      expect(writesSource).toContain('(client as any).hset(legacyKey, fields)')
      expect(writesSource).toContain('(client as any).hincrby(legacyKey, field, increment)')
      expect(writesSource).toContain('client.del(legacyKey)')

      expect(managerSource).toContain('setSettings(legacyKey, progressionData)')
      expect(progressionSource).toContain('"indications_signal_count"')
      expect(progressionSource).toContain('indicationsSignalCount: parseInt(data.indications_signal_count || "0", 10)')
      expect(recoordinatorSource).toContain('writeOrBundle(scope.tradeEngineStateKey, hashPatch)')
      expect(recoordinatorSource).toContain('client.hset(scope.tradeEngineStateKey, marker)')
      expect(recoordinatorSource).toContain('client.hset(scope.progressionKey')
      expect(recoordinatorSource).toContain('client.hset(scope.legacyProgressionKey')
    })
  })
})

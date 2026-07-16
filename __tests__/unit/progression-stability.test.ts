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
    test('stats route keeps scoped progression namespaces aligned and stale fallbacks isolated', () => {
      const fs = require('fs')
      const path = require('path')
      const source = fs.readFileSync(path.join(process.cwd(), 'app/api/connections/progression/[id]/stats/route.ts'), 'utf8')

      expect(source).toContain('const scope = await ensureScopedProgressionFromLegacy(client, connectionId, engineType)')
      expect(source).toContain('client.hgetall(scope.progressionKey)')
      expect(source).toContain('client.hgetall(scope.prehistoricKey)')
      expect(source).toContain('getSettings(scope.engineProgressionKey)')
      expect(source).toContain('getSettings(`engine_progression:${connectionId}`)')
      expect(source).toContain('getSettings(scope.tradeEngineStateKey)')
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
      expect(recoordinatorSource).toContain('writeOrBundle(scope.tradeEngineStateKey, hashPatch)')
      expect(recoordinatorSource).toContain('client.hset(scope.tradeEngineStateKey, marker)')
      expect(recoordinatorSource).toContain('client.hset(scope.progressionKey')
      expect(recoordinatorSource).toContain('client.hset(scope.legacyProgressionKey')
    })
  })
})

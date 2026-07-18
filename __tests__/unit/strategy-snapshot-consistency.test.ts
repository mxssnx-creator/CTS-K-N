import fs from "node:fs"
import path from "node:path"

const root = process.cwd()
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8")

describe("coherent strategy snapshots and schema v78", () => {
  test("uses symbol-local active lineage under parallel symbol processing", () => {
    const source = read("lib/strategy-coordinator.ts")
    expect(source).toContain("private _activeKeysCache = new Map<string")
    expect(source).toContain("this._activeKeysCache.set(symbol")
    expect(source).toContain("this._activeKeysCache.get(symbol)")
    expect(source).not.toContain("private _activeKeysCache: { keys: Set<string>")
  })

  test("writes Real and Live activity atomically from one snapshot", () => {
    const source = read("lib/strategy-coordinator.ts")
    expect(source).toContain("coordinateActiveRealLiveCounts")
    expect(source).toContain("coherentActiveCounts.real")
    expect(source).toContain("coherentActiveCounts.live")
    expect(source).toContain("`${symbol}:snapshot:ts`")
    expect(source).not.toContain("dev fallback - injected synthetic qualifying set from MAIN")

    const stats = read("app/api/connections/progression/[id]/stats/route.ts")
    expect(stats).toContain("if (stratCounts.live > stratCounts.real)")
  })

  test("persists bounded v2 derived scalars and fails closed on unsafe v1", () => {
    const source = read("lib/strategy-coordinator.ts")
    expect(source).toContain("formatVersion: 2")
    expect(source).toContain("compactStrategySetForStorage")
    expect(source).toContain("hydrateStrategySetSnapshots")
    expect(source).toContain("Legacy v1 stored only Set keys")
  })

  test("migrations are sequential through the coherent schema", () => {
    const source = read("lib/redis-migrations.ts")
    const versions = Array.from(source.matchAll(/version:\s*(\d+)/g), (match) => Number(match[1]))
    expect(versions.at(-1)).toBe(79)
    expect(versions.every((version, index) => version === index + 1)).toBe(true)
    expect(source).toContain('name: "075-bound-high-frequency-statistics-storage"')
    expect(source).toContain('name: "079-repair-hourly-statistics-rollups"')
    expect(source).toContain('high_frequency_statistics_storage: "bounded-hourly-rollups-v2"')
    expect(source).toContain('name: "076-dynamic-symbol-selection-default-one"')
    expect(source).toContain('name: "077-indexed-current-indication-snapshots"')
    expect(source).toContain('name: "078-coherent-strategy-set-snapshots"')
    expect(source).toContain('strategy_active_snapshot: "symbol-local-atomic-real-live-v2"')
    expect(source).toContain('strategy_real_snapshot: "bounded-derived-scalars-v2"')
  })

  test("stats ignore stale fields outside the durable symbol basket", () => {
    const source = read("app/api/connections/progression/[id]/stats/route.ts")
    expect(source).toContain("activeStatsSymbolFilter")
    expect(source).toContain("!activeStatsSymbolFilter.has(fieldSymbol)")
    expect(source).toContain("aggregateIndicationSnapshot(")
  })
})

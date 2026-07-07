/**
 * Comprehensive System Diagnostics and Fixes
 * 
 * Identifies and fixes issues in:
 * 1. Status field persistence
 * 2. Passed/failed calculation
 * 3. Set count tracking
 * 4. Position accumulation
 * 5. Hedge netting accuracy
 * 6. Rate limiting and batch processing
 */

import { getRedisClient } from "@/lib/redis-db"

interface DiagnosticReport {
  timestamp: string
  connection: string
  symbol: string
  issues: string[]
  fixes: string[]
  stats: Record<string, unknown>
}

export async function runSystemDiagnostics(
  connectionId: string,
  symbol: string = "BTCUSDT",
): Promise<DiagnosticReport> {
  const client = getRedisClient()
  const report: DiagnosticReport = {
    timestamp: new Date().toISOString(),
    connection: connectionId,
    symbol,
    issues: [],
    fixes: [],
    stats: {},
  }

  console.log(`[v0] [Diagnostics] Starting comprehensive system audit for ${connectionId}/${symbol}`)

  try {
    // ── CHECK 1: Status Field Persistence ──────────────────────────────
    console.log("[v0] [Diagnostics] CHECK 1: Status field persistence")

    const mainSetsKey = `strategies:${connectionId}:${symbol}:main:sets`
    const mainSetsData = await client.get(mainSetsKey)

    if (mainSetsData) {
      try {
        const parsed = JSON.parse(mainSetsData as string)
        const sets = parsed.sets || []

        let withStatus = 0
        let withoutStatus = 0
        const statusDist = new Map<string, number>()

        for (const set of sets) {
          if (set.status !== undefined) {
            withStatus++
            const count = statusDist.get(set.status) || 0
            statusDist.set(set.status, count + 1)
          } else {
            withoutStatus++
          }
        }

        report.stats.mainSets = {
          total: sets.length,
          withStatus,
          withoutStatus,
          statusDistribution: Object.fromEntries(statusDist),
        }

        if (withoutStatus > 0) {
          report.issues.push(
            `${withoutStatus} MAIN sets missing status field (${((withoutStatus / sets.length) * 100).toFixed(1)}%)`,
          )
        }
      } catch (e) {
        report.issues.push(`Failed to parse MAIN sets data: ${e}`)
      }
    } else {
      report.issues.push("No MAIN sets data found in Redis")
    }

    // ── CHECK 2: BASE Set Counts vs MAIN Set Counts ───────────────────
    console.log("[v0] [Diagnostics] CHECK 2: Set count ratios")

    const baseSetsKey = `strategies:${connectionId}:${symbol}:base:sets`
    const baseSetsData = await client.get(baseSetsKey)

    let baseCount = 0
    if (baseSetsData) {
      try {
        const parsed = JSON.parse(baseSetsData as string)
        baseCount = (parsed.sets || []).length
      } catch {
        report.issues.push("Failed to parse BASE sets data")
      }
    }

    const mainCount = mainSetsData
      ? JSON.parse(mainSetsData as string).sets?.length || 0
      : 0

    if (baseCount > 0) {
      const ratio = mainCount / baseCount
      report.stats.setCounts = {
        base: baseCount,
        main: mainCount,
        mainPerBase: ratio.toFixed(2),
      }

      if (ratio < 2) {
        report.issues.push(
          `MAIN/BASE ratio too low: ${ratio.toFixed(2)} (expected 4-8 with variants+axis)`,
        )
      }
    }

    // ── CHECK 3: Position Accumulation Tracking ────────────────────────
    console.log("[v0] [Diagnostics] CHECK 3: Position accumulation")

    const axisPosAccKey = `axis_pos_acc:${connectionId}`
    const axisPosData = await client.hgetall(axisPosAccKey) ?? {}

    if (Object.keys(axisPosData as Record<string, string>).length > 0) {
      report.stats.axisAccumulation = {
        buckets: Object.keys(axisPosData as Record<string, string>).length,
        totalCount: Object.values(axisPosData as Record<string, string>).reduce(
          (sum: number, v) => sum + parseInt(v as string),
          0,
        ),
      }
    } else {
      report.issues.push("No axis position accumulation data found")
    }

    // ── CHECK 4: Hedge Netting Bucket Keys ────────────────────────────
    console.log("[v0] [Diagnostics] CHECK 4: Hedge netting buckets")

    const realSetsKey = `strategies:${connectionId}:${symbol}:real:sets`
    const realSetsData = await client.get(realSetsKey)

    if (realSetsData) {
      try {
        const parsed = JSON.parse(realSetsData as string)
        // Handle slim format (Step 5 coord plan): resolve from Base sets
        let realSets: any[] = []
        if (parsed._slim && Array.isArray(parsed.setKeys)) {
          const baseKey  = `strategies:${connectionId}:${symbol}:base:sets`
          const baseSt   = await client.get(baseKey)
          const baseArr: any[] = baseSt ? (JSON.parse(baseSt as string)?.sets || []) : []
          const keySet   = new Set<string>(parsed.setKeys)
          realSets       = baseArr.filter((s: any) => keySet.has(s.setKey))
        } else {
          realSets       = parsed.sets || []
        }

        const directions = { long: 0, short: 0 }
        const withParentKey = realSets.filter((s: any) => s.parentSetKey).length

        for (const set of realSets) {
          if (set.direction === "long") directions.long++
          else if (set.direction === "short") directions.short++
        }

        report.stats.realSets = {
          total: realSets.length,
          directions,
          withParentKey,
        }

        if (withParentKey === 0 && realSets.length > 0) {
          report.issues.push(
            "REAL sets missing parentSetKey (needed for hedge netting)",
          )
        }
      } catch (e) {
        report.issues.push(`Failed to parse REAL sets data: ${e}`)
      }
    }

    // ── CHECK 5: Passed/Failed Calculation Accuracy ────────────────────
    console.log("[v0] [Diagnostics] CHECK 5: Stats calculation accuracy")

    const detailKey = `strategies:${connectionId}:${symbol}:detail`
    const detailData = await client.hgetall(detailKey)

    if (detailData) {
      const baseDetail = {
        evaluated: parseInt(detailData[`base:evaluated`] as string) || 0,
        passed: parseInt(detailData[`base:passed`] as string) || 0,
        failed: parseInt(detailData[`base:failed`] as string) || 0,
      }

      // Verify: passed + failed should equal evaluated
      const expected = baseDetail.evaluated
      const actual = baseDetail.passed + baseDetail.failed

      report.stats.baseStats = baseDetail

      if (actual !== expected) {
        report.issues.push(
          `BASE stats mismatch: passed(${baseDetail.passed}) + failed(${baseDetail.failed}) = ${actual}, expected ${expected}`,
        )
        report.fixes.push(
          `FIX: Recalculate BASE stats - passed should be sets with status='valid_base', failed = rest`,
        )
      }
    }

    // ── CHECK 6: Rate Limit and API Performance ────────────────────────
    console.log("[v0] [Diagnostics] CHECK 6: Rate limiting status")

    const redisInfo = await client.info()
    report.stats.redisInfo = {
      totalCommands: redisInfo?.split("total_commands_processed:")[1]?.split("\r")[0],
    }

    // ── SUMMARY ────────────────────────────────────────────────────────
    console.log("[v0] [Diagnostics] Diagnostics complete")
    console.log(
      `[v0] [Diagnostics] Issues found: ${report.issues.length}, Fixes needed: ${report.fixes.length}`,
    )

    return report
  } catch (error) {
    console.error("[v0] [Diagnostics] Error during diagnostics:", error)
    throw error
  }
}

/**
 * Apply fixes to identified issues
 */
export async function applyFixes(
  connectionId: string,
  symbol: string = "BTCUSDT",
): Promise<void> {
  const client = getRedisClient()

  console.log(`[v0] [Fixes] Starting system repairs for ${connectionId}/${symbol}`)

  try {
    // ── FIX 1: Update status field in MAIN sets ────────────────────────
    console.log("[v0] [Fixes] FIX 1: Ensuring status fields are present")

    const mainSetsKey = `strategies:${connectionId}:${symbol}:main:sets`
    const mainSetsData = await client.get(mainSetsKey)

    if (mainSetsData) {
      const parsed = JSON.parse(mainSetsData as string)
      const sets = parsed.sets || []

      let fixed = 0
      for (const set of sets) {
        if (!set.status) {
          // Set default status based on whether it has entries
          set.status = set.entryCount > 0 ? "valid_main" : "invalid"
          fixed++
        }
      }

      if (fixed > 0) {
        await client.set(mainSetsKey, JSON.stringify(parsed))
        console.log(`[v0] [Fixes] Fixed ${fixed} MAIN sets with missing status`)
      }
    }

    // ── FIX 2: Recalculate BASE passed/failed ──────────────────────────
    console.log("[v0] [Fixes] FIX 2: Recalculating BASE passed/failed stats")

    const baseSetsKey = `strategies:${connectionId}:${symbol}:base:sets`
    const baseSetsData = await client.get(baseSetsKey)

    if (baseSetsData) {
      const parsed = JSON.parse(baseSetsData as string)
      const sets = parsed.sets || []

      const validCount = sets.filter((s: any) => s.status === "valid_base").length
      const invalidCount = sets.length - validCount

      const detailKey = `strategies:${connectionId}:${symbol}:detail`
      await client.hset(detailKey, {
        [`base:passed`]: String(validCount),
        [`base:failed`]: String(invalidCount),
        [`base:evaluated`]: String(sets.length),
      })

      console.log(
        `[v0] [Fixes] Updated BASE stats: ${validCount} passed, ${invalidCount} failed`,
      )
    }

    // ── FIX 3: Ensure REAL sets have parentSetKey ──────────────────────
    console.log("[v0] [Fixes] FIX 3: Verifying REAL set parentSetKey")

    const realSetsKey = `strategies:${connectionId}:${symbol}:real:sets`
    const realSetsData = await client.get(realSetsKey)

    if (realSetsData) {
      const parsed = JSON.parse(realSetsData as string)
      // Slim format: parentSetKey fix is not needed — Base sets already carry it.
      // Skip the mutation pass for slim records; it would be a no-op anyway since
      // there are no set objects stored inline to mutate.
      if (parsed._slim) {
        console.log("[v0] [Fixes] FIX 3: slim format — parentSetKey guaranteed via BaseRegistry, skip")
        return
      }
      const sets = parsed.sets || []

      let fixed = 0
      for (const set of sets) {
        if (!set.parentSetKey && set.setKey) {
          set.parentSetKey = set.setKey.split("#")[0]
          fixed++
        }
      }

      if (fixed > 0) {
        await client.set(realSetsKey, JSON.stringify(parsed))
        console.log(`[v0] [Fixes] Fixed ${fixed} REAL sets with missing parentSetKey`)
      }
    }

    console.log("[v0] [Fixes] System repairs complete")
  } catch (error) {
    console.error("[v0] [Fixes] Error during fixes:", error)
    throw error
  }
}

/**
 * Run full audit, report, and fix
 */
export async function runFullAudit(
  connectionId: string,
  symbol?: string,
): Promise<DiagnosticReport> {
  const report = await runSystemDiagnostics(connectionId, symbol)

  if (report.issues.length > 0) {
    console.log(`[v0] [Audit] Found ${report.issues.length} issues, applying fixes...`)
    await applyFixes(connectionId, symbol)
  }

  return report
}

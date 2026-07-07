import { NextResponse } from "next/server"
import { PositionCalculator } from "@/lib/position-calculator"
import { initRedis, getAppSetting } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

/**
 * GET /api/indications/config-counts
 *
 * Returns the number of POSSIBLE Independent Sets per Main indication type
 * (direction / move / active / optimal / auto), together with the calc
 * parameters that produced each count (ranges, steps, time variations,
 * drawdown thresholds, etc.).
 *
 * These are *enumeration counts* — the number of distinct configurations the
 * engine will spawn per symbol. Each configuration becomes ONE Independent
 * Set with its own 250-slot position database (tunable). The counts are
 * purely derived from the current settings, so they do NOT reflect live
 * runtime activity — they answer "how many Sets COULD the engine create?"
 *
 * ── Settings source ──────────────────────────────────────────────────
 * Settings are loaded via `getSettings(key)` which reads the
 * `settings:<key>` hashes written by the Settings UI. The keys we use here
 * (e.g. `indicationRangeMin`) match the camelCase names the settings
 * coordinator and indication-state-manager already consume, so this
 * endpoint sees the same values the engine uses. Missing values fall back
 * to the PositionCalculator defaults (3..30 step 1, tp-divisor 3, 250 cap).
 */
export async function GET() {
  try {
    await initRedis()

    // Load individual settings via the mirror-aware scalar reader so the
    // UI-saved values (which live on `app_settings.<field>`, NOT as
    // standalone `settings:<field>` hashes) are picked up. Each call
    // falls back through individual-key → app_settings → all_settings
    // → supplied default, which also matches what
    // `indication-state-manager.ts:210` now reads for `indicationRangeMin`.
    const [
      rawMin, rawMax, rawStep, rawTpDivisor,
      rawOptimalBase, rawAutoHrs, rawAutoWins,
    ] = await Promise.all([
      getAppSetting<unknown>("indicationRangeMin", null),
      getAppSetting<unknown>("indicationRangeMax", null),
      getAppSetting<unknown>("indicationRangeStep", null),
      getAppSetting<unknown>("takeProfitRangeDivisor", null),
      getAppSetting<unknown>("optimalBasePositionsLimit", null),
      getAppSetting<unknown>("autoDrawdownHours", null),
      getAppSetting<unknown>("autoTimeWindows", null),
    ])

    // asPosInt guards against zeros / negatives / NaN that could leak
    // through if a row was written with a malformed value (e.g. a hand-
    // edited Redis hash). Keeps the combinatorial math well-defined.
    const indicationMin   = asPosInt(rawMin, 3)
    const indicationMax   = asPosInt(rawMax, 30)
    const indicationStep  = asPosInt(rawStep, 1)
    const tpDivisorVal    = asPosInt(rawTpDivisor, 3)
    const optimalBaseCap  = asPosInt(rawOptimalBase, 250)
    const autoDrawdownHrs = asPosInt(rawAutoHrs, 1)
    const autoTimeWins    = asPosInt(rawAutoWins, 3)

    // Drive the calculator with the SAME settings so per-type config
    // counts reflect the live configuration. Passing the structured
    // object keeps PositionCalculator.getConfigurableRanges() aligned.
    const calc = new PositionCalculator({
      indicationRangeMin:     indicationMin,
      indicationRangeMax:     indicationMax,
      indicationRangeStep:    indicationStep,
      takeProfitRangeDivisor: tpDivisorVal,
    })
    // Symbol-independent — calculator derives per-type configs purely from
    // settings. Pass a placeholder symbol to satisfy the API.
    const analysis = calc.calculateSymbolPositions("__DERIVED__")

    // ── Rebuild the raw range counts for the UI hint line ──────────────
    const rawRangeCount = Math.max(
      0,
      Math.floor((indicationMax - indicationMin) / indicationStep) + 1,
    )
    // Only count ranges that survive PositionCalculator's tp-coordination
    // gate (tp ≥ 1 and tp ≤ range/2).
    let validRangeCount = 0
    for (let r = indicationMin; r <= indicationMax; r += indicationStep) {
      const minTp = Math.max(1, Math.floor(r / tpDivisorVal))
      if (minTp >= 1 && minTp <= r / 2) validRangeCount++
    }

    const directionCat = analysis.categories.find((c) => c.subcategory === "Direction Change")
    const moveCat      = analysis.categories.find((c) => c.subcategory === "Move Detection")
    const activeCat    = analysis.categories.find((c) => c.subcategory === "Active Trading")

    // Optimal & Auto are runtime-adaptive rather than combinatorial, so
    // we derive representative counts directly from their settings.
    //   Optimal: valid ranges × 2 drawdown tiers
    //   Auto:    time windows × 2 directions × drawdown tiers
    const optimalConfigs = validRangeCount * 2
    const autoConfigs    = Math.max(1, autoTimeWins) * 2 * Math.max(1, autoDrawdownHrs)

    const totalConfigs =
      (directionCat?.configurations ?? 0) +
      (moveCat?.configurations ?? 0) +
      (activeCat?.configurations ?? 0) +
      optimalConfigs +
      autoConfigs

    return NextResponse.json({
      totalPossibleSets: totalConfigs,
      perSetDbCapacity:  optimalBaseCap,
      maxStorablePositions: totalConfigs * optimalBaseCap,
      settings: {
        indicationRangeMin:        indicationMin,
        indicationRangeMax:        indicationMax,
        indicationRangeStep:       indicationStep,
        takeProfitRangeDivisor:    tpDivisorVal,
        rawRangeCount,
        validRangeCount,
        optimalBasePositionsLimit: optimalBaseCap,
        autoDrawdownHours:         autoDrawdownHrs,
        autoTimeWindows:           autoTimeWins,
      },
      // Per-type breakdown rendered as 5 rows on the dashboard.
      types: [
        {
          type: "direction",
          label: "Direction Change",
          possibleSets: directionCat?.configurations ?? 0,
          formula: `${validRangeCount} valid ranges × 5 price ratios × 6 time variations`,
          params: {
            validRanges:    validRangeCount,
            priceRatios:    5,        // [0.2, 0.4, 0.6, 0.8, 1.0]
            timeVariations: 6,
            drawdownGate:   "tp ≥ 1 and ≤ range/2",
          },
          description: directionCat?.description ?? "",
        },
        {
          type: "move",
          label: "Move Detection",
          possibleSets: moveCat?.configurations ?? 0,
          formula: `${validRangeCount} valid ranges × 5 price ratios × 6 time variations`,
          params: {
            validRanges:    validRangeCount,
            priceRatios:    5,
            timeVariations: 6,
            drawdownGate:   "tp ≥ 1 and ≤ range/2",
          },
          description: moveCat?.description ?? "",
        },
        {
          type: "active",
          label: "Active Trading",
          possibleSets: activeCat?.configurations ?? 0,
          formula: `${validRangeCount} valid ranges × 5 active thresholds × 2 time variations`,
          params: {
            validRanges:    validRangeCount,
            thresholds:     5,        // [1.0, 1.5, 2.0, 2.5, 3.0]
            timeVariations: 2,
            drawdownGate:   "active-volatility ≥ threshold",
          },
          description: activeCat?.description ?? "",
        },
        {
          type: "optimal",
          label: "Optimal (adaptive)",
          possibleSets: optimalConfigs,
          formula: `${validRangeCount} valid ranges × 2 drawdown tiers`,
          params: {
            validRanges:   validRangeCount,
            drawdownTiers: 2,
            dbCapacity:    optimalBaseCap,
            drawdownGate:  "PF ≥ 1.2 & drawdown ≤ tier",
          },
          description:
            "Adaptive Sets gated by runtime PF + drawdown thresholds; each Set keeps up to the configured DB capacity in history.",
        },
        {
          type: "auto",
          label: "Auto (multi-timeframe)",
          possibleSets: autoConfigs,
          formula: `${autoTimeWins} timeframes × 2 directions × ${autoDrawdownHrs} drawdown windows`,
          params: {
            timeWindows:   autoTimeWins,   // 8h / 1h / 30min / 1-20min
            directions:    2,              // long / short
            drawdownHours: autoDrawdownHrs,
            drawdownGate:  "directionAlignment + optimalSituation",
          },
          description:
            "Multi-timeframe adaptive Sets; the auto engine uses 8h/1h/30min/1–20min windows with alignment and drawdown gates.",
        },
      ],
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] /api/indications/config-counts error:", error)
    return NextResponse.json(
      { error: "Failed to compute indication config counts" },
      { status: 500 },
    )
  }
}

/** Coerce a setting value (scalar, string, or { value }) to a positive integer. */
function asPosInt(raw: any, fallback: number): number {
  if (raw === null || raw === undefined) return fallback
  // getSettings() sometimes returns an object like { value: 30 } depending
  // on how the setting was written — unwrap that shape too.
  const v = typeof raw === "object" && raw !== null && "value" in raw ? (raw as any).value : raw
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

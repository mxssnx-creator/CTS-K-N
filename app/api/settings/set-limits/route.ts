/**
 * Set Limits Configuration API
 * Configure entry limits for indication sets, strategy sets, and logs
 * Each type can have independent limits (default: 500)
 */

import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getSettings, setSettings, bumpSettingsVersion } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

// Default limits
const DEFAULT_INDICATION_LIMITS = {
  direction: 500,
  move: 500,
  active: 500,
  optimal: 500,
  active_advanced: 500,
}

const DEFAULT_STRATEGY_LIMITS = {
  base: 500,
  main: 500,
  real: 500,
  live: 500,
}

const DEFAULT_LOG_LIMITS = {
  progression: 500,
  system: 500,
  error: 500,
}

export async function GET(request: NextRequest) {
  try {
    await initRedis()
    
    const [indicationConfig, strategyConfig, logConfig] = await Promise.all([
      getSettings("indication_sets_config"),
      getSettings("strategy_sets_config"),
      getSettings("log_sets_config"),
    ])
    
    return NextResponse.json({
      success: true,
      limits: {
        indications: {
          direction: indicationConfig?.direction || DEFAULT_INDICATION_LIMITS.direction,
          move: indicationConfig?.move || DEFAULT_INDICATION_LIMITS.move,
          active: indicationConfig?.active || DEFAULT_INDICATION_LIMITS.active,
          optimal: indicationConfig?.optimal || DEFAULT_INDICATION_LIMITS.optimal,
          active_advanced: indicationConfig?.active_advanced || DEFAULT_INDICATION_LIMITS.active_advanced,
        },
        strategies: {
          base: strategyConfig?.base || DEFAULT_STRATEGY_LIMITS.base,
          main: strategyConfig?.main || DEFAULT_STRATEGY_LIMITS.main,
          real: strategyConfig?.real || DEFAULT_STRATEGY_LIMITS.real,
          live: strategyConfig?.live || DEFAULT_STRATEGY_LIMITS.live,
        },
        logs: {
          progression: logConfig?.progression || DEFAULT_LOG_LIMITS.progression,
          system: logConfig?.system || DEFAULT_LOG_LIMITS.system,
          error: logConfig?.error || DEFAULT_LOG_LIMITS.error,
        },
      },
      defaults: {
        indications: DEFAULT_INDICATION_LIMITS,
        strategies: DEFAULT_STRATEGY_LIMITS,
        logs: DEFAULT_LOG_LIMITS,
      },
    })
  } catch (error) {
    console.error("[v0] [SetLimits] GET error:", error)
    return NextResponse.json(
      { error: "Failed to get set limits", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    await initRedis()
    
    const updates: string[] = []
    
    // Update indication limits
    if (body.indications) {
      const indicationConfig = {
        direction: body.indications.direction || DEFAULT_INDICATION_LIMITS.direction,
        move: body.indications.move || DEFAULT_INDICATION_LIMITS.move,
        active: body.indications.active || DEFAULT_INDICATION_LIMITS.active,
        optimal: body.indications.optimal || DEFAULT_INDICATION_LIMITS.optimal,
        active_advanced: body.indications.active_advanced || DEFAULT_INDICATION_LIMITS.active_advanced,
        updated_at: new Date().toISOString(),
      }
      await setSettings("indication_sets_config", indicationConfig)
      updates.push("indications")
    }
    
    // Update strategy limits
    if (body.strategies) {
      const strategyConfig = {
        base: body.strategies.base || DEFAULT_STRATEGY_LIMITS.base,
        main: body.strategies.main || DEFAULT_STRATEGY_LIMITS.main,
        real: body.strategies.real || DEFAULT_STRATEGY_LIMITS.real,
        live: body.strategies.live || DEFAULT_STRATEGY_LIMITS.live,
        updated_at: new Date().toISOString(),
      }
      await setSettings("strategy_sets_config", strategyConfig)
      updates.push("strategies")
    }
    
    // Update log limits
    if (body.logs) {
      const logConfig = {
        progression: body.logs.progression || DEFAULT_LOG_LIMITS.progression,
        system: body.logs.system || DEFAULT_LOG_LIMITS.system,
        error: body.logs.error || DEFAULT_LOG_LIMITS.error,
        updated_at: new Date().toISOString(),
      }
      await setSettings("log_sets_config", logConfig)
      updates.push("logs")
    }
    
    // Bump the global settings-version counter if any bundle was
    // updated — the sets-processor + log-retention loops read these
    // configs on each cycle via the version-aware cache, so the
    // operator's change takes effect on the next cycle without an
    // engine restart.
    if (updates.length > 0) {
      await bumpSettingsVersion()
    }

    return NextResponse.json({
      success: true,
      updated: updates,
      message: `Updated limits for: ${updates.join(", ")}`,
    })
  } catch (error) {
    console.error("[v0] [SetLimits] POST error:", error)
    return NextResponse.json(
      { error: "Failed to update set limits", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}

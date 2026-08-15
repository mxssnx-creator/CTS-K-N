import { NextResponse } from "next/server"
import { calculateIndicationConfigurationCounts } from "@/lib/indication-configuration-counts"
import { getAppSettings, getRedisClient, initRedis } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const COMMON_INDICATION_SETTINGS_KEY = "indications:common"
const SIGNAL_INDICATION_SETTINGS_KEY = "indications:signal"

function parseCommonSettings(raw: string | null): unknown {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Returns counts from the same grids that `IndicationSetsProcessor` evaluates.
 *
 * `possibleSets` is durable Long/Short set capacity. Default, Additional,
 * Common and Signal configurations all retain exact independent identities;
 * only the coordinated Auto aggregate is runtime-only.
 */
export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()
    const [settings, rawCommonSettings, rawSignalSettings] = await Promise.all([
      // setAppSettings bumps the in-process version and invalidates this cache,
      // while the 30-second hard refresh still observes out-of-band writers.
      // Polling every two seconds therefore need not reread both complete
      // settings hashes during every exhaustive progression slice.
      getAppSettings(),
      client.get(COMMON_INDICATION_SETTINGS_KEY),
      client.get(SIGNAL_INDICATION_SETTINGS_KEY),
    ])
    const counts = calculateIndicationConfigurationCounts(
      settings,
      parseCommonSettings(rawCommonSettings),
      parseCommonSettings(rawSignalSettings),
    )

    return NextResponse.json({
      ...counts,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] /api/indications/config-counts error:", error)
    return NextResponse.json(
      { error: "Failed to compute indication configuration counts" },
      { status: 500 },
    )
  }
}

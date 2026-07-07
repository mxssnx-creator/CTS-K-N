import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface Indication {
  id: string
  symbol: string
  indicationType: string
  direction: "UP" | "DOWN" | "NEUTRAL"
  confidence: number
  strength: number
  timestamp: string
  enabled: boolean
  metadata?: {
    macdValue?: number
    rsiValue?: number
    maValue?: number
    bbUpper?: number
    bbLower?: number
    volatility?: number
  }
}

function generateMockIndications(connectionId: string): Indication[] {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "AAPL", "EURUSD", "XAUUSD"]
  const types = ["Momentum", "Volatility", "Trend", "Mean Reversion", "Volume"]
  const directions: ("UP" | "DOWN" | "NEUTRAL")[] = ["UP", "DOWN", "NEUTRAL"]

  return Array.from({ length: 200 }, (_, i) => {
    const now = new Date()
    const minutesAgo = Math.floor(Math.random() * 60)
    const timestamp = new Date(now.getTime() - minutesAgo * 60000).toISOString()

    return {
      id: `ind-${connectionId}-${i}`,
      symbol: symbols[Math.floor(Math.random() * symbols.length)],
      indicationType: types[Math.floor(Math.random() * types.length)],
      direction: directions[Math.floor(Math.random() * directions.length)],
      confidence: 30 + Math.random() * 70,
      strength: Math.random() * 100,
      timestamp,
      enabled: Math.random() > 0.3,
      metadata: {
        rsiValue: 30 + Math.random() * 40,
        macdValue: (Math.random() - 0.5) * 0.01,
        volatility: 15 + Math.random() * 30,
      },
    }
  })
}

/**
 * Normalise a raw timestamp to an ISO string.
 * Handles: epoch-ms as number, epoch-ms as numeric string, ISO strings.
 */
function normaliseTimestamp(raw: string | number | undefined): string {
  if (!raw) return new Date().toISOString()
  const ms = Number(raw)
  if (Number.isFinite(ms) && ms > 1_000_000_000_000) return new Date(ms).toISOString()
  const d = new Date(raw as string)
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
}

/**
 * Read real indications from the canonical engine keyspace.
 *
 * Primary path: the cron `generate-indications` writes Redis hashes:
 *   indications:{connId}:{type}:latest
 *   Fields: symbol, value, confidence, profitFactor, timestamp
 *   Known types: direction, move, active, optimal, auto
 *   TTL: 1 hour
 *
 * Fallback: the legacy IndicationConfigManager keys if canonical hashes
 * are absent (cold-boot before first cron cycle).
 *   Config:   indication:{connId}:config:{id}  — JSON
 *   Results:  indication:{connId}:config:{id}:results — list<pipe-delimited>
 */
async function getRealIndications(connectionId: string): Promise<Indication[]> {
  try {
    await initRedis()
    const client = getRedisClient()
    if (!client) return []

    // ── Primary path: canonical engine hashes ───────────────────────────────
    const KNOWN_TYPES = ["direction", "move", "active", "optimal", "auto"]
    const canonicalKeys = KNOWN_TYPES.map((t) => `indications:${connectionId}:${t}:latest`)

    const hashes = await Promise.all(
      canonicalKeys.map((k) =>
        (client.hgetall(k) as Promise<Record<string, string> | null>).catch(() => null)
      )
    )

    const canonicalIndications: Indication[] = []
    for (let i = 0; i < KNOWN_TYPES.length; i++) {
      const h = hashes[i]
      if (!h || Object.keys(h).length === 0) continue

      const type = KNOWN_TYPES[i]
      const symbol: string = h.symbol || "UNKNOWN"
      const rawConf = parseFloat(h.confidence || h.value || "0") || 0
      // confidence stored as 0-1 fraction; scale to 0-100 for display
      const confidence = Math.min(100, Math.max(0, rawConf <= 1 ? rawConf * 100 : rawConf))
      const signal: string = h.signal || h.direction || "neutral"
      const direction: "UP" | "DOWN" | "NEUTRAL" =
        signal === "buy" || signal === "long" || signal === "UP" ? "UP"
        : signal === "sell" || signal === "short" || signal === "DOWN" ? "DOWN"
        : "NEUTRAL"
      const timestamp = normaliseTimestamp(h.timestamp)

      canonicalIndications.push({
        id: `${connectionId}-${type}`,
        symbol,
        indicationType: type.charAt(0).toUpperCase() + type.slice(1),
        direction,
        confidence,
        strength: confidence,
        timestamp,
        enabled: true,
        metadata: {
          macdValue: parseFloat(h.value || "0") || undefined,
        },
      })
    }

    if (canonicalIndications.length > 0) return canonicalIndications

    // ── Fallback: legacy indication:config:* keys ────────────────────────────
    const configPattern = `indication:${connectionId}:config:*`
    const allKeys: string[] = await (client.keys(configPattern) as Promise<string[]>).catch(() => [])
    const configKeys = allKeys.filter((k) => !k.endsWith(":results")).slice(0, 500)
    if (configKeys.length === 0) return []

    const [configs, latestResults] = await Promise.all([
      Promise.all(configKeys.map((k) => client.get(k).catch(() => null))),
      Promise.all(
        configKeys.map((k) =>
          // lrange(0,0) is emulator-safe; lindex returns null on InlineLocalRedis
          (client.lrange(`${k}:results`, 0, 0) as Promise<string[]>)
            .then((arr) => (Array.isArray(arr) ? arr[0] ?? null : null))
            .catch(() => null)
        )
      ),
    ])

    const legacyIndications: Indication[] = []
    for (let i = 0; i < configKeys.length; i++) {
      let config: any = null
      try {
        const raw = configs[i]
        config = raw ? JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) : null
      } catch { continue }
      if (!config) continue

      const configId = config.id || configKeys[i].split(":").pop() || `config-${i}`
      const indType: string = config.type || "Unknown"
      const enabled: boolean = config.enabled !== false
      const resultRaw = latestResults[i]
      if (!resultRaw || typeof resultRaw !== "string") continue

      const parts = resultRaw.split("|")
      const timestamp = normaliseTimestamp(parts[0])
      const symbol = parts[1] || "UNKNOWN"
      const signal = parts[3] || "neutral"
      const direction: "UP" | "DOWN" | "NEUTRAL" =
        signal === "buy" ? "UP" : signal === "sell" ? "DOWN" : "NEUTRAL"
      const rawValue = parseFloat(parts[2] || "0") || 0
      const confidence = Math.min(100, Math.max(0, Math.abs(rawValue) > 1 ? rawValue : rawValue * 100))

      legacyIndications.push({
        id: `${connectionId}-${configId}`,
        symbol,
        indicationType: indType.charAt(0).toUpperCase() + indType.slice(1),
        direction,
        confidence,
        strength: confidence,
        timestamp,
        enabled,
        metadata: {},
      })
    }

    return legacyIndications
  } catch (error) {
    console.error(`[v0] Failed to get real indications for ${connectionId}:`, error)
    return []
  }
}

export async function GET(request: NextRequest) {
  try {
    const connectionId = request.nextUrl.searchParams.get("connectionId")
    if (!connectionId) {
      return NextResponse.json({ success: false, error: "connectionId query parameter required" }, { status: 400 })
    }

    const isDemo = connectionId === "demo-mode" || connectionId.startsWith("demo")

    let indications: Indication[] = []

    if (isDemo) {
      indications = generateMockIndications(connectionId)
    } else {
      indications = await getRealIndications(connectionId)
    }

    return NextResponse.json({
      success: true,
      data: indications,
      isDemo,
      connectionId,
      count: indications.length,
    })
  } catch (error) {
    console.error("[v0] Get indications error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}

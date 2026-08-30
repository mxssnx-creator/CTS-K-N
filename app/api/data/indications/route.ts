import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { mapWithConcurrency } from "@/lib/bounded-concurrency"
import { scanRedisKeys } from "@/lib/redis-scan"

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
    [key: string]: unknown
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

function percentMetric(raw: unknown): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return 0
  const scaled = Math.abs(parsed) <= 1 ? Math.abs(parsed) * 100 : Math.abs(parsed)
  return Math.min(100, Math.max(0, scaled))
}

function displayType(raw: Record<string, any>): string {
  const type = String(raw.type || "unknown").trim().toLowerCase()
  const commonName = String(raw.metadata?.commonIndicatorType || "").trim()
  if (type === "common" && commonName) {
    return `Common · ${commonName.toUpperCase()}`
  }
  return type
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Unknown"
}

function normaliseSnapshotIndication(
  raw: Record<string, any>,
  fallbackSymbol: string,
  index: number,
): Indication | null {
  if (!raw || typeof raw !== "object") return null
  const symbol = String(raw.symbol || fallbackSymbol || "UNKNOWN").trim().toUpperCase()
  const rawDirection = String(
    raw.direction || raw.metadata?.direction || raw.signal || "neutral",
  ).toLowerCase()
  const direction: "UP" | "DOWN" | "NEUTRAL" =
    rawDirection === "long" || rawDirection === "buy" || rawDirection === "up"
      ? "UP"
      : rawDirection === "short" || rawDirection === "sell" || rawDirection === "down"
        ? "DOWN"
        : "NEUTRAL"
  const metadata = raw.metadata && typeof raw.metadata === "object"
    ? { ...raw.metadata }
    : {}
  const commonName = String(metadata.commonIndicatorType || "").toLowerCase()
  const commonValue = Number(metadata.value)
  if (commonName === "rsi" && Number.isFinite(commonValue)) metadata.rsiValue = commonValue
  if (commonName === "macd" && Number.isFinite(commonValue)) metadata.macdValue = commonValue
  if (
    metadata.volatility === undefined &&
    Number.isFinite(Number(metadata.atrPct))
  ) {
    metadata.volatility = Number(metadata.atrPct)
  }

  return {
    id: String(
      raw.id ||
      raw.setKey ||
      `${symbol}:${raw.type || "unknown"}:${rawDirection}:${index}`,
    ),
    symbol,
    indicationType: displayType(raw),
    direction,
    confidence: percentMetric(raw.confidence),
    strength: percentMetric(
      raw.rawSignalStrength ?? raw.signalScore ?? raw.strength ?? raw.confidence,
    ),
    timestamp: normaliseTimestamp(raw.timestamp),
    enabled: raw.enabled !== false,
    metadata,
  }
}

async function scanSnapshotKeys(client: any, connectionId: string): Promise<string[]> {
  if (typeof client.scan !== "function") return []
  const keys: string[] = []
  let cursor = "0"
  do {
    const result = await client
      .scan(cursor, "MATCH", `indications_snapshot:${connectionId}:*`, "COUNT", 100)
      .catch(() => null)
    if (!result) break
    cursor = String(Array.isArray(result) ? result[0] : result.cursor || "0")
    keys.push(...((Array.isArray(result) ? result[1] : result.keys || []) as string[]))
  } while (cursor !== "0")
  return [...new Set(keys)].sort((left, right) => left.localeCompare(right))
}

/**
 * Read real indications from the canonical engine keyspace.
 *
 * Primary path: the engine writes one exhaustive current snapshot per symbol:
 *   indications_snapshot:{connId}:{symbol}
 * and maintains:
 *   indications_snapshot:index:{connId}
 *
 * Each snapshot contains every exact Default, Additional, Common and Signal
 * configuration emitted by the current cycle. The index is a navigation aid,
 * never a top-N list.
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

    // ── Primary path: canonical exhaustive per-symbol snapshots ─────────────
    const indexedSymbols = (
      await client.smembers(`indications_snapshot:index:${connectionId}`).catch(() => [])
    ) as string[]
    let snapshotKeys = [...new Set(indexedSymbols.map((symbol) =>
      `indications_snapshot:${connectionId}:${String(symbol).trim().toUpperCase()}`,
    ))]
    if (snapshotKeys.length === 0) {
      // Upgrade repair only. Once found, restore the maintained index so
      // subsequent dashboard polls are O(symbols) without a keyspace scan.
      snapshotKeys = await scanSnapshotKeys(client, connectionId)
      if (snapshotKeys.length > 0) {
        const symbols = snapshotKeys.map((key) =>
          key.slice(`indications_snapshot:${connectionId}:`.length),
        )
        await client
          .sadd(`indications_snapshot:index:${connectionId}`, ...symbols)
          .catch(() => 0)
      }
    }

    if (snapshotKeys.length > 0) {
      const snapshots = await mapWithConcurrency(snapshotKeys, 32, async (key) => ({
        key,
        raw: await client.get(key).catch(() => null),
      }))
      const canonicalIndications: Indication[] = []
      for (const snapshot of snapshots) {
        if (!snapshot.raw) continue
        let rows: unknown[] = []
        try {
          const parsed = JSON.parse(String(snapshot.raw))
          rows = Array.isArray(parsed) ? parsed : []
        } catch {
          rows = []
        }
        const fallbackSymbol = snapshot.key.slice(
          `indications_snapshot:${connectionId}:`.length,
        )
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index]
          if (!row || typeof row !== "object") continue
          const normalized = normaliseSnapshotIndication(
            row as Record<string, any>,
            fallbackSymbol,
            index,
          )
          if (normalized) canonicalIndications.push(normalized)
        }
      }
      if (canonicalIndications.length > 0) return canonicalIndications
    }

    // ── Fallback: legacy indication:config:* keys ────────────────────────────
    const configPattern = `indication:${connectionId}:config:*`
    const allKeys: string[] = await scanRedisKeys(client, configPattern).catch(() => [])
    // This fallback is also used by configuration-inspection screens during
    // upgrades. Never turn its response into a hidden top-500 view: every
    // exact type/name/config/direction lane must remain visible. Bound only
    // Redis concurrency so a large exhaustive grid cannot create an
    // unbounded Promise.all fan-out.
    const configKeys = allKeys
      .filter((k) => !k.includes(":results"))
      .sort((left, right) => left.localeCompare(right))
    if (configKeys.length === 0) return []

    const rows = await mapWithConcurrency(configKeys, 32, async (key) => {
      const [config, resultReference] = await Promise.all([
        client.get(key).catch(() => null),
        client.get(`${key}:results:ref`).catch(() => null),
      ])
      const referencedConfigId = String(resultReference || "").trim()
      const resultKey = referencedConfigId
        ? `indication:${connectionId}:config:${referencedConfigId}:results`
        : `${key}:results`
      const result = await (
        // lrange(0,0) is emulator-safe; lindex returns null on InlineLocalRedis
        (client.lrange(resultKey, 0, 0) as Promise<string[]>)
          .then((arr) => (Array.isArray(arr) ? arr[0] ?? null : null))
          .catch(() => null)
      )
      return { config, result }
    })

    const legacyIndications: Indication[] = []
    for (let i = 0; i < configKeys.length; i++) {
      let config: any = null
      try {
        const raw = rows[i]?.config
        config = raw ? JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) : null
      } catch { continue }
      if (!config) continue

      const configId = config.id || configKeys[i].split(":").pop() || `config-${i}`
      const indType: string = config.type || "Unknown"
      const enabled: boolean = config.enabled !== false
      const resultRaw = rows[i]?.result
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

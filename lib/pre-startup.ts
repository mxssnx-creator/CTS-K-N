import { getSettings, getAllConnections, initRedis, saveMarketData, setAppSettings, updateConnection } from "@/lib/redis-db"

type PreStartupGlobal = typeof globalThis & {
  __cts_pre_startup_done?: boolean
  __cts_pre_startup_promise?: Promise<void> | null
}

const preStartupGlobal = globalThis as PreStartupGlobal

function shouldRunPreStartup(): boolean {
  if (process.env.NEXT_RUNTIME !== "nodejs") return false
  // In production, we still need to run essential initialization (Redis, migrations)
  // but we skip the UI/UX seeding and connection testing
  return true
}

async function initializeDefaultSettings() {
  // Check canonical first; if empty, check legacy before giving up so we
  // don't stomp a migration-in-progress state where only `all_settings`
  // has been seeded.
  const canonical = await getSettings("app_settings")
  if (canonical && Object.keys(canonical).length > 0) return
  const legacy = await getSettings("all_settings")
  const { getDefaultSettings } = await import("@/lib/settings-storage")
  // `setAppSettings` mirrors the defaults to BOTH the canonical
  // (`app_settings`) and legacy (`all_settings`) keys in one go, so
  // trade-engine consumers reading `all_settings` boot with populated
  // values without waiting for the operator to hit Save.
  const seed = legacy && Object.keys(legacy).length > 0 ? legacy : getDefaultSettings()
  await setAppSettings(seed)
}

async function seedPredefinedConnections() {
  // In Vercel serverless functions (NEXT_RUNTIME !== "nodejs"), the
  // migrations handle symbol seeding. In Node.js runtimes (dev/local prod),
  // we also ensure symbols are seeded (in case migration didn't run).
  if (process.env.VERCEL === "1" && process.env.NEXT_RUNTIME !== "nodejs") {
    // Migrations handle this in Vercel serverless functions
    return
  }
  try {
    const allConnections = await getAllConnections()
    const { getRedisClient, getSettings } = await import("@/lib/redis-db")
    const client = getRedisClient()

    // Configuration: 20 symbols for BingX (matching migration 040 canonical state)
    const devSymbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "BNBUSDT", "DOGEUSDT", "TRXUSDT", "SHIBUSDT", "LINKUSDT", "LTCUSDT", "MATICUSDT", "AVAXUSDT", "DOTUSDT", "ATOMUSDT", "GALAUSDT", "PEPEUSDT", "WIFUSDT", "JUPUSDT", "POLUSDT"]

    for (const conn of allConnections) {
      if (conn.exchange === "bingx") {
        // Check if force_symbols already exists in ANY location (preserves snapshot values)
        // getSymbols() reads from settings:trade_engine_state:{id} and settings:connection:{id}
        const [existingState, existingConnSettings, existingTradeState] = await Promise.all([
          getSettings(`trade_engine_state:${conn.id}`),
          getSettings(`connection:${conn.id}`),
          client.hgetall(`trade_engine_state:${conn.id}`).catch(() => ({}))
        ])

        const hasExistingSymbols =
          (existingState as any)?.force_symbols || (existingState as any)?.symbols ||
          (existingTradeState as any)?.force_symbols || (existingConnSettings as any)?.force_symbols

        if (!hasExistingSymbols) {
          // Write symbols to BOTH locations:
          // 1. Main connection:{id} hash (where getConnection() reads symbol_count from)
          await client.hset(`connection:${conn.id}`, {
            symbol_count: String(devSymbols.length),
            symbols: JSON.stringify(devSymbols),
            force_symbols: JSON.stringify(devSymbols),
          })

          // 2. trade_engine_state:{id} hash (where getSymbols() reads force_symbols from)
          await client.hset(`trade_engine_state:${conn.id}`, {
            symbols: JSON.stringify(devSymbols),
            force_symbols: JSON.stringify(devSymbols),
            symbol_count: String(devSymbols.length),
          })

          // 3. settings: prefixed hashes (getSettings() adds this prefix)
          await client.hset(`settings:trade_engine_state:${conn.id}`, {
            force_symbols: JSON.stringify(devSymbols),
            symbol_count: String(devSymbols.length),
          })

          await client.hset(`settings:connection:${conn.id}`, {
            force_symbols: JSON.stringify(devSymbols),
            symbol_count: String(devSymbols.length),
          })

          console.log(`[v0] [PreStartup] Seeded ${devSymbols.length} trading symbols for ${conn.id}`)
        }
      }
    }
  } catch (e) {
    console.warn(`[v0] [PreStartup] Warning during symbol seeding (non-fatal): ${e instanceof Error ? e.message : e}`)
  }
}

async function seedMarketData() {
  // Only seed placeholder prices when market data does not already exist.
  // This prevents overwriting real market data that was fetched or restored from snapshot.
  try {
    const { getRedisClient } = await import("@/lib/redis-db")
    const client = getRedisClient()
    // Check if ANY of the target symbols have existing market data
    const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT"]
    const existingKeys = await Promise.all(
      symbols.map(s => client.exists(`market_data:${s}:1s`))
    )
    if (existingKeys.some(Boolean)) {
      console.log("[v0] [PreStartup] seedMarketData: real data present — skipping placeholder seed")
      return
    }
  } catch {
    // If the Redis check fails, fall through and seed anyway
  }

  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT"]
  const basePrices: Record<string, number> = {
    BTCUSDT: 100000,
    ETHUSDT: 3500,
    SOLUSDT: 180,
    XRPUSDT: 0.6,
    ADAUSDT: 0.8,
  }

  // ── Parallel seeding ────────────────────────────────────────────
  // Every (symbol, tick) write is independent. Previously this was a
  // nested for-loop with 6 × 20 = 120 sequential awaits — easily a
  // full second of pointless serialisation on every startup. Fan
  // out everything in a single Promise.all so the placeholder seed
  // lands on Redis as one parallel batch.
  await Promise.all(
    symbols.flatMap((symbol) => {
      const base = basePrices[symbol] ?? 100
      return Array.from({ length: 20 }, (_v, i) => {
        const variation = base * 0.02
        const close = base + (Math.random() - 0.5) * variation
        // Spec §7: pre-startup seeds 1s placeholders so the engine has
        // *something* under the canonical key before the real loader
        // runs. Timestamps step at 1s instead of 60s.
        return saveMarketData(symbol, "1s", {
          symbol,
          exchange: "bingx",
          interval: "1s",
          price: close,
          open: base,
          high: base + variation,
          low: base - variation,
          close,
          volume: Math.random() * 1_000_000,
          timestamp: new Date(Date.now() - (20 - i) * 1_000).toISOString(),
        })
      })
    }),
  )
  console.log("[v0] [PreStartup] seedMarketData: seeded placeholder prices for", symbols.length, "symbols")
}

export async function testAllExchangeConnections() {
  try {
    const allConnections = await getAllConnections()
    const testable = allConnections.filter((c: any) => {
      const inserted = c.is_active_inserted === true || c.is_active_inserted === "true" || c.is_active_inserted === "1"
      const keyOk = typeof c.api_key === "string" && c.api_key.length >= 20 && !c.api_key.includes("PLACEHOLDER")
      const secretOk = typeof c.api_secret === "string" && c.api_secret.length >= 10 && !c.api_secret.includes("PLACEHOLDER")
      return inserted && keyOk && secretOk
    })

    if (testable.length === 0) {
      return { tested: 0, passed: 0, failed: 0 }
    }

    const now = new Date().toISOString()
    for (const connection of testable) {
      await updateConnection(connection.id, {
        last_test_status: "skipped",
        last_test_time: now,
        last_test_message: "Startup connector tests disabled in safe bootstrap mode",
      })
    }

    return { tested: testable.length, passed: 0, failed: 0 }
  } catch {
    return { tested: 0, passed: 0, failed: 0 }
  }
}

export function startPeriodicConnectionTesting() {
  // Disabled in safe bootstrap mode.
}

export function resetPreStartupState(): void {
  preStartupGlobal.__cts_pre_startup_done = false
}

export async function runPreStartup(options: { force?: boolean } = {}): Promise<void> {
  if (!shouldRunPreStartup()) return
  if (options.force && preStartupGlobal.__cts_pre_startup_promise) {
    await preStartupGlobal.__cts_pre_startup_promise.catch(() => undefined)
  }
  if (options.force) preStartupGlobal.__cts_pre_startup_done = false
  if (preStartupGlobal.__cts_pre_startup_done) return
  if (preStartupGlobal.__cts_pre_startup_promise) return preStartupGlobal.__cts_pre_startup_promise

  let promise!: Promise<void>
  promise = (async () => {
    try {
      // initRedis is the single schema-readiness path and already executes all
      // pending migrations. A second direct run here duplicated startup work.
      await initRedis()

      // Settings seeding and market data placeholder seeding must run in ALL modes.
      // On a production cold-start with empty Redis the engine would boot with no
      // settings and no market data at all — both are no-ops when data already exists.
      await initializeDefaultSettings()
      await seedPredefinedConnections()
      await seedMarketData()

      // Connection testing is skipped in safe bootstrap mode (both dev and prod).
      // The engine tests connections lazily when it first ticks.

      // Engine start is intentionally skipped in safe bootstrap mode.
      preStartupGlobal.__cts_pre_startup_done = true
    } catch (error) {
      preStartupGlobal.__cts_pre_startup_done = false
      console.error("[v0] Pre-startup failed:", error)
      throw error
    } finally {
      if (preStartupGlobal.__cts_pre_startup_promise === promise) {
        preStartupGlobal.__cts_pre_startup_promise = null
      }
    }
  })()
  preStartupGlobal.__cts_pre_startup_promise = promise
  return promise
}

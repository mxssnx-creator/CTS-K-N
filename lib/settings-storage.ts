/**
 * File-based settings storage - Edge Runtime compatible
 * Uses in-memory cache with lazy file I/O only in Node.js runtime
 */

let settingsCache: Record<string, any> | null = null

function getDefaultSettings(): Record<string, any> {
  return {
    mainEngineIntervalMs: 700,
    presetEngineIntervalMs: 120000,
    strategyUpdateIntervalMs: 10000,
    realtimeIntervalMs: 300,
    mainEngineEnabled: true,
    presetEngineEnabled: true,
    minimum_connect_interval: 200,
    theme: "dark",
    language: "en",
    notifications_enabled: true,
    // default_leverage is a legacy display field — the engine resolves leverage
    // from the exchange predefinition (getMaxLeverageForExchange) and the
    // useMaximalLeverage / leveragePercentage settings. The value 0 means
    // "use predefinition max"; non-zero values here are informational only.
    default_leverage: 0,
    useMaximalLeverage: true,
    leveragePercentage: 100,
    default_volume: 100,
    max_open_positions: 10,
    max_drawdown_percent: 20,
    daily_loss_limit: 1000,
    main_symbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
    forced_symbols: [],
    database_type: "redis",
    // API Rate Limiting
    restApiDelayMs: 50,
    publicRequestDelayMs: 20,
    privateRequestDelayMs: 100,
    websocketTimeoutMs: 30000,
    // Main Strategy: Max Pseudo Positions
    // Each configuration possibility set can have max 1 pseudo position for long and 1 for short
    // This prevents over-leveraging and ensures controlled position sizing
    strategyMainMaxPseudoPositionsLong: 1,
    strategyMainMaxPseudoPositionsShort: 1,
    // Database Size Limits
    databaseLimitPerSecond: 10000, // 10k operations per second (0 = unlimited)
    databaseLimitPerMinute: 500000, // 500k operations per minute (0 = unlimited)
    databaseLimitPerDay: 0, // Unlimited per day (0 = unlimited)
  }
}

function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && typeof process.cwd === "function" && typeof require !== "undefined"
}

async function getFilePaths() {
  // Use simple string concatenation instead of path module for compatibility
  const cwd = typeof process !== "undefined" && typeof process.cwd === "function" ? process.cwd() : "/tmp"
  const isServerless = typeof process !== "undefined" && (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)
  const basePath = isServerless ? "/tmp/cts-data" : `${cwd}/data`
  const dataDir = basePath
  const settingsFile = `${dataDir}/settings.json`
  return { dataDir, settingsFile }
}

async function readFromDisk(): Promise<Record<string, any> | null> {
  if (!isNodeRuntime()) return null
  try {
    const fs = await import("fs")
    const { dataDir, settingsFile } = await getFilePaths()

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }

    if (!fs.existsSync(settingsFile)) {
      return null
    }

    const data = fs.readFileSync(settingsFile, "utf-8")
    return JSON.parse(data)
  } catch {
    return null
  }
}

async function writeToDisk(settings: Record<string, any>): Promise<void> {
  if (!isNodeRuntime()) return
  try {
    const fs = await import("fs")
    const { dataDir, settingsFile } = await getFilePaths()

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }

    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), "utf-8")
  } catch (error) {
    console.warn("[v0] Could not write settings to disk:", error)
  }
}

export function loadSettings(): Record<string, any> {
  if (settingsCache) {
    return { ...getDefaultSettings(), ...settingsCache }
  }
  return getDefaultSettings()
}

export async function loadSettingsAsync(): Promise<Record<string, any>> {
  if (settingsCache) {
    return { ...getDefaultSettings(), ...settingsCache }
  }

  try {
    const diskSettings = await readFromDisk()
    if (diskSettings) {
      settingsCache = diskSettings
      return { ...getDefaultSettings(), ...diskSettings }
    }
  } catch {
    // Ignore - Edge runtime or other non-Node environment
  }

  return getDefaultSettings()
}

export function saveSettings(settings: Record<string, any>): void {
  settingsCache = { ...settings }

  // Fire-and-forget disk write
  writeToDisk(settings).catch(() => {
    // Ignore disk write errors
  })
}

export { getDefaultSettings }

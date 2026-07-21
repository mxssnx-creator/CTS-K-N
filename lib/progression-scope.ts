const DEFAULT_ENGINE_TYPE = "main"

function safeRedisPart(value: string | undefined | null, fallback: string): string {
  const normalized = String(value || fallback).trim() || fallback
  return normalized.replace(/[^A-Za-z0-9._-]/g, "_")
}

export interface ProgressionScope {
  connectionId: string
  engineType: string
  progressionKey: string
  legacyProgressionKey: string
  prehistoricKey: string
  prehistoricLoadedKey: string
  tradeEngineStateKey: string
  engineProgressionKey: string
}

export interface HistoricProgressState {
  symbolsProcessed: number
  symbolsTotal: number
  isComplete: boolean
  progressPercent: number
}

/**
 * Derive historic completion exclusively from the current basket's measured
 * symbol coverage. A stale `:done` marker or a later pipeline phase from an
 * older generation must never turn 1/5 into 100% while a new QuickStart basket
 * is still loading.
 */
export function calculateHistoricProgress(
  processedValue: unknown,
  totalValue: unknown,
): HistoricProgressState {
  const processedRaw = Number(processedValue)
  const totalRaw = Number(totalValue)
  const symbolsProcessed = Number.isFinite(processedRaw) && processedRaw > 0
    ? Math.floor(processedRaw)
    : 0
  const symbolsTotal = Number.isFinite(totalRaw) && totalRaw > 0
    ? Math.floor(totalRaw)
    : 0
  const boundedProcessed = symbolsTotal > 0
    ? Math.min(symbolsProcessed, symbolsTotal)
    : symbolsProcessed
  const isComplete = symbolsTotal > 0 && boundedProcessed >= symbolsTotal
  const progressPercent = symbolsTotal > 0
    ? Math.min(100, Math.round((boundedProcessed / symbolsTotal) * 100))
    : 0

  return {
    symbolsProcessed: boundedProcessed,
    symbolsTotal,
    isComplete,
    progressPercent,
  }
}

export function buildProgressionScope(connectionId: string, engineType = DEFAULT_ENGINE_TYPE): ProgressionScope {
  const safeConnectionId = safeRedisPart(connectionId, connectionId)
  const safeEngineType = safeRedisPart(engineType, DEFAULT_ENGINE_TYPE)

  return {
    connectionId: safeConnectionId,
    engineType: safeEngineType,
    progressionKey: `progression:${safeConnectionId}:${safeEngineType}`,
    legacyProgressionKey: `progression:${safeConnectionId}`,
    prehistoricKey: `prehistoric:${safeConnectionId}:${safeEngineType}`,
    prehistoricLoadedKey: `prehistoric_loaded:${safeConnectionId}:${safeEngineType}`,
    tradeEngineStateKey: `settings:trade_engine_state:${safeConnectionId}:${safeEngineType}`,
    engineProgressionKey: `engine_progression:${safeConnectionId}:${safeEngineType}`,
  }
}

/**
 * Return progression hashes in runtime-authority order.
 *
 * Long-lived managers write the engine-scoped hash. The Cloudflare/Kilo
 * scheduled pipeline still runs the shared Indication/Realtime/Strategy
 * processors, whose atomic counters live in the legacy connection hash. A
 * request route that always preferred an older scoped hash therefore showed
 * 0/N and zero cycles while the bounded owner was actively processing.
 */
export function progressionReadKeys(scope: ProgressionScope): string[] {
  const scheduledBoundedOwner =
    process.env.DISABLE_TRADE_ENGINE_IN_PROCESS === "1" &&
    String(process.env.DEPLOYMENT_CRON_MODE || "").toLowerCase() === "cloudflare-scheduled"
  return scheduledBoundedOwner
    ? [scope.legacyProgressionKey, scope.progressionKey]
    : [scope.progressionKey, scope.legacyProgressionKey]
}

/**
 * Canonical engine-scoped historic gate plus the one-release legacy mirror.
 * Writers update both; readers prefer `scoped` and fall back to `legacy` so a
 * rolling deploy cannot strand old or new workers on opposite key names.
 */
export function buildPrehistoricGateKeys(
  connectionId: string,
  engineType = DEFAULT_ENGINE_TYPE,
  gate: "done" | "firstpass:done" = "done",
): { scoped: string; legacy: string } {
  const scope = buildProgressionScope(connectionId, engineType)
  return {
    scoped: `${scope.prehistoricKey}:${gate}`,
    legacy: `${scope.legacyProgressionKey.replace(/^progression:/, "prehistoric:")}:${gate}`,
  }
}

export async function ensureScopedProgressionFromLegacy(
  client: any,
  connectionId: string,
  engineType = DEFAULT_ENGINE_TYPE,
): Promise<ProgressionScope> {
  const scope = buildProgressionScope(connectionId, engineType)
  if (!client || scope.engineType !== DEFAULT_ENGINE_TYPE) return scope

  try {
    const scoped = await client.hgetall(scope.progressionKey).catch(() => null)
    if (scoped && Object.keys(scoped).length > 0) return scope

    const legacy = await client.hgetall(scope.legacyProgressionKey).catch(() => null)
    if (legacy && Object.keys(legacy).length > 0) {
      const migrated: Record<string, string> = {}
      for (const [key, value] of Object.entries(legacy)) migrated[key] = String(value)
      migrated.connection_id = scope.connectionId
      migrated.engine_type = scope.engineType
      migrated.migrated_from_unscoped = "true"
      migrated.migrated_at = new Date().toISOString()
      await client.hset(scope.progressionKey, migrated)
    }
  } catch (error) {
    console.warn(`[ProgressionScope] Failed legacy progression migration for ${connectionId}:`, error)
  }

  return scope
}

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

export const DIRECT_TRADE_CONNECTION_INDEX_KEY = "direct_trade:connections"

export function normalizeDirectTradeConnectionId(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : ""
  if (!normalized || normalized.length > 160) return null
  return normalized
}

function namespace(connectionId?: string | null): string {
  const normalized = normalizeDirectTradeConnectionId(connectionId)
  return normalized
    ? `direct_trade:connection:${encodeURIComponent(normalized)}`
    : "direct_trade"
}

export interface DirectTradeKeyspace {
  connectionId: string | null
  namespace: string
  state: string
  executionConfigs: string
  stats: string
  positions: string
  processor: string
  processorHeartbeat: string
  processorLease: string
  configStatus: string
  configPerformance: string
  calculation: string
  calculationProgress: string
  calculationLease: string
  statisticsIndex: string
  openPositionStage: string
  configs: string
  configManifest: string
  executionIndex: string
  executionSignalIndex: string
  activeSignals: string
  recoveryRequest: string
}

/**
 * Return the complete Direct-Trade Redis namespace for one exchange
 * connection. A null id intentionally preserves the former keys so old
 * snapshots and isolated test harnesses remain readable during migration.
 */
export function directTradeKeyspace(connectionId?: string | null): DirectTradeKeyspace {
  const normalized = normalizeDirectTradeConnectionId(connectionId)
  const prefix = namespace(normalized)
  return {
    connectionId: normalized,
    namespace: prefix,
    state: `${prefix}:state`,
    executionConfigs: `${prefix}:execution-configs`,
    stats: `${prefix}:stats`,
    positions: `${prefix}:positions`,
    processor: `${prefix}:processor`,
    processorHeartbeat: `${prefix}:processor:heartbeat`,
    processorLease: `${prefix}:processor:lease`,
    configStatus: `${prefix}:config-status`,
    configPerformance: `${prefix}:config-performance`,
    calculation: `${prefix}:calculation`,
    calculationProgress: `${prefix}:calculation-progress`,
    calculationLease: `${prefix}:calculation:lease`,
    statisticsIndex: `${prefix}:statistics-index`,
    openPositionStage: `${prefix}:open-position-stage`,
    configs: `${prefix}:configs`,
    configManifest: `${prefix}:configs:manifest`,
    executionIndex: `${prefix}:execution-index`,
    executionSignalIndex: `${prefix}:execution-signal-index`,
    activeSignals: `${prefix}:active-signals`,
    recoveryRequest: `${prefix}:processor:recovery-request`,
  }
}

export function directTradeConfigChunkKeyForScope(
  generation: string,
  index: number,
  connectionId?: string | null,
): string {
  return `${namespace(connectionId)}:configs:chunk:${generation}:${index}`
}

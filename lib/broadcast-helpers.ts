/**
 * Broadcast Helpers
 * Convenience functions for engines to broadcast updates via SSE
 */

import { getBroadcaster } from './event-broadcaster'

/**
 * Emit a position update to all connected clients
 */
export function emitPositionUpdate(connectionId: string, position: any) {
  try {
    const broadcaster = getBroadcaster()
    broadcaster.broadcastPositionUpdate(connectionId, {
      id: position.id,
      symbol: position.symbol,
      currentPrice: position.currentPrice,
      unrealizedPnl: position.unrealizedPnl,
      unrealizedPnlPercent: position.unrealizedPnlPercent,
      status: position.status || 'open',
      updatedAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[broadcastHelpers] Error emitting position update:', error)
  }
}

/**
 * Emit a strategy update to all connected clients
 */
export function emitStrategyUpdate(connectionId: string, strategy: any) {
  try {
    const broadcaster = getBroadcaster()
    broadcaster.broadcastStrategyUpdate(connectionId, {
      id: strategy.id,
      symbol: strategy.symbol,
      profit_factor: strategy.profit_factor || 0,
      win_rate: strategy.win_rate || 0,
      active_positions: strategy.active_positions || 0,
      updatedAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[broadcastHelpers] Error emitting strategy update:', error)
  }
}

/**
 * Emit an indication update to all connected clients
 */
export function emitIndicationUpdate(connectionId: string, indication: any) {
  try {
    const broadcaster = getBroadcaster()
    broadcaster.broadcastIndicationUpdate(connectionId, {
      id: indication.id,
      symbol: indication.symbol,
      direction: indication.direction || 'NEUTRAL',
      confidence: indication.confidence || 0,
      strength: indication.strength || 0,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[broadcastHelpers] Error emitting indication update:', error)
  }
}

/**
 * Emit processing progress to all connected clients
 */
export function emitProcessingProgress(
  connectionId: string,
  phase: 'prehistoric' | 'realtime' | 'strategy' | 'indication',
  progress: number,
  itemsProcessed: number,
  totalItems: number,
  currentTimeframe?: string,
) {
  try {
    const broadcaster = getBroadcaster()
    broadcaster.broadcastProcessingProgress(connectionId, {
      phase,
      progress: Math.min(100, Math.max(0, progress)),
      itemsProcessed,
      totalItems,
      currentTimeframe: currentTimeframe || '1m',
      estimatedTimeRemaining: totalItems > 0 ? Math.ceil((totalItems - itemsProcessed) * 0.1) : 0,
    })
  } catch (error) {
    console.error('[broadcastHelpers] Error emitting processing progress:', error)
  }
}

/**
 * Emit engine status to all connected clients
 */
export function emitEngineStatus(
  connectionId: string,
  state: 'idle' | 'loading' | 'processing' | 'trading' | 'error',
  activeProcesses: string[] = [],
  cycleCount: number = 0,
  errorCount: number = 0,
) {
  try {
    const broadcaster = getBroadcaster()
    broadcaster.broadcastEngineStatus(connectionId, {
      state,
      activeProcesses,
      lastUpdate: new Date().toISOString(),
      cycleCount,
      errorCount,
    })
  } catch (error) {
    console.error('[broadcastHelpers] Error emitting engine status:', error)
  }
}

/**
 * Get broadcaster stats for monitoring
 */
export function getBroadcasterStats() {
  try {
    const broadcaster = getBroadcaster()
    return broadcaster.getStats()
  } catch (error) {
    console.error('[broadcastHelpers] Error getting broadcaster stats:', error)
    return {
      totalConnections: 0,
      totalClients: 0,
      connectionStats: {},
      historySize: 0,
    }
  }
}

/**
 * Coordination Metrics
 * Tracks performance metrics across all trade engines
 */

interface EngineMetrics {
  connectionId: string
  symbolsProcessed: number
  indicationsGenerated: number
  strategiesExecuted: number
  positionsOpened: number
  averageProcessingTime: number
  lastUpdateTime: number
}

export class CoordinationMetrics {
  private static instance: CoordinationMetrics
  private metrics: Map<string, EngineMetrics> = new Map()

  private constructor() {}

  static getInstance(): CoordinationMetrics {
    if (!CoordinationMetrics.instance) {
      CoordinationMetrics.instance = new CoordinationMetrics()
    }
    return CoordinationMetrics.instance
  }

  /**
   * Record symbol processing
   */
  recordSymbolProcessing(connectionId: string, processingTime: number): void {
    const metrics = this.getOrCreateMetrics(connectionId)
    metrics.symbolsProcessed++
    this.updateAverageProcessingTime(metrics, processingTime)
    metrics.lastUpdateTime = Date.now()
  }

  /**
   * Record indication generation
   */
  recordIndicationGeneration(connectionId: string, count = 1): void {
    const metrics = this.getOrCreateMetrics(connectionId)
    metrics.indicationsGenerated += count
    metrics.lastUpdateTime = Date.now()
  }

  /**
   * Record strategy execution
   */
  recordStrategyExecution(connectionId: string, count = 1): void {
    const metrics = this.getOrCreateMetrics(connectionId)
    metrics.strategiesExecuted += count
    metrics.lastUpdateTime = Date.now()
  }

  /**
   * Record position opening
   */
  recordPositionOpening(connectionId: string): void {
    const metrics = this.getOrCreateMetrics(connectionId)
    metrics.positionsOpened++
    metrics.lastUpdateTime = Date.now()
  }

  /**
   * Get metrics for connection
   */
  getMetrics(connectionId: string): EngineMetrics | null {
    return this.metrics.get(connectionId) || null
  }

  /**
   * Get all metrics
   */
  getAllMetrics(): EngineMetrics[] {
    return Array.from(this.metrics.values())
  }

  /**
   * Get aggregated metrics
   */
  getAggregatedMetrics(): {
    totalSymbolsProcessed: number
    totalIndicationsGenerated: number
    totalStrategiesExecuted: number
    totalPositionsOpened: number
    averageProcessingTime: number
    activeEngines: number
  } {
    const allMetrics = this.getAllMetrics()

    return {
      totalSymbolsProcessed: allMetrics.reduce((sum, m) => sum + m.symbolsProcessed, 0),
      totalIndicationsGenerated: allMetrics.reduce((sum, m) => sum + m.indicationsGenerated, 0),
      totalStrategiesExecuted: allMetrics.reduce((sum, m) => sum + m.strategiesExecuted, 0),
      totalPositionsOpened: allMetrics.reduce((sum, m) => sum + m.positionsOpened, 0),
      averageProcessingTime: allMetrics.reduce((sum, m) => sum + m.averageProcessingTime, 0) / (allMetrics.length || 1),
      activeEngines: allMetrics.length,
    }
  }

  /**
   * Reset metrics for connection
   */
  resetMetrics(connectionId: string): void {
    this.metrics.delete(connectionId)
  }

  /**
   * Clear all metrics
   */
  clearAllMetrics(): void {
    this.metrics.clear()
  }

  /**
   * Get or create metrics for connection
   */
  private getOrCreateMetrics(connectionId: string): EngineMetrics {
    let metrics = this.metrics.get(connectionId)

    if (!metrics) {
      metrics = {
        connectionId,
        symbolsProcessed: 0,
        indicationsGenerated: 0,
        strategiesExecuted: 0,
        positionsOpened: 0,
        averageProcessingTime: 0,
        lastUpdateTime: Date.now(),
      }
      this.metrics.set(connectionId, metrics)
    }

    return metrics
  }

  /**
   * Update average processing time
   */
  private updateAverageProcessingTime(metrics: EngineMetrics, newTime: number): void {
    const currentAverage = metrics.averageProcessingTime
    const count = metrics.symbolsProcessed

    // Calculate new average: (old_avg * (n-1) + new_value) / n
    metrics.averageProcessingTime = (currentAverage * (count - 1) + newTime) / count
  }
}

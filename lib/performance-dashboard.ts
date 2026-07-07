/**
 * Performance Dashboard & Visualization
 * 
 * Generates performance metrics and dashboards
 * Tracks system health, trends, and anomalies
 */

import { metricsCollector } from './metrics-collector'
import { healthCheckService } from './health-check'
import { circuitBreakerRegistry } from './circuit-breaker'
import { dbMetrics } from './database-metrics'

export interface DashboardMetrics {
  timestamp: Date
  system: {
    uptime: number
    memoryUsage: number
    cpuUsage: number
    errorRate: number
  }
  performance: {
    avgResponseTime: number
    p95ResponseTime: number
    p99ResponseTime: number
    requestsPerSecond: number
  }
  database: {
    operationCount: number
    errorCount: number
    slowQueryCount: number
    health: string
  }
  services: {
    exchange: { state: string; successRate: string }
    database: { state: string; successRate: string }
    cache: { state: string; successRate: string }
  }
  alerts: {
    critical: number
    warning: number
    info: number
  }
}

/**
 * Performance Dashboard Manager
 */
export class PerformanceDashboard {
  private metricsHistory: DashboardMetrics[] = []
  private maxHistorySize = 1440 // 24 hours @ 1-minute intervals
  private updateInterval: ReturnType<typeof setInterval> | null = null

  constructor() {
    console.log('[DASHBOARD] Performance dashboard initialized')
  }

  /**
   * Collect dashboard metrics
   */
  async collectMetrics(): Promise<DashboardMetrics> {
    const health = await healthCheckService.getHealthReport()
    const systemStats = healthCheckService.getSystemStats()
    const dbHealth = dbMetrics.getHealth()
    const circuitBreakerMetrics = circuitBreakerRegistry.getAllMetrics()

    const metrics: DashboardMetrics = {
      timestamp: new Date(),
      system: {
        uptime: systemStats.uptime / 1000, // Convert to seconds
        memoryUsage: (systemStats.memory.heapUsed / systemStats.memory.heapTotal) * 100,
        cpuUsage: 0, // Would need process monitoring
        errorRate: (dbHealth.errorCount / dbHealth.operationCount) * 100 || 0
      },
      performance: {
        avgResponseTime: dbHealth.avgResponseTime,
        p95ResponseTime: dbHealth.p95ResponseTime,
        p99ResponseTime: dbHealth.p99ResponseTime,
        requestsPerSecond: dbHealth.operationCount / 60 // Approximate
      },
      database: {
        operationCount: dbHealth.operationCount,
        errorCount: dbHealth.errorCount,
        slowQueryCount: dbHealth.slowQueryCount,
        health: dbHealth.health
      },
      services: {
        exchange: {
          state: circuitBreakerMetrics.exchange?.state || 'unknown',
          successRate: `${circuitBreakerMetrics.exchange ? circuitBreakerMetrics.exchange.totalSuccesses / circuitBreakerMetrics.exchange.totalRequests * 100 : 0}%`
        },
        database: {
          state: circuitBreakerMetrics.database?.state || 'unknown',
          successRate: `${circuitBreakerMetrics.database ? circuitBreakerMetrics.database.totalSuccesses / circuitBreakerMetrics.database.totalRequests * 100 : 0}%`
        },
        cache: {
          state: circuitBreakerMetrics.cache?.state || 'unknown',
          successRate: `${circuitBreakerMetrics.cache ? circuitBreakerMetrics.cache.totalSuccesses / circuitBreakerMetrics.cache.totalRequests * 100 : 0}%`
        }
      },
      alerts: {
        critical: health.status === 'unhealthy' ? 1 : 0,
        warning: health.status === 'degraded' ? 1 : 0,
        info: 0
      }
    }

    this.metricsHistory.push(metrics)
    if (this.metricsHistory.length > this.maxHistorySize) {
      this.metricsHistory.shift()
    }

    return metrics
  }

  /**
   * Start periodic collection
   */
  startPeriodicCollection(intervalMs: number = 60000): void {
    if (this.updateInterval) {
      console.log('[DASHBOARD] Collection already running')
      return
    }

    console.log(`[DASHBOARD] Starting periodic collection every ${intervalMs}ms`)
    this.updateInterval = setInterval(async () => {
      try {
        await this.collectMetrics()
      } catch (error) {
        console.error('[DASHBOARD] Collection error:', error)
      }
    }, intervalMs)

    this.updateInterval.unref()
  }

  /**
   * Stop periodic collection
   */
  stopPeriodicCollection(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval)
      this.updateInterval = null
      console.log('[DASHBOARD] Periodic collection stopped')
    }
  }

  /**
   * Get current metrics
   */
  getCurrentMetrics(): DashboardMetrics | null {
    return this.metricsHistory.length > 0 
      ? this.metricsHistory[this.metricsHistory.length - 1] 
      : null
  }

  /**
   * Get historical metrics
   */
  getHistoricalMetrics(minutes: number = 60): DashboardMetrics[] {
    const cutoff = Date.now() - (minutes * 60 * 1000)
    return this.metricsHistory.filter(m => m.timestamp.getTime() >= cutoff)
  }

  /**
   * Analyze trends
   */
  analyzeTrends(windowMinutes: number = 60): {
    memoryTrend: 'stable' | 'increasing' | 'decreasing'
    errorTrend: 'stable' | 'increasing' | 'decreasing'
    performanceTrend: 'stable' | 'improving' | 'degrading'
    anomalies: string[]
  } {
    const recent = this.getHistoricalMetrics(windowMinutes)
    if (recent.length < 2) {
      return {
        memoryTrend: 'stable',
        errorTrend: 'stable',
        performanceTrend: 'stable',
        anomalies: []
      }
    }

    const first = recent[0]
    const last = recent[recent.length - 1]

    // Calculate trends
    const memoryChange = last.system.memoryUsage - first.system.memoryUsage
    const errorChange = last.system.errorRate - first.system.errorRate
    const perfChange = last.performance.avgResponseTime - first.performance.avgResponseTime

    const anomalies: string[] = []

    // Detect anomalies
    if (last.system.memoryUsage > 85) {
      anomalies.push(`High memory usage: ${last.system.memoryUsage.toFixed(1)}%`)
    }
    if (last.system.errorRate > 5) {
      anomalies.push(`High error rate: ${last.system.errorRate.toFixed(2)}%`)
    }
    if (last.performance.avgResponseTime > 1000) {
      anomalies.push(`High response time: ${last.performance.avgResponseTime.toFixed(0)}ms`)
    }

    return {
      memoryTrend: memoryChange > 2 ? 'increasing' : memoryChange < -2 ? 'decreasing' : 'stable',
      errorTrend: errorChange > 1 ? 'increasing' : errorChange < -1 ? 'decreasing' : 'stable',
      performanceTrend: perfChange > 50 ? 'degrading' : perfChange < -50 ? 'improving' : 'stable',
      anomalies
    }
  }

  /**
   * Export JSON for visualization
   */
  exportJSON(): {
    current: DashboardMetrics | null
    history: DashboardMetrics[]
    trends: any
    summary: {
      totalMetrics: number
      lastUpdate: Date | null
    }
  } {
    return {
      current: this.getCurrentMetrics(),
      history: this.getHistoricalMetrics(),
      trends: this.analyzeTrends(),
      summary: {
        totalMetrics: this.metricsHistory.length,
        lastUpdate: this.metricsHistory.length > 0 
          ? this.metricsHistory[this.metricsHistory.length - 1].timestamp 
          : null
      }
    }
  }

  /**
   * Generate HTML dashboard
   */
  generateHTML(): string {
    const current = this.getCurrentMetrics()
    if (!current) {
      return '<h1>No metrics available</h1>'
    }

    const trends = this.analyzeTrends()

    return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Performance Dashboard</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 20px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { background: #fff; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 20px; }
        .card { background: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .card h3 { margin: 0 0 10px 0; font-size: 14px; color: #666; text-transform: uppercase; }
        .card .value { font-size: 32px; font-weight: bold; color: #333; }
        .card .unit { font-size: 14px; color: #999; margin-left: 5px; }
        .health { padding: 5px 10px; border-radius: 4px; font-size: 12px; font-weight: bold; }
        .health.healthy { background: #10b981; color: white; }
        .health.degraded { background: #f59e0b; color: white; }
        .health.critical { background: #ef4444; color: white; }
        .trend { font-size: 14px; color: #666; margin-top: 10px; }
        .anomalies { background: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .anomaly { padding: 10px; margin: 5px 0; background: #fee2e2; border-left: 4px solid #ef4444; border-radius: 4px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Performance Dashboard</h1>
          <p>Last updated: ${current.timestamp.toLocaleTimeString()}</p>
        </div>
        
        <div class="grid">
          <div class="card">
            <h3>System Uptime</h3>
            <div class="value">${(current.system.uptime / 3600).toFixed(1)}<span class="unit">h</span></div>
          </div>
          
          <div class="card">
            <h3>Memory Usage</h3>
            <div class="value">${current.system.memoryUsage.toFixed(1)}<span class="unit">%</span></div>
            <div class="trend">Trend: ${trends.memoryTrend}</div>
          </div>
          
          <div class="card">
            <h3>Error Rate</h3>
            <div class="value">${current.system.errorRate.toFixed(2)}<span class="unit">%</span></div>
            <div class="trend">Trend: ${trends.errorTrend}</div>
          </div>
          
          <div class="card">
            <h3>Avg Response Time</h3>
            <div class="value">${current.performance.avgResponseTime.toFixed(0)}<span class="unit">ms</span></div>
            <div class="trend">Trend: ${trends.performanceTrend}</div>
          </div>
          
          <div class="card">
            <h3>P95 Response Time</h3>
            <div class="value">${current.performance.p95ResponseTime.toFixed(0)}<span class="unit">ms</span></div>
          </div>
          
          <div class="card">
            <h3>Database Health</h3>
            <div class="health ${current.database.health}">${current.database.health.toUpperCase()}</div>
          </div>
          
          <div class="card">
            <h3>Exchange Service</h3>
            <div class="health ${current.services.exchange.state === 'closed' ? 'healthy' : current.services.exchange.state === 'half-open' ? 'degraded' : 'critical'}">${current.services.exchange.state.toUpperCase()}</div>
            <div class="trend">Success: ${current.services.exchange.successRate}</div>
          </div>
          
          <div class="card">
            <h3>Cache Health</h3>
            <div class="health ${current.services.cache.state === 'closed' ? 'healthy' : current.services.cache.state === 'half-open' ? 'degraded' : 'critical'}">${current.services.cache.state.toUpperCase()}</div>
            <div class="trend">Success: ${current.services.cache.successRate}</div>
          </div>
        </div>
        
        ${trends.anomalies.length > 0 ? `
          <div class="anomalies">
            <h2>⚠️ Detected Anomalies</h2>
            ${trends.anomalies.map(a => `<div class="anomaly">${a}</div>`).join('')}
          </div>
        ` : ''}
      </div>
    </body>
    </html>
    `
  }
}

// Export singleton
export const performanceDashboard = new PerformanceDashboard()

export default PerformanceDashboard

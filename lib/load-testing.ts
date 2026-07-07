/**
 * Load Testing & Performance Baseline
 * 
 * Generates synthetic load to establish performance baseline
 * Identifies bottlenecks and capacity limits
 */

import { metricsCollector, MetricType } from './metrics-collector'
import { dbMetrics } from './database-metrics'

export interface LoadTestConfig {
  duration: number // seconds
  concurrency: number
  requestsPerSecond: number
  operationMix: {
    read: number
    write: number
    delete: number
  }
}

export interface LoadTestResult {
  testId: string
  config: LoadTestConfig
  duration: number
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  avgResponseTime: number
  p95ResponseTime: number
  p99ResponseTime: number
  maxResponseTime: number
  throughput: number
  errorRate: number
  health: 'passed' | 'warning' | 'failed'
}

/**
 * Load Testing Manager
 */
export class LoadTester {
  private results: LoadTestResult[] = []
  private baseline: LoadTestResult | null = null

  constructor() {
    this.registerMetrics()
  }

  /**
   * Register load testing metrics
   */
  private registerMetrics(): void {
    metricsCollector.registerMetric({
      name: 'load_test_total_requests',
      type: MetricType.COUNTER,
      help: 'Total requests in load test'
    })

    metricsCollector.registerMetric({
      name: 'load_test_failed_requests',
      type: MetricType.COUNTER,
      help: 'Failed requests in load test'
    })

    metricsCollector.registerMetric({
      name: 'load_test_duration_seconds',
      type: MetricType.HISTOGRAM,
      help: 'Load test duration'
    })

    metricsCollector.registerMetric({
      name: 'load_test_throughput',
      type: MetricType.GAUGE,
      help: 'Requests per second during load test'
    })
  }

  /**
   * Run load test
   */
  async runLoadTest(config: LoadTestConfig): Promise<LoadTestResult> {
    const testId = `load-test-${Date.now()}`
    const startTime = Date.now()
    const operations: Array<{ duration: number; success: boolean }> = []

    console.log(`[LOAD_TEST] Starting ${testId}`)
    console.log(`[LOAD_TEST] Config: ${config.concurrency} concurrent, ${config.requestsPerSecond} req/s for ${config.duration}s`)

    try {
      // Simulate load
      const targetRequests = Math.ceil(config.requestsPerSecond * config.duration)
      let completed = 0
      let successful = 0
      let failed = 0

      // Generate synthetic operations
      const operationTypes = this.generateOperationSequence(targetRequests, config.operationMix)

      // Execute operations with concurrency limit
      const chunkSize = config.concurrency
      for (let i = 0; i < operationTypes.length; i += chunkSize) {
        const chunk = operationTypes.slice(i, i + chunkSize)
        const promises = chunk.map(async (op) => {
          const opStart = Date.now()
          try {
            // Simulate operation
            await this.simulateOperation(op)
            const duration = Date.now() - opStart
            operations.push({ duration, success: true })
            successful++
          } catch (error) {
            const duration = Date.now() - opStart
            operations.push({ duration, success: false })
            failed++
          }
          completed++

          // Rate limiting
          const elapsed = Date.now() - startTime
          const expectedCompleted = (elapsed / 1000) * config.requestsPerSecond
          if (completed > expectedCompleted) {
            const sleepMs = Math.ceil((completed - expectedCompleted) / config.requestsPerSecond * 1000)
            await new Promise(r => setTimeout(r, sleepMs))
          }
        })

        await Promise.allSettled(promises)

        if (Date.now() - startTime > config.duration * 1000) {
          break
        }
      }

      const duration = Date.now() - startTime
      const responseTimes = operations.map(o => o.duration).sort((a, b) => a - b)
      const p95Index = Math.floor(responseTimes.length * 0.95)
      const p99Index = Math.floor(responseTimes.length * 0.99)

      const result: LoadTestResult = {
        testId,
        config,
        duration,
        totalRequests: operations.length,
        successfulRequests: successful,
        failedRequests: failed,
        avgResponseTime: operations.length > 0 
          ? operations.reduce((sum, o) => sum + o.duration, 0) / operations.length 
          : 0,
        p95ResponseTime: responseTimes[p95Index] || 0,
        p99ResponseTime: responseTimes[p99Index] || 0,
        maxResponseTime: Math.max(...responseTimes, 0),
        throughput: (operations.length / (duration / 1000)),
        errorRate: (failed / operations.length) * 100,
        health: this.evaluateHealth(failed, operations.length, responseTimes)
      }

      this.results.push(result)
      metricsCollector.incrementCounter('load_test_total_requests', result.totalRequests)
      metricsCollector.incrementCounter('load_test_failed_requests', result.failedRequests)
      metricsCollector.observeHistogram('load_test_duration_seconds', duration / 1000)
      metricsCollector.setGauge('load_test_throughput', result.throughput)

      console.log(`[LOAD_TEST] Completed ${testId}`)
      console.log(`[LOAD_TEST] Results: ${result.totalRequests} requests, ${result.successfulRequests} successful, ${result.failedRequests} failed`)
      console.log(`[LOAD_TEST] Throughput: ${result.throughput.toFixed(2)} req/s`)
      console.log(`[LOAD_TEST] Response times - Avg: ${result.avgResponseTime.toFixed(0)}ms, P95: ${result.p95ResponseTime.toFixed(0)}ms, P99: ${result.p99ResponseTime.toFixed(0)}ms`)

      return result
    } catch (error) {
      console.error(`[LOAD_TEST] Test failed:`, error)
      throw error
    }
  }

  /**
   * Generate operation sequence
   */
  private generateOperationSequence(count: number, mix: { read: number; write: number; delete: number }): string[] {
    const total = mix.read + mix.write + mix.delete
    const operations: string[] = []

    for (let i = 0; i < count; i++) {
      const rand = Math.random() * total
      if (rand < mix.read) {
        operations.push('read')
      } else if (rand < mix.read + mix.write) {
        operations.push('write')
      } else {
        operations.push('delete')
      }
    }

    return operations
  }

  /**
   * Simulate operation
   */
  private async simulateOperation(operation: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Simulate varying response times
      const baseTime = Math.random() * 50
      const variance = Math.random() * 20
      const delay = baseTime + variance

      const timeout = setTimeout(() => {
        if (Math.random() > 0.95) { // 5% failure rate
          reject(new Error('Simulated failure'))
        } else {
          resolve()
        }
      }, delay)

      // Simulate timeout errors occasionally
      if (Math.random() > 0.98) {
        clearTimeout(timeout)
        reject(new Error('Simulated timeout'))
      }
    })
  }

  /**
   * Evaluate health
   */
  private evaluateHealth(failures: number, total: number, responseTimes: number[]): 'passed' | 'warning' | 'failed' {
    const errorRate = (failures / total) * 100
    const avgTime = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length

    if (errorRate > 5 || avgTime > 1000) {
      return 'failed'
    } else if (errorRate > 1 || avgTime > 500) {
      return 'warning'
    }
    return 'passed'
  }

  /**
   * Establish baseline
   */
  async establishBaseline(): Promise<LoadTestResult> {
    const config: LoadTestConfig = {
      duration: 60,
      concurrency: 10,
      requestsPerSecond: 100,
      operationMix: { read: 70, write: 25, delete: 5 }
    }

    this.baseline = await this.runLoadTest(config)
    console.log(`[LOAD_TEST] Baseline established`)
    return this.baseline
  }

  /**
   * Compare to baseline
   */
  compareToBaseline(result: LoadTestResult): {
    passed: boolean
    througputDiff: number
    latencyDiff: number
    errorDiff: number
  } | null {
    if (!this.baseline) {
      return null
    }

    return {
      passed: result.throughput >= this.baseline.throughput * 0.9 &&
              result.avgResponseTime <= this.baseline.avgResponseTime * 1.1,
      througputDiff: ((result.throughput - this.baseline.throughput) / this.baseline.throughput) * 100,
      latencyDiff: ((result.avgResponseTime - this.baseline.avgResponseTime) / this.baseline.avgResponseTime) * 100,
      errorDiff: result.errorRate - this.baseline.errorRate
    }
  }

  /**
   * Get results
   */
  getResults(): LoadTestResult[] {
    return this.results
  }

  /**
   * Get baseline
   */
  getBaseline(): LoadTestResult | null {
    return this.baseline
  }

  /**
   * Export summary
   */
  exportSummary(): {
    baseline: LoadTestResult | null
    lastTest: LoadTestResult | null
    comparison: any
    allResults: LoadTestResult[]
  } {
    const lastTest = this.results.length > 0 ? this.results[this.results.length - 1] : null
    return {
      baseline: this.baseline,
      lastTest,
      comparison: lastTest ? this.compareToBaseline(lastTest) : null,
      allResults: this.results
    }
  }
}

// Export singleton
export const loadTester = new LoadTester()

export default LoadTester

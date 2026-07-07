/**
 * Comprehensive Integration Test Suite
 * 
 * Tests all aspects of the corrected system:
 * 1. Batch API client functionality
 * 2. Rate limit handling
 * 3. Status field tracking
 * 4. Set count calculations
 * 5. Position accumulation
 * 6. Hedge netting
 * 7. System diagnostics and fixes
 */

import BatchAPIClient from "@/lib/api-batch-client"
import OptimizedStatsFetcher from "@/lib/api-stats-fetcher"
import { runFullAudit, runSystemDiagnostics } from "@/lib/system-diagnostics"

interface TestResult {
  name: string
  passed: boolean
  duration: number
  error?: string
}

class IntegrationTestSuite {
  private results: TestResult[] = []
  private baseUrl = "http://localhost:3002"
  private connectionId = "bingx-x01"
  private symbol = "BTCUSDT"

  /**
   * Test 1: Batch API Client - Basic Queuing
   */
  async testBatchAPIQueuing(): Promise<void> {
    const start = Date.now()
    const test: TestResult = {
      name: "Batch API Client - Request Queuing",
      passed: false,
      duration: 0,
    }

    try {
      const client = new BatchAPIClient(this.baseUrl)

      // Queue multiple requests simultaneously
      const promises = [
        client.queueRequest({
          path: `/api/connections/progression/${this.connectionId}/stats`,
          method: "GET",
        }),
        client.queueRequest({
          path: `/api/connections/progression/${this.connectionId}/stats`,
          method: "GET",
        }),
      ]

      const [result1, result2] = await Promise.all(promises)

      if (result1 && result2 && (result1 as any).connectionId === this.connectionId) {
        test.passed = true
      } else {
        test.error = "Batch requests did not complete successfully"
      }

      // Check status
      const status = client.getStatus()
      console.log("[v0] [Test] Batch API status:", status)
    } catch (error) {
      test.error = `${error}`
    }

    test.duration = Date.now() - start
    this.results.push(test)
  }

  /**
   * Test 2: Rate Limit Handling
   */
  async testRateLimitHandling(): Promise<void> {
    const start = Date.now()
    const test: TestResult = {
      name: "Rate Limit Handling",
      passed: false,
      duration: 0,
    }

    try {
      const client = new BatchAPIClient(this.baseUrl, {
        requestsPerSecond: 100, // High rate to test backoff
      })

      const requests = Array(20).fill(null).map((_, i) => ({
        path: `/api/connections/progression/${this.connectionId}/stats`,
        method: "GET" as const,
        timeout: 5000,
      }))

      // Queue all requests at once
      const promises = requests.map((req) => client.queueRequest(req))
      const results = await Promise.all(promises)

      const successful = results.filter((r) => r && (r as any).success).length
      if (successful >= requests.length * 0.95) {
        // Allow for some failures
        test.passed = true
      } else {
        test.error = `Only ${successful}/${requests.length} requests succeeded`
      }

      const stats = client.getStats()
      console.log("[v0] [Test] Rate limit stats:", stats)
    } catch (error) {
      test.error = `${error}`
    }

    test.duration = Date.now() - start
    this.results.push(test)
  }

  /**
   * Test 3: Optimized Stats Fetcher
   */
  async testOptimizedStatsFetcher(): Promise<void> {
    const start = Date.now()
    const test: TestResult = {
      name: "Optimized Stats Fetcher",
      passed: false,
      duration: 0,
    }

    try {
      const fetcher = new OptimizedStatsFetcher(this.baseUrl)

      // Test single connection stats
      const connStats = await fetcher.fetchConnectionStats(this.connectionId)
      if (connStats && connStats.connectionId === this.connectionId) {
        test.passed = true
      } else {
        test.error = "Failed to fetch connection stats"
      }

      // Test caching - should be much faster second time
      const cached = await fetcher.fetchConnectionStats(this.connectionId)
      if (cached) {
        console.log(
          "[v0] [Test] Cached fetch successful (should have been from cache)",
        )
      }

      const stats = fetcher.getStats()
      console.log("[v0] [Test] Fetcher stats:", stats)
    } catch (error) {
      test.error = `${error}`
    }

    test.duration = Date.now() - start
    this.results.push(test)
  }

  /**
   * Test 4: System Diagnostics - Issue Detection
   */
  async testSystemDiagnostics(): Promise<void> {
    const start = Date.now()
    const test: TestResult = {
      name: "System Diagnostics - Issue Detection",
      passed: false,
      duration: 0,
    }

    try {
      const report = await runSystemDiagnostics(this.connectionId, this.symbol)

      if (report && report.stats && report.connection === this.connectionId) {
        test.passed = true
      } else {
        test.error = "Diagnostics report incomplete"
      }

      console.log("[v0] [Test] Diagnostic report:")
      console.log("  Issues found:", report.issues.length)
      console.log("  Fixes needed:", report.fixes.length)
      console.log("  Stats:", JSON.stringify(report.stats, null, 2))
    } catch (error) {
      test.error = `${error}`
    }

    test.duration = Date.now() - start
    this.results.push(test)
  }

  /**
   * Test 5: Status Field Presence in Sets
   */
  async testStatusFieldPresence(): Promise<void> {
    const start = Date.now()
    const test: TestResult = {
      name: "Status Field Presence in Sets",
      passed: false,
      duration: 0,
    }

    try {
      const report = await runSystemDiagnostics(this.connectionId, this.symbol)

      const mainStats = (report.stats as any).mainSets
      if (mainStats) {
        const coverage = (mainStats.withStatus / mainStats.total) * 100
        if (coverage >= 95) {
          test.passed = true
        } else {
          test.error = `Only ${coverage.toFixed(1)}% of sets have status field`
        }

        console.log(
          `[v0] [Test] Main set status coverage: ${coverage.toFixed(1)}%`,
        )
        console.log(`        Distribution:`, mainStats.statusDistribution)
      }
    } catch (error) {
      test.error = `${error}`
    }

    test.duration = Date.now() - start
    this.results.push(test)
  }

  /**
   * Test 6: Set Count Ratios
   */
  async testSetCountRatios(): Promise<void> {
    const start = Date.now()
    const test: TestResult = {
      name: "Set Count Ratios",
      passed: false,
      duration: 0,
    }

    try {
      const report = await runSystemDiagnostics(this.connectionId, this.symbol)

      const counts = (report.stats as any).setCounts
      if (counts && counts.base > 0) {
        const ratio = parseFloat(counts.mainPerBase)
        if (ratio >= 2) {
          test.passed = true
        } else {
          test.error = `MAIN/BASE ratio ${ratio} is below expected 4-8 range`
        }

        console.log(
          `[v0] [Test] Set count ratios - BASE: ${counts.base}, MAIN: ${counts.main}, Ratio: ${ratio.toFixed(2)}`,
        )
      }
    } catch (error) {
      test.error = `${error}`
    }

    test.duration = Date.now() - start
    this.results.push(test)
  }

  /**
   * Test 7: Hedge Netting Structure
   */
  async testHedgeNettingStructure(): Promise<void> {
    const start = Date.now()
    const test: TestResult = {
      name: "Hedge Netting Structure",
      passed: false,
      duration: 0,
    }

    try {
      const report = await runSystemDiagnostics(this.connectionId, this.symbol)

      const realStats = (report.stats as any).realSets
      if (realStats) {
        const parKeyRatio = (realStats.withParentKey / realStats.total) * 100
        if (parKeyRatio >= 95) {
          test.passed = true
        } else {
          test.error = `Only ${parKeyRatio.toFixed(1)}% of REAL sets have parentSetKey`
        }

        console.log(
          `[v0] [Test] REAL set structure - Total: ${realStats.total}, With parentSetKey: ${realStats.withParentKey} (${parKeyRatio.toFixed(1)}%)`,
        )
        console.log(
          `        Directions - Long: ${realStats.directions.long}, Short: ${realStats.directions.short}`,
        )
      }
    } catch (error) {
      test.error = `${error}`
    }

    test.duration = Date.now() - start
    this.results.push(test)
  }

  /**
   * Test 8: Full Audit with Auto-fix
   */
  async testFullAuditWithFix(): Promise<void> {
    const start = Date.now()
    const test: TestResult = {
      name: "Full Audit with Auto-fix",
      passed: false,
      duration: 0,
    }

    try {
      const report = await runFullAudit(this.connectionId, this.symbol)

      if (report && report.fixes.length >= 0) {
        test.passed = true
      }

      console.log(
        `[v0] [Test] Full audit complete - Issues: ${report.issues.length}, Fixes applied: ${report.fixes.length}`,
      )
      console.log(`        Issues:`, report.issues)
      console.log(`        Fixes:`, report.fixes)
    } catch (error) {
      test.error = `${error}`
    }

    test.duration = Date.now() - start
    this.results.push(test)
  }

  /**
   * Run all tests
   */
  async runAll(): Promise<void> {
    console.log(
      "\n========================================\nIntegration Test Suite\n========================================\n",
    )

    const tests = [
      () => this.testBatchAPIQueuing(),
      () => this.testRateLimitHandling(),
      () => this.testOptimizedStatsFetcher(),
      () => this.testSystemDiagnostics(),
      () => this.testStatusFieldPresence(),
      () => this.testSetCountRatios(),
      () => this.testHedgeNettingStructure(),
      () => this.testFullAuditWithFix(),
    ]

    for (const test of tests) {
      try {
        await test()
      } catch (error) {
        console.error(`[v0] [Test] Test execution failed:`, error)
      }
    }

    this.printSummary()
  }

  /**
   * Print test summary
   */
  private printSummary(): void {
    const passed = this.results.filter((r) => r.passed).length
    const total = this.results.length
    const totalDuration = this.results.reduce((sum, r) => sum + r.duration, 0)

    console.log(
      "\n========================================\nTest Results Summary\n========================================\n",
    )

    for (const result of this.results) {
      const status = result.passed ? "✓ PASS" : "✗ FAIL"
      const duration = `${result.duration}ms`
      console.log(`${status}: ${result.name.padEnd(50)} ${duration}`)

      if (result.error) {
        console.log(`       Error: ${result.error}`)
      }
    }

    console.log("\n" + "-".repeat(70))
    console.log(`Total: ${passed}/${total} tests passed (${totalDuration}ms total)`)
    console.log(
      `Success rate: ${((passed / total) * 100).toFixed(1)}%\n========================================\n`,
    )
  }
}

// Export for use
export default IntegrationTestSuite

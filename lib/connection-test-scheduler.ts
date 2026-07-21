// Connection Test Scheduler
// Handles on-creation testing and periodic 5-minute background testing with rate limit respect

import { getRedisClient, initRedis } from "@/lib/redis-db"
import { createExchangeConnector, exchangeConnectorFactory } from "@/lib/exchange-connectors/factory"
import { isTruthyFlag } from "@/lib/connection-state-utils"
import { getExchangeRateLimit } from "@/lib/api-type-mapper"
import type { ExchangeConnection } from "@/lib/types"

const LOG_PREFIX = "[v0] [ConnectionTestScheduler]"

// Rate limit tracking per connection
interface RateLimitTracker {
  lastTestTime: number
  testCount: number
  failureCount: number
  consecutiveFailures: number
  nextAllowedTestTime: number
}

// Test result tracking
interface ConnectionTestResult {
  connectionId: string
  connectionName: string
  exchange: string
  success: boolean
  error?: string
  balance?: string
  timestamp: number
  duration: number
  statusCode?: number
}

// Minimum interval between tests per connection (5 minutes)
const MIN_TEST_INTERVAL_MS = 5 * 60 * 1000

// Maximum consecutive failures before backing off
const MAX_CONSECUTIVE_FAILURES = 3

// Exponential backoff: wait time increases with failures
const BACKOFF_MULTIPLIER = 2
const INITIAL_BACKOFF_MS = 60000 // 1 minute

/**
 * Test a single connection immediately
 * Used for on-creation testing
 */
export async function testConnectionImmediate(
  connection: ExchangeConnection
): Promise<ConnectionTestResult> {
  await initRedis()
  const startTime = Date.now()
  const connectionId = connection.id || connection.name

  console.log(`${LOG_PREFIX} Testing connection: ${connection.name} (${connection.exchange})`)

  try {
    // Validate credentials exist (but don't check length — valid credentials
    // vary by exchange, some are short, some long)
    if (!connection.api_key || !connection.api_secret) {
      throw new Error("Invalid or missing API credentials")
    }

    // Prefer the connector resolved from the current persisted connection.
    // For BingX this is the bingx-api SDK fast path, and its fingerprint is
    // rebuilt whenever credentials, API type, testnet or position mode change.
    // The direct path remains only for the narrow pre-save creation test.
    const storedConnector = connection.id
      ? await exchangeConnectorFactory.getOrCreateConnector(connection.id)
      : null
    const connector = storedConnector || await createExchangeConnector(connection.exchange, {
      apiKey: connection.api_key,
      apiSecret: connection.api_secret,
      apiPassphrase: connection.api_passphrase || "",
      isTestnet: isTruthyFlag(connection.is_testnet),
      apiType: connection.api_type,
      contractType: connection.contract_type,
      connectionMethod: String(connection.exchange || "").toLowerCase().includes("bingx") ? "library" : connection.connection_method,
      connectionLibrary: String(connection.exchange || "").toLowerCase().includes("bingx") ? "sdk" : connection.connection_library,
    })

    // Test connection with 30-second timeout
    const testResult = await Promise.race([
      connector.testConnection(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Test timeout (30s)")), 30000)
      ),
    ]) as any

    const duration = Date.now() - startTime
    const success = testResult.success === true

    const result: ConnectionTestResult = {
      connectionId,
      connectionName: connection.name,
      exchange: connection.exchange,
      success,
      balance: testResult.balance,
      timestamp: Date.now(),
      duration,
      statusCode: testResult.statusCode,
    }

    if (!success) {
      result.error = testResult.error || "Connection test failed"
      console.warn(`${LOG_PREFIX} Test FAILED: ${connection.name} - ${result.error}`)
    } else {
      console.log(
        `${LOG_PREFIX} Test PASSED: ${connection.name} - Balance: ${result.balance} (${duration}ms)`
      )
    }

    // Store result in Redis
    await storeTestResult(result)
    return result
  } catch (error) {
    const duration = Date.now() - startTime
    const errorMsg = error instanceof Error ? error.message : String(error)

    const result: ConnectionTestResult = {
      connectionId,
      connectionName: connection.name,
      exchange: connection.exchange,
      success: false,
      error: errorMsg,
      timestamp: Date.now(),
      duration,
    }

    console.error(`${LOG_PREFIX} Test ERROR: ${connection.name} - ${errorMsg}`)
    await storeTestResult(result)
    return result
  }
}

/**
 * Store test result in Redis for tracking and monitoring
 */
async function storeTestResult(result: ConnectionTestResult): Promise<void> {
  const client = getRedisClient()
  const key = `connection:test:${result.connectionId}`

  try {
    // Store last test result
    await client.setex(
      key,
      86400, // Keep for 24 hours
      JSON.stringify(result)
    )

    // Store in test history (keep last 10)
    const historyKey = `connection:test:history:${result.connectionId}`
    const history = await client.lrange(historyKey, 0, -1).catch(() => [])
    const parsedHistory = history.map((h: string) => JSON.parse(h))
    parsedHistory.unshift(result)
    const limitedHistory = parsedHistory.slice(0, 10)

    await client.del(historyKey)
    if (limitedHistory.length > 0) {
      await client.rpush(historyKey, ...limitedHistory.map((h: any) => JSON.stringify(h)))
      await client.expire(historyKey, 604800) // 7 days
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} Failed to store test result: ${err}`)
  }
}

/**
 * Check if connection should be tested (respecting rate limits)
 */
async function shouldTestConnection(connection: ExchangeConnection): Promise<boolean> {
  const client = getRedisClient()
  const trackKey = `connection:rate:${connection.id || connection.name}`

  try {
    const trackerStr = await client.get(trackKey).catch(() => null)
    const tracker: RateLimitTracker = trackerStr ? JSON.parse(trackerStr) : {}

    // Check if minimum interval has passed
    if (tracker.nextAllowedTestTime && Date.now() < tracker.nextAllowedTestTime) {
      return false // Too soon to test
    }

    // Check exponential backoff for failing connections
    if (tracker.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      const backoffTime = INITIAL_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, tracker.consecutiveFailures - 1)
      if (Date.now() - tracker.lastTestTime < backoffTime) {
        return false // In exponential backoff period
      }
    }

    return true // Should test
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error checking rate limit: ${err}`)
    return true // Default: allow test
  }
}

/**
 * Update rate limit tracker after test
 */
async function updateRateLimitTracker(
  connection: ExchangeConnection,
  success: boolean
): Promise<void> {
  const client = getRedisClient()
  const trackKey = `connection:rate:${connection.id || connection.name}`

  try {
    const trackerStr = await client.get(trackKey).catch(() => null)
    const tracker: RateLimitTracker = trackerStr ? JSON.parse(trackerStr) : {}

    tracker.lastTestTime = Date.now()
    tracker.nextAllowedTestTime = Date.now() + MIN_TEST_INTERVAL_MS
    tracker.testCount = (tracker.testCount || 0) + 1

    if (success) {
      tracker.consecutiveFailures = 0
    } else {
      tracker.failureCount = (tracker.failureCount || 0) + 1
      tracker.consecutiveFailures = (tracker.consecutiveFailures || 0) + 1
    }

    await client.setex(trackKey, 604800, JSON.stringify(tracker)) // Keep for 7 days
  } catch (err) {
    console.warn(`${LOG_PREFIX} Failed to update rate limiter: ${err}`)
  }
}

/**
 * Periodic connection tester (runs every 5 minutes)
 * Tests all enabled connections that meet rate limit requirements
 */
export async function runPeriodicConnectionTests(
  enabledConnections: ExchangeConnection[]
): Promise<ConnectionTestResult[]> {
  console.log(`${LOG_PREFIX} Starting periodic tests for ${enabledConnections.length} connections`)

  const results: ConnectionTestResult[] = []

  for (const connection of enabledConnections) {
    try {
      // Respect rate limits - skip if not enough time has passed
      const shouldTest = await shouldTestConnection(connection)
      if (!shouldTest) {
        console.log(
          `${LOG_PREFIX} Skipping test for ${connection.name} (rate limit: < 5 min since last test)`
        )
        continue
      }

      // Test the connection
      const result = await testConnectionImmediate(connection)
      results.push(result)

      // Update rate limit tracker
      await updateRateLimitTracker(connection, result.success)
    } catch (err) {
      console.error(`${LOG_PREFIX} Error testing ${connection.name}: ${err}`)
    }
  }

  console.log(`${LOG_PREFIX} Completed periodic tests: ${results.length} tested`)
  return results
}

/**
 * Get last test result for connection
 */
export async function getLastConnectionTestResult(
  connectionId: string
): Promise<ConnectionTestResult | null> {
  await initRedis()
  const client = getRedisClient()
  const key = `connection:test:${connectionId}`

  try {
    const resultStr = await client.get(key)
    return resultStr ? JSON.parse(resultStr) : null
  } catch (err) {
    console.warn(`${LOG_PREFIX} Failed to get test result: ${err}`)
    return null
  }
}

/**
 * Get test history for connection
 */
export async function getConnectionTestHistory(connectionId: string): Promise<ConnectionTestResult[]> {
  await initRedis()
  const client = getRedisClient()
  const historyKey = `connection:test:history:${connectionId}`

  try {
    const history = await client.lrange(historyKey, 0, -1)
    return history.map((h: string) => JSON.parse(h))
  } catch (err) {
    console.warn(`${LOG_PREFIX} Failed to get test history: ${err}`)
    return []
  }
}

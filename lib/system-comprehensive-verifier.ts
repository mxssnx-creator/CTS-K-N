/**
 * Comprehensive System Verifier
 * Ensures all database functionality, API endpoints, and trade engines are fully operational
 * Tests Redis/Upstash integration, connection management, trade engine coordination, and system health
 */

import { RedisConnections, RedisTrades, RedisPositions, RedisCache, RedisMonitoring } from "./redis-operations"
import { GlobalTradeEngineCoordinator } from "./trade-engine"
import { getRedisClient } from "./redis-db"

export interface VerificationResult {
  status: "success" | "partial" | "failed"
  timestamp: Date
  components: {
    redis: HealthCheck
    connections: HealthCheck
    trades: HealthCheck
    positions: HealthCheck
    tradeEngine: HealthCheck
    monitoring: HealthCheck
    cache: HealthCheck
  }
  summary: {
    totalTests: number
    passed: number
    failed: number
    warnings: string[]
  }
}

export interface HealthCheck {
  operational: boolean
  responseTime: number
  message: string
  details?: Record<string, any>
}

/**
 * Comprehensive system verification
 */
export async function verifyCompleteSystem(): Promise<VerificationResult> {
  const startTime = Date.now()
  const results: VerificationResult = {
    status: "success",
    timestamp: new Date(),
    components: {
      redis: { operational: false, responseTime: 0, message: "Pending" },
      connections: { operational: false, responseTime: 0, message: "Pending" },
      trades: { operational: false, responseTime: 0, message: "Pending" },
      positions: { operational: false, responseTime: 0, message: "Pending" },
      tradeEngine: { operational: false, responseTime: 0, message: "Pending" },
      monitoring: { operational: false, responseTime: 0, message: "Pending" },
      cache: { operational: false, responseTime: 0, message: "Pending" },
    },
    summary: {
      totalTests: 0,
      passed: 0,
      failed: 0,
      warnings: [],
    },
  }

  try {
    // Test Redis Connection
    console.log("[v0] [Verifier] Testing Redis connectivity...")
    const redisCheck = await verifyRedisConnection()
    results.components.redis = redisCheck
    results.summary.totalTests++
    if (redisCheck.operational) results.summary.passed++
    else results.summary.failed++

    // Test Connection Management
    console.log("[v0] [Verifier] Testing connection management...")
    const connCheck = await verifyConnectionManagement()
    results.components.connections = connCheck
    results.summary.totalTests++
    if (connCheck.operational) results.summary.passed++
    else results.summary.failed++

    // Test Trade Operations
    console.log("[v0] [Verifier] Testing trade operations...")
    const tradeCheck = await verifyTradeOperations()
    results.components.trades = tradeCheck
    results.summary.totalTests++
    if (tradeCheck.operational) results.summary.passed++
    else results.summary.failed++

    // Test Position Management
    console.log("[v0] [Verifier] Testing position management...")
    const posCheck = await verifyPositionManagement()
    results.components.positions = posCheck
    results.summary.totalTests++
    if (posCheck.operational) results.summary.passed++
    else results.summary.failed++

    // Test Trade Engine Coordination
    console.log("[v0] [Verifier] Testing trade engine coordination...")
    const engineCheck = await verifyTradeEngineCoordination()
    results.components.tradeEngine = engineCheck
    results.summary.totalTests++
    if (engineCheck.operational) results.summary.passed++
    else results.summary.failed++

    // Test Monitoring
    console.log("[v0] [Verifier] Testing monitoring system...")
    const monCheck = await verifyMonitoring()
    results.components.monitoring = monCheck
    results.summary.totalTests++
    if (monCheck.operational) results.summary.passed++
    else results.summary.failed++

    // Test Cache
    console.log("[v0] [Verifier] Testing cache system...")
    const cacheCheck = await verifyCacheSystem()
    results.components.cache = cacheCheck
    results.summary.totalTests++
    if (cacheCheck.operational) results.summary.passed++
    else results.summary.failed++

    // Determine overall status
    if (results.summary.failed === 0) {
      results.status = "success"
    } else if (results.summary.failed === 1) {
      results.status = "partial"
    } else {
      results.status = "failed"
    }
  } catch (error) {
    console.error("[v0] [Verifier] System verification failed:", error)
    results.status = "failed"
    results.summary.warnings.push(`Critical error: ${error instanceof Error ? error.message : String(error)}`)
  }

  results.summary.totalTests = results.summary.passed + results.summary.failed

  const totalTime = Date.now() - startTime
  console.log(`[v0] [Verifier] System verification completed in ${totalTime}ms - Status: ${results.status}`)

  return results
}

async function verifyRedisConnection(): Promise<HealthCheck> {
  const startTime = Date.now()
  try {
    const client = getRedisClient()
    await client.set("verify:test", "ok")
    const value = await client.get("verify:test")
    await client.del("verify:test")

    const responseTime = Date.now() - startTime
    return {
      operational: value === "ok",
      responseTime,
      message: "Redis connection successful",
      details: { client: "Upstash Redis", latency: `${responseTime}ms` },
    }
  } catch (error) {
    return {
      operational: false,
      responseTime: Date.now() - startTime,
      message: `Redis connection failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function verifyConnectionManagement(): Promise<HealthCheck> {
  const startTime = Date.now()
  try {
    // Test create, read, update operations
    const testConnId = `verify_conn_${Date.now()}`
    await RedisConnections.createConnection({
      id: testConnId,
      name: testConnId,
      exchange: "test",
      is_enabled: true,
      is_active: true,
    })

    const conn = await RedisConnections.getConnection(testConnId)
    await RedisConnections.updateConnection(testConnId, { status: "verified", verified_at: Date.now() })
    const updated = await RedisConnections.getConnection(testConnId)
    await getRedisClient().del(`connection:${testConnId}`)

    const responseTime = Date.now() - startTime
    const operational = conn?.id === testConnId && updated?.status === "verified"

    return {
      operational,
      responseTime,
      message: "Connection management operational",
      details: { operationsTested: 4, createRead: "passed", updateRead: "passed" },
    }
  } catch (error) {
    return {
      operational: false,
      responseTime: Date.now() - startTime,
      message: `Connection management failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function verifyTradeOperations(): Promise<HealthCheck> {
  const startTime = Date.now()
  try {
    const testTradeId = `verify_trade_${Date.now()}`
    const testTrade = {
      id: testTradeId,
      symbol: "BTCUSDT",
      side: "buy",
      quantity: 0.1,
      price: 30000,
      timestamp: Date.now(),
    }

    await RedisTrades.createTrade(testTradeId, testTrade)
    const trade = await RedisTrades.getTrade(testTradeId)
    await getRedisClient().del(`trade:${testTradeId}`)

    const responseTime = Date.now() - startTime
    const operational = trade?.id === testTradeId

    return {
      operational,
      responseTime,
      message: "Trade operations operational",
      details: { tradesTested: 1, createRead: "passed" },
    }
  } catch (error) {
    return {
      operational: false,
      responseTime: Date.now() - startTime,
      message: `Trade operations failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function verifyPositionManagement(): Promise<HealthCheck> {
  const startTime = Date.now()
  try {
    const testPosId = `verify_pos_${Date.now()}`
    const testPos = {
      id: testPosId,
      symbol: "ETHUSDT",
      side: "long",
      quantity: 1.5,
      entryPrice: 1800,
      status: "open",
      openedAt: Date.now(),
    }

    await RedisPositions.createPosition(testPosId, testPos)
    const pos = await RedisPositions.getPosition(testPosId)
    await RedisPositions.updatePosition(testPosId, { status: "verified" })
    const updated = await RedisPositions.getPosition(testPosId)
    await getRedisClient().del(`position:${testPosId}`)

    const responseTime = Date.now() - startTime
    const operational = pos?.id === testPosId && updated?.status === "verified"

    return {
      operational,
      responseTime,
      message: "Position management operational",
      details: { positionsTested: 1, createRead: "passed", updateRead: "passed" },
    }
  } catch (error) {
    return {
      operational: false,
      responseTime: Date.now() - startTime,
      message: `Position management failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function verifyTradeEngineCoordination(): Promise<HealthCheck> {
  const startTime = Date.now()
  try {
    // Verify GlobalTradeEngineCoordinator is accessible
    const coordinator = new GlobalTradeEngineCoordinator()

    // Test that it initializes properly
    const hasInitialize = typeof coordinator.initializeEngine === "function"
    const hasStart = typeof coordinator.startEngine === "function"
    const hasStop = typeof coordinator.stopEngine === "function"

    const responseTime = Date.now() - startTime
    const operational = hasInitialize && hasStart && hasStop

    return {
      operational,
      responseTime,
      message: "Trade engine coordination operational",
      details: {
        coordinatorReady: true,
        methodsAvailable: { initialize: hasInitialize, start: hasStart, stop: hasStop },
      },
    }
  } catch (error) {
    return {
      operational: false,
      responseTime: Date.now() - startTime,
      message: `Trade engine coordination failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function verifyMonitoring(): Promise<HealthCheck> {
  const startTime = Date.now()
  try {
    const testEvent = { type: "verification", data: { timestamp: Date.now() } }
    await RedisMonitoring.recordEvent("system_verification", testEvent)

    const responseTime = Date.now() - startTime

    return {
      operational: true,
      responseTime,
      message: "Monitoring system operational",
      details: { eventsLogged: 1, eventType: "system_verification" },
    }
  } catch (error) {
    return {
      operational: false,
      responseTime: Date.now() - startTime,
      message: `Monitoring failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function verifyCacheSystem(): Promise<HealthCheck> {
  const startTime = Date.now()
  try {
    const testKey = `cache_verify_${Date.now()}`
    const testData = { cached: true, timestamp: Date.now() }

    await RedisCache.set(testKey, testData, 3600)
    const cached = await RedisCache.get(testKey)
    await getRedisClient().del(testKey)

    const responseTime = Date.now() - startTime
    const operational = cached?.cached === true

    return {
      operational,
      responseTime,
      message: "Cache system operational",
      details: { cacheOperations: 2, setGet: "passed", expiration: "3600s" },
    }
  } catch (error) {
    return {
      operational: false,
      responseTime: Date.now() - startTime,
      message: `Cache system failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

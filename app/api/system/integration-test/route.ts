import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { getRedisClient, getAllConnections, createConnection, getConnection } from "@/lib/redis-db"
import { RedisTrades, RedisPositions, RedisCache, RedisMonitoring } from "@/lib/redis-operations"
import { GlobalTradeEngineCoordinator } from "@/lib/trade-engine"

export const dynamic = "force-dynamic"

/**
 * GET /api/system/integration-test
 * Quick comprehensive system verification
 */
export async function GET() {
  const startTime = Date.now()
  const results: any = {
    timestamp: new Date().toISOString(),
    tests: {},
    summary: { total: 0, passed: 0, failed: 0 },
  }

  try {
    console.log("[v0] [Integration Test] Starting system test...")

    results.tests.redis = await testRedis()
    results.summary.total++
    if (results.tests.redis.status === "pass") results.summary.passed++
    else results.summary.failed++

    results.tests.connections = await testConnectionsCrud()
    results.summary.total++
    if (results.tests.connections.status === "pass") results.summary.passed++
    else results.summary.failed++

    results.tests.trades = await testTrades()
    results.summary.total++
    if (results.tests.trades.status === "pass") results.summary.passed++
    else results.summary.failed++

    results.tests.positions = await testPositions()
    results.summary.total++
    if (results.tests.positions.status === "pass") results.summary.passed++
    else results.summary.failed++

    results.duration = Date.now() - startTime
    results.status = results.summary.failed === 0 ? "success" : "partial"

    console.log(`[v0] Test complete: ${results.summary.passed}/${results.summary.total} passed`)

    return NextResponse.json(results)
  } catch (error) {
    console.error("[v0] Test failed:", error)
    return NextResponse.json(
      {
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
        duration: Date.now() - startTime,
      },
      { status: 500 }
    )
  }
}

async function testRedis() {
  try {
    const client = getRedisClient()
    await client.hset("test:redis", { key: "value" })
    const val = await client.hget("test:redis", "key")
    await client.del("test:redis")
    return { status: val === "value" ? "pass" : "fail" }
  } catch (e) {
    return { status: "fail", error: String(e) }
  }
}

async function testConnectionsCrud() {
  try {
    const testId = "test_conn_" + Date.now()
    await createConnection({ id: testId, exchange: "bybit", name: "test", api_key: "k", api_secret: "s" })
    const conn = await getConnection(testId)
    const client = getRedisClient()
    await client.del(`connection:${testId}`)
    return { status: conn ? "pass" : "fail" }
  } catch (e) {
    return { status: "fail", error: String(e) }
  }
}

async function testTrades() {
  try {
    const tid = `trade_${Date.now()}`
    await RedisTrades.createTrade(tid, { id: tid, symbol: "BTC", side: "buy", quantity: 1, price: 30000 })
    const trade = await RedisTrades.getTrade(tid)
    const client = getRedisClient()
    await client.del(`trade:${tid}`)
    return { status: trade ? "pass" : "fail" }
  } catch (e) {
    return { status: "fail", error: String(e) }
  }
}

async function testPositions() {
  try {
    const pid = `pos_${Date.now()}`
    await RedisPositions.createPosition(pid, { id: pid, symbol: "ETH", side: "long", quantity: 10 })
    const pos = await RedisPositions.getPosition(pid)
    const client = getRedisClient()
    await client.del(`position:${pid}`)
    return { status: pos ? "pass" : "fail" }
  } catch (e) {
    return { status: "fail", error: String(e) }
  }
}

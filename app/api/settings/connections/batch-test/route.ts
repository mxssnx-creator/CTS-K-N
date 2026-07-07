/**
 * Batch Test Connections API
 * Tests multiple connections in parallel with proper rate limiting and concurrency control
 */

import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { initRedis, getConnection } from "@/lib/redis-db"
import { ConnectionCoordinator } from "@/lib/connection-coordinator"
import { RateLimiter } from "@/lib/rate-limiter"

// Track batch test attempts to prevent looping
const batchTestAttempts = new Map<string, { count: number; lastTime: number }>()
const MAX_BATCH_TESTS_PER_HOUR = 10
const MAX_CONCURRENT_TESTS = 5
const MIN_INTERVAL_BETWEEN_TESTS_MS = 5000

export const dynamic = "force-dynamic"
export async function POST(request: NextRequest) {
  const startTime = Date.now()

  try {
    const body = await request.json()
    const { connectionIds, testType = "all" } = body

    if (!Array.isArray(connectionIds) || connectionIds.length === 0) {
      return NextResponse.json(
        {
          error: "Invalid request",
          details: "connectionIds must be a non-empty array",
        },
        { status: 400 }
      )
    }

    // RATE LIMIT: Max 50 connections per batch
    if (connectionIds.length > 50) {
      return NextResponse.json(
        {
          error: "Too many connections",
          details: "Maximum 50 connections per batch test",
        },
        { status: 400 }
      )
    }

    // RATE LIMIT: Prevent rapid successive batch tests
    const batchKey = "batch-test-global"
    const now = Date.now()
    const attempt = batchTestAttempts.get(batchKey) || { count: 0, lastTime: 0 }
    
    // Reset counter if older than 1 hour
    if (now - attempt.lastTime > 3600000) {
      attempt.count = 0
    }
    
    if (attempt.count >= MAX_BATCH_TESTS_PER_HOUR) {
      return NextResponse.json(
        {
          error: "Rate limit exceeded",
          details: `Maximum ${MAX_BATCH_TESTS_PER_HOUR} batch tests per hour. Please wait before retrying.`,
        },
        { status: 429 }
      )
    }
    
    attempt.count++
    attempt.lastTime = now
    batchTestAttempts.set(batchKey, attempt)

    // Keep in-memory limiter map bounded
    for (const [key, value] of batchTestAttempts.entries()) {
      if (key === batchKey) continue
      if (now - value.lastTime > 3600000) {
        batchTestAttempts.delete(key)
      }
    }

    console.log(`[v0] [Batch Test] Starting batch test for ${connectionIds.length} connections (attempt ${attempt.count}/${MAX_BATCH_TESTS_PER_HOUR})`)

    await initRedis()

    const coordinator = ConnectionCoordinator.getInstance()
    const results = new Map()
    const errors: string[] = []

    // Test connections with concurrency control
    let successfulTests = 0
    
    for (let i = 0; i < connectionIds.length; i += MAX_CONCURRENT_TESTS) {
      const batch = connectionIds.slice(i, i + MAX_CONCURRENT_TESTS)
      
      console.log(`[v0] [Batch Test] Testing batch ${Math.floor(i / MAX_CONCURRENT_TESTS) + 1}: ${batch.length} connections`)
      
      const batchPromises = batch.map(async (connectionId) => {
        try {
          // Get connection to determine exchange
          const connection = await getConnection(connectionId)
          if (!connection) {
            errors.push(`${connectionId}: Connection not found`)
            return { connectionId, success: false, error: "Connection not found" }
          }

          // Use rate limiter to respect exchange limits
          const rateLimiter = new RateLimiter(connection.exchange)
          
          const result = await rateLimiter.execute(async () => {
            return await coordinator.testConnection(connectionId)
          })
          
          results.set(connectionId, result)
          if (result.success) {
            successfulTests++
          }
          return { connectionId, ...result }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error"
          errors.push(`${connectionId}: ${errorMessage}`)
          results.set(connectionId, {
            success: false,
            error: errorMessage,
          })
          return { connectionId, success: false, error: errorMessage }
        }
      })

      // Wait for concurrent batch to complete
      await Promise.all(batchPromises)
      
      // Add minimum interval between batches to prevent rate limiting
      if (i + MAX_CONCURRENT_TESTS < connectionIds.length) {
        console.log(`[v0] [Batch Test] Waiting ${MIN_INTERVAL_BETWEEN_TESTS_MS}ms before next batch...`)
        await new Promise((resolve) => setTimeout(resolve, MIN_INTERVAL_BETWEEN_TESTS_MS))
      }
    }

    const duration = Date.now() - startTime
    const successful = successfulTests
    const failed = connectionIds.length - successful

    console.log(`[v0] [Batch Test] Batch test completed: ${successful}/${connectionIds.length} successful in ${duration}ms`)

    await SystemLogger.logAPI(
      `Batch test completed: ${successful} successful, ${failed} failed (${connectionIds.length} total)`,
      "info",
      "POST /api/settings/connections/batch-test"
    )

    return NextResponse.json({
      success: true,
      totalConnections: connectionIds.length,
      successful,
      failed,
      duration,
      results: Object.fromEntries(results),
      errors: errors.length > 0 ? errors : undefined,
    })
  } catch (error) {
    console.error("[v0] [Batch Test] Error:", error)
    await SystemLogger.logError(error, "api", "POST /api/settings/connections/batch-test")

    return NextResponse.json(
      {
        error: "Batch test failed",
        details: error instanceof Error ? error.message : "Unknown error",
        duration: Date.now() - startTime,
      },
      { status: 500 }
    )
  }
}

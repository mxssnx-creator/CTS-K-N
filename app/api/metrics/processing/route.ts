/**
 * Processing Metrics API
 * Returns current processing metrics for a connection
 */

import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getMetricsTracker } from '@/lib/processing-metrics'
import { getRedisClient } from '@/lib/redis-db'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const connectionId = request.nextUrl.searchParams.get('connectionId')
    if (!connectionId) {
      return NextResponse.json({ error: 'Missing connectionId parameter' }, { status: 400 })
    }

    // Get metrics from tracker
    const tracker = getMetricsTracker(connectionId)
    const metrics = tracker.getMetrics()
    const summary = tracker.getMetricsSummary()

    // Try to get persisted metrics from Redis as fallback
    let persistedMetrics = null
    try {
      const client = getRedisClient()
      const key = `processing_metrics:${connectionId}`
      const data = await client.get(key)
      if (data) {
        persistedMetrics = JSON.parse(data)
      }
    } catch (error) {
      console.error('[API] Failed to fetch persisted metrics:', error)
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          current: metrics,
          summary,
          persisted: persistedMetrics,
          timestamp: new Date().toISOString(),
        },
      },
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      },
    )
  } catch (error) {
    console.error('[API] Processing metrics error:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to get processing metrics',
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    )
  }
}

/**
 * Broadcast Health Check API
 * Verifies SSE and broadcasting system health
 */

import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getBroadcaster } from '@/lib/event-broadcaster'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const broadcaster = getBroadcaster()
    const stats = broadcaster.getStats()

    const isHealthy = stats.totalConnections >= 0 && stats.totalClients >= 0

    return NextResponse.json(
      {
        success: true,
        status: isHealthy ? 'healthy' : 'degraded',
        data: {
          broadcaster: {
            active: true,
            totalConnections: stats.totalConnections,
            totalClients: stats.totalClients,
            historySize: stats.historySize,
          },
          sse: {
            enabled: true,
            protocol: 'Server-Sent Events',
            endpoint: '/api/ws',
            heartbeat: '30s',
          },
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
    console.error('[API] Broadcast health check error:', error)
    return NextResponse.json(
      {
        success: false,
        status: 'unhealthy',
        error: 'Broadcast system error',
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    )
  }
}

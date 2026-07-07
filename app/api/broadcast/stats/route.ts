/**
 * Broadcast Statistics API
 * Returns real-time statistics about connected SSE clients
 */

import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getBroadcaster } from '@/lib/event-broadcaster'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const broadcaster = getBroadcaster()
    const stats = broadcaster.getStats()

    return NextResponse.json(
      {
        success: true,
        data: {
          timestamp: new Date().toISOString(),
          ...stats,
          serverTime: Date.now(),
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
    console.error('[API] Broadcast stats error:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to get broadcast stats',
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    )
  }
}

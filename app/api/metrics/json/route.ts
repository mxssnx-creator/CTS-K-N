import { NextResponse } from 'next/server'
import { metricsCollector, updateSystemMetrics } from '@/lib/metrics-collector'

export const dynamic = 'force-dynamic'

/**
 * GET /api/metrics/json
 * JSON format metrics endpoint (for debugging)
 */
export async function GET(request: Request) {
  try {
    updateSystemMetrics()

    const metricsJson = metricsCollector.getMetricsJson()

    return NextResponse.json(metricsJson, {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    })
  } catch (error) {
    console.error('[METRICS] Error exporting JSON metrics:', error)

    return NextResponse.json(
      {
        error: 'Failed to export metrics',
        message: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    )
  }
}

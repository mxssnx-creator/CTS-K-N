import { NextResponse } from 'next/server'
import { metricsCollector, updateSystemMetrics } from '@/lib/metrics-collector'

export const dynamic = 'force-dynamic'

/**
 * GET /api/metrics
 * Prometheus-compatible metrics endpoint
 * Returns metrics in Prometheus text format
 */
export async function GET(request: Request) {
  try {
    // Update system metrics before export
    updateSystemMetrics()

    // Get metrics in Prometheus format
    const metricsText = metricsCollector.getMetricsText()

    // Return as text/plain for Prometheus scraper
    return new NextResponse(metricsText, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Content-Length': Buffer.byteLength(metricsText).toString()
      }
    })
  } catch (error) {
    console.error('[METRICS] Error exporting metrics:', error)

    return NextResponse.json(
      {
        error: 'Failed to export metrics',
        message: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    )
  }
}

/**
 * GET /api/metrics/json
 * JSON format metrics endpoint (for debugging)
 */
export async function GET_JSON(request: Request) {
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

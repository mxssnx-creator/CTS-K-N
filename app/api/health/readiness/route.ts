import { NextResponse } from 'next/server'
import { healthCheckService } from '@/lib/health-check'

export const dynamic = 'force-dynamic'

/**
 * GET /api/health/readiness
 * Kubernetes readiness probe endpoint
 * Returns 200 if system can handle requests, 503 otherwise
 */
export async function GET() {
  try {
    const status = await healthCheckService.getReadinessStatus()

    if (status.ready) {
      return NextResponse.json(status, { status: 200 })
    } else {
      return NextResponse.json(status, { status: 503 })
    }
  } catch (error) {
    return NextResponse.json(
      {
        ready: false,
        message: 'Readiness check failed',
        error: error instanceof Error ? error.message : String(error)
      },
      { status: 503 }
    )
  }
}

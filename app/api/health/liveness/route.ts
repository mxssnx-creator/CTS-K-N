import { NextResponse } from 'next/server'
import { healthCheckService } from '@/lib/health-check'

export const dynamic = 'force-dynamic'

/**
 * GET /api/health/liveness
 * Kubernetes liveness probe endpoint
 * Returns 200 if process is alive and responsive
 */
export async function GET() {
  try {
    const status = await healthCheckService.getLivenessStatus()

    return NextResponse.json(status, { status: 200 })
  } catch (error) {
    return NextResponse.json(
      {
        alive: false,
        error: error instanceof Error ? error.message : String(error)
      },
      { status: 503 }
    )
  }
}

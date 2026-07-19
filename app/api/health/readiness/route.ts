import { NextResponse } from 'next/server'
import { healthCheckService } from '@/lib/health-check'
import { validateProductionStartup, runtimeHealthCheck } from '@/lib/startup-validation'

export const dynamic = 'force-dynamic'

/**
 * GET /api/health/readiness
 * Kubernetes readiness probe endpoint
 * Returns 200 if system can handle requests, 503 otherwise
 * Includes comprehensive startup validation checks
 */
export async function GET() {
  try {
    // Run comprehensive startup validation
    const validation = await validateProductionStartup()
    
    if (!validation.passed) {
      console.warn('[READINESS] System not ready:', validation.errors)
      return NextResponse.json(
        {
          ready: false,
          validation,
          message: 'System initialization in progress or failed',
        },
        { status: 503 }
      )
    }

    // Get runtime health metrics
    const health = await runtimeHealthCheck()
    
    // Also get legacy health check service status for backward compatibility
    const status = await healthCheckService.getReadinessStatus()

    if (status.ready) {
      return NextResponse.json(
        {
          ...status,
          validation,
          health,
          timestamp: new Date().toISOString(),
        },
        { status: 200 }
      )
    } else {
      return NextResponse.json(
        {
          ...status,
          validation,
          health,
        },
        { status: 503 }
      )
    }
  } catch (error) {
    console.error('[READINESS] Readiness check failed:', error)
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

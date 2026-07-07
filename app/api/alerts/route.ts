import { NextResponse, NextRequest } from 'next/server'
import { alertManager } from '@/lib/alerting-system'

export const dynamic = 'force-dynamic'

/**
 * GET /api/alerts
 * Get alert history
 */
export async function GET(request: NextRequest) {
  try {
    const limit = parseInt(request.nextUrl.searchParams.get('limit') || '50', 10)
    const history = alertManager.getAlertHistory(limit)
    const stats = alertManager.getAlertStats()

    return NextResponse.json({
      alerts: history,
      stats,
      total: history.length
    })
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Failed to fetch alerts',
        message: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    )
  }
}

/**
 * POST /api/alerts
 * Send alert
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { title, message, severity = 'warning', source = 'api' } = body

    if (!title || !message) {
      return NextResponse.json(
        { error: 'Missing required fields: title, message' },
        { status: 400 }
      )
    }

    await alertManager.sendAlert(title, message, {
      severity,
      source,
      metadata: body.metadata
    })

    return NextResponse.json({
      success: true,
      message: 'Alert sent successfully'
    })
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Failed to send alert',
        message: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/alerts
 * Clear alert history
 */
export async function DELETE(request: NextRequest) {
  try {
    alertManager.clearAlertHistory()

    return NextResponse.json({
      success: true,
      message: 'Alert history cleared'
    })
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Failed to clear alerts',
        message: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    )
  }
}

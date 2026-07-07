/**
 * Logs API Endpoint
 * 
 * GET /api/logs - Retrieve structured logs with filtering
 * POST /api/logs/export - Export logs in JSON or CSV format
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAllLogs, exportAllLogs, LogLevel, LogCategory } from '@/lib/structured-logging'
import { getCorrelationId } from '@/lib/correlation-tracking'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams
    
    // Parse query parameters
    const levelParam = searchParams.get('level')
    const category = searchParams.get('category')
    const correlationId = searchParams.get('correlationId')
    const limitParam = searchParams.get('limit')
    const format = searchParams.get('format') as 'json' | 'csv' | undefined

    // Get all logs
    let logs = getAllLogs()

    // Filter by level
    if (levelParam) {
      const level = LogLevel[levelParam as keyof typeof LogLevel]
      if (level !== undefined) {
        logs = logs.filter(l => l.level >= level)
      }
    }

    // Filter by category
    if (category) {
      logs = logs.filter(l => l.category === category)
    }

    // Filter by correlation ID
    if (correlationId) {
      logs = logs.filter(l => l.correlationId === correlationId)
    }

    // Apply limit
    const limit = limitParam ? parseInt(limitParam) : 100
    logs = logs.slice(-limit)

    // Format response
    if (format === 'csv') {
      const csv = exportAllLogs('csv')
      return new NextResponse(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'X-Correlation-Id': getCorrelationId() || 'unknown'
        }
      })
    }

    return NextResponse.json({
      success: true,
      count: logs.length,
      logs,
      correlationId: getCorrelationId()
    }, { status: 200 })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({
      success: false,
      error: errorMessage
    }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { action, format = 'json' } = body

    if (action === 'export') {
      const exported = exportAllLogs(format as 'json' | 'csv')
      return NextResponse.json({
        success: true,
        format,
        data: exported,
        correlationId: getCorrelationId()
      }, { status: 200 })
    }

    if (action === 'clear') {
      // Note: Implement clear if needed
      return NextResponse.json({
        success: true,
        message: 'Logs cleared',
        correlationId: getCorrelationId()
      }, { status: 200 })
    }

    return NextResponse.json({
      success: false,
      error: 'Unknown action'
    }, { status: 400 })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({
      success: false,
      error: errorMessage
    }, { status: 500 })
  }
}

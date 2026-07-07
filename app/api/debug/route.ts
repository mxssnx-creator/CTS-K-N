import { NextRequest, NextResponse } from 'next/server'
import {
  enableDebugMode,
  disableDebugMode,
  getDebugConfig,
  setDebugOption,
  debug as debugLog,
} from '@/lib/debug-mode'

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const action = searchParams.get('action')

  debugLog('api:debug', `GET /api/debug?action=${action}`)

  switch (action) {
    case 'status':
      return NextResponse.json({
        enabled: true,
        config: getDebugConfig(),
        timestamp: new Date().toISOString(),
      })

    case 'enable':
      enableDebugMode()
      return NextResponse.json({
        message: 'Debug mode enabled',
        config: getDebugConfig(),
      })

    case 'disable':
      disableDebugMode()
      return NextResponse.json({
        message: 'Debug mode disabled',
      })

    default:
      return NextResponse.json({
        error: 'Invalid action',
        available: ['status', 'enable', 'disable', 'toggle'],
      }, { status: 400 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action, option, value, verbose } = body

    debugLog('api:debug', `POST /api/debug action=${action}`)

    switch (action) {
      case 'enable':
        enableDebugMode({ verbose: verbose ?? true })
        return NextResponse.json({
          message: 'Debug mode enabled',
          config: getDebugConfig(),
        })

      case 'set-option':
        if (!option) {
          return NextResponse.json({ error: 'option required' }, { status: 400 })
        }
        setDebugOption(option, value ?? true)
        return NextResponse.json({
          message: `Option ${option} set to ${value}`,
          config: getDebugConfig(),
        })

      case 'toggle-verbose':
        const config = getDebugConfig()
        setDebugOption('verbose', !config.verbose)
        return NextResponse.json({
          message: `Verbose toggled to ${!config.verbose}`,
          config: getDebugConfig(),
        })

      default:
        return NextResponse.json(
          { error: 'Invalid action' },
          { status: 400 }
        )
    }
  } catch (error) {
    debugLog('api:debug', 'Error in POST /api/debug', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

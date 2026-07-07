/**
 * Debug Mode Manager
 * Enables comprehensive logging across all engine components
 */

interface DebugConfig {
  enabled: boolean
  verbose: boolean
  logIndications: boolean
  logStrategies: boolean
  logPositions: boolean
  logMarketData: boolean
  logRedis: boolean
  logAPI: boolean
  logErrors: boolean
  timestamp: boolean
}

let debugConfig: DebugConfig = {
  enabled: false,
  verbose: false,
  logIndications: false,
  logStrategies: false,
  logPositions: false,
  logMarketData: false,
  logRedis: false,
  logAPI: false,
  logErrors: true,
  timestamp: true,
}

export function enableDebugMode(options?: Partial<DebugConfig>) {
  debugConfig = {
    ...debugConfig,
    enabled: true,
    verbose: true,
    logIndications: true,
    logStrategies: true,
    logPositions: true,
    logMarketData: true,
    logRedis: true,
    logAPI: true,
    ...options,
  }
  console.log('[DEBUG] Debug mode enabled with config:', debugConfig)
}

export function disableDebugMode() {
  debugConfig.enabled = false
  console.log('[DEBUG] Debug mode disabled')
}

export function debug(category: string, message: string, data?: any) {
  if (!debugConfig.enabled) return

  const shouldLog = {
    indication: debugConfig.logIndications,
    strategy: debugConfig.logStrategies,
    position: debugConfig.logPositions,
    market: debugConfig.logMarketData,
    redis: debugConfig.logRedis,
    api: debugConfig.logAPI,
    error: debugConfig.logErrors,
  }

  const key = category.split(':')[0].toLowerCase()
  if (!shouldLog[key as keyof typeof shouldLog] && key !== 'error') return

  const timestamp = debugConfig.timestamp ? `[${new Date().toISOString().split('T')[1]}]` : ''
  const prefix = `${timestamp} [v0-DEBUG] [${category}]`

  if (data) {
    console.log(`${prefix} ${message}`, data)
  } else {
    console.log(`${prefix} ${message}`)
  }
}

export function debugMetrics(label: string, metrics: Record<string, any>) {
  if (!debugConfig.enabled) return

  const timestamp = debugConfig.timestamp ? `[${new Date().toISOString().split('T')[1]}]` : ''
  const prefix = `${timestamp} [v0-DEBUG] [METRICS]`

  console.group(`${prefix} ${label}`)
  Object.entries(metrics).forEach(([key, value]) => {
    console.log(`  ${key}: ${JSON.stringify(value)}`)
  })
  console.groupEnd()
}

export function debugFlow(stage: string, status: 'start' | 'progress' | 'complete' | 'error', message: string) {
  if (!debugConfig.enabled) return

  const timestamp = debugConfig.timestamp ? `[${new Date().toISOString().split('T')[1]}]` : ''
  const statusEmoji = {
    start: '▶',
    progress: '●',
    complete: '✓',
    error: '✗',
  }
  const prefix = `${timestamp} [v0-DEBUG] [${stage}] ${statusEmoji[status]}`
  console.log(`${prefix} ${message}`)
}

export function getDebugConfig() {
  return debugConfig
}

export function setDebugOption(option: keyof DebugConfig, value: boolean) {
  debugConfig[option] = value
  console.log(`[DEBUG] Set ${option} = ${value}`)
}

export default {
  enableDebugMode,
  disableDebugMode,
  debug,
  debugMetrics,
  debugFlow,
  getDebugConfig,
  setDebugOption,
}

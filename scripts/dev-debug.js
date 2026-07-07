#!/usr/bin/env node
/**
 * dev-debug.js — Development debug launcher
 * Starts Next.js dev server with enhanced logging.
 * Usage:
 *   node scripts/dev-debug.js          # normal debug mode
 *   node scripts/dev-debug.js verbose  # verbose output
 */

const { spawn } = require('child_process')
const path = require('path')

const verbose = process.argv[2] === 'verbose'

const env = {
  ...process.env,
  NODE_ENV: 'development',
  NODE_OPTIONS: '--max-old-space-size=12288 --max-semi-space-size=128',
  DEBUG_MODE: '1',
  LOG_LEVEL: verbose ? 'debug' : 'info',
  NEXT_TELEMETRY_DISABLED: '1',
}

console.log('[dev-debug] Starting Next.js in debug mode...')
console.log(`[dev-debug] Log level: ${env.LOG_LEVEL}`)
console.log('[dev-debug] Port: 3002')

const nextBin = path.join(process.cwd(), 'node_modules', '.bin', 'next')
const args = ['dev', '-p', '3002']

const proc = spawn(nextBin, args, {
  env,
  stdio: 'inherit',
  cwd: process.cwd(),
})

proc.on('error', (err) => {
  console.error('[dev-debug] Failed to start:', err.message)
  process.exit(1)
})

proc.on('exit', (code) => {
  process.exit(code ?? 0)
})

// Forward signals to child process
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    proc.kill(sig)
  })
}

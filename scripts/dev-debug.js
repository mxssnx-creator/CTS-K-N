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
  // Keep dashboard debugging read-only unless the operator explicitly opts in.
  NEXT_PUBLIC_ALLOW_BROWSER_BOOTSTRAP: process.env.NEXT_PUBLIC_ALLOW_BROWSER_BOOTSTRAP || '0',
  NEXT_PUBLIC_DEV_AUTOSTART_COORDINATOR: process.env.NEXT_PUBLIC_DEV_AUTOSTART_COORDINATOR || '1',
  // Keep the coordinator and continuity runner alive in debug mode so the
  // progression pipeline can be exercised. Browser bootstrap remains disabled,
  // preventing every dashboard refresh from reseeding the full dataset.
  DISABLE_TRADE_ENGINE_AUTOSTART: process.env.DISABLE_TRADE_ENGINE_AUTOSTART || '0',
  DISABLE_IN_PROCESS_CONTINUITY: process.env.DISABLE_IN_PROCESS_CONTINUITY || '0',
  // Local coordinator debugging must never submit exchange orders.
  ALLOW_LIVE_ORDER_PLACEMENT: '0',
}

console.log('[dev-debug] Starting Next.js in debug mode...')
console.log(`[dev-debug] Log level: ${env.LOG_LEVEL}`)
const host = process.env.DEV_HOST || '0.0.0.0'
console.log(`[dev-debug] Host: ${host}`)
console.log('[dev-debug] Port: 3002')

const nextBin = path.join(process.cwd(), 'node_modules', '.bin', 'next')
// Passing the host explicitly prevents Next.js from enumerating network
// interfaces during startup. Some hardened Linux containers deny the
// uv_interface_addresses syscall even though binding a listener is allowed.
const args = ['dev', '-H', host, '-p', '3002']

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

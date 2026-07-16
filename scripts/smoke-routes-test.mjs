#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { rmSync, openSync, closeSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { killTestDevPort } from './kill-test-dev-port.mjs'

const port = Number(process.env.PORT || 3002)
const host = process.env.HOST || '127.0.0.1'
const externalBase = process.env.BASE_URL || ''
const base = externalBase || `http://${host}:${port}`
const ownsServer = !externalBase
const logPath = `/tmp/cts-k-n-test-dev-${port}.log`

async function killExisting() {
  await killTestDevPort(port)
  await sleep(300)
}

async function waitForRoute(path, attempts = 30) {
  let lastCode = '000'
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(`${base}${path}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      })
      lastCode = String(response.status)
      if (response.status === 200 || response.status === 307) return
    } catch {
      lastCode = '000'
    }
    await sleep(2000)
  }
  throw new Error(`FAIL:${path}=${lastCode}`)
}

let child = null

if (ownsServer) {
  await killExisting()
  rmSync('.next', { recursive: true, force: true })

  const out = openSync(logPath, 'w')
  child = spawn('npm', ['run', 'dev', '--', '--hostname', host], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, PORT: String(port) },
  })
  closeSync(out)
}

let exitCode = 0
try {
  let serverReady = false
  for (let i = 0; i < 90; i++) {
    try {
      const response = await fetch(base, {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      })
      if (response.ok || response.status === 307) {
        serverReady = true
        break
      }
    } catch {
      // dev server not ready yet
    }
    await sleep(1000)
  }
  if (!serverReady) {
    throw new Error(`FAIL:dev-server-startup-timeout=${base}`)
  }

  for (const path of ['/', '/main', '/strategies', '/settings', '/monitoring']) {
    await waitForRoute(path)
  }
} catch (error) {
  exitCode = 1
  console.error(error instanceof Error ? error.message : String(error))
} finally {
  if (ownsServer && child?.pid) {
    try { process.kill(-child.pid, 'SIGTERM') } catch {}
    await sleep(500)
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
    await killExisting()
  }
}

process.exit(exitCode)

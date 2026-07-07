#!/usr/bin/env node

/**
 * Production Deployment Initialization Script
 * Runs on Vercel after build completes to set up production runtime environment
 * 
 * Usage: node scripts/production-deploy-init.mjs
 * Called by: vercel.json build hook or post-deploy workflow
 */

import fetch from 'node-fetch'
import { setTimeout as sleep } from 'timers/promises'

const API_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL 
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : process.env.NEXT_PUBLIC_API_URL
  ? process.env.NEXT_PUBLIC_API_URL
  : 'http://localhost:3002'

console.log(`[Prod Init] Starting production deployment initialization`)
console.log(`[Prod Init] API URL: ${API_URL}`)
console.log(`[Prod Init] Environment: ${process.env.NODE_ENV || 'production'}`)
console.log(`[Prod Init] Timestamp: ${new Date().toISOString()}`)

async function waitForApiReady(maxAttempts = 30, delayMs = 2000) {
  console.log(`[Prod Init] Waiting for API to be ready (max ${maxAttempts * delayMs / 1000}s)...`)
  
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${API_URL}/api/system/status`, {
        method: 'GET',
        timeout: 5000,
      })
      
      if (response.ok) {
        console.log(`[Prod Init] ✓ API is ready`)
        return true
      }
    } catch (err) {
      // Still waiting...
    }
    
    if (i < maxAttempts - 1) {
      process.stdout.write('.')
      await sleep(delayMs)
    }
  }
  
  console.warn(`[Prod Init] ⚠ API did not respond after ${maxAttempts * delayMs / 1000}s - continuing anyway`)
  return false
}

async function initializeConnections() {
  console.log(`[Prod Init] Initializing trading connections...`)
  
  try {
    const response = await fetch(`${API_URL}/api/settings/connections`, {
      method: 'GET',
      timeout: 10000,
    })
    
    if (response.ok) {
      const connections = await response.json()
      console.log(`[Prod Init] ✓ Found ${connections?.length || 0} connections`)
      
      // List them
      for (const conn of (connections || [])) {
        console.log(`[Prod Init]   - ${conn.id}: ${conn.exchange} (enabled: ${conn.is_enabled_dashboard})`)
      }
    }
  } catch (err) {
    console.warn(`[Prod Init] ⚠ Could not fetch connections: ${err.message}`)
  }
}

async function triggerMigrations() {
  console.log(`[Prod Init] Triggering database migrations...`)
  
  try {
    const response = await fetch(`${API_URL}/api/system/initialize`, {
      method: 'POST',
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'migrate', force: false }),
    })
    
    if (response.ok) {
      const result = await response.json()
      console.log(`[Prod Init] ✓ Migrations completed: version ${result.version}`)
      return true
    } else {
      console.warn(`[Prod Init] ⚠ Migration request returned ${response.status}`)
    }
  } catch (err) {
    console.warn(`[Prod Init] ⚠ Could not trigger migrations: ${err.message}`)
  }
  
  return false
}

async function verifyProgressionState() {
  console.log(`[Prod Init] Verifying progression state...`)
  
  try {
    const response = await fetch(`${API_URL}/api/connections/progression/bingx-x01/stats`, {
      method: 'GET',
      timeout: 10000,
    })
    
    if (response.ok) {
      const stats = await response.json()
      console.log(`[Prod Init] ✓ Progression state found`)
      console.log(`[Prod Init]   Phase: ${stats?.metadata?.phase}`)
      console.log(`[Prod Init]   Symbols: ${stats?.metadata?.symbols}`)
    }
  } catch (err) {
    console.warn(`[Prod Init] ⚠ Could not verify progression: ${err.message}`)
  }
}

async function runHealthChecks() {
  console.log(`[Prod Init] Running health checks...`)
  
  const checks = [
    { name: 'System Status', url: '/api/system/status' },
    { name: 'Trade Engine', url: '/api/trade-engine/status' },
    { name: 'Connections', url: '/api/settings/connections' },
    { name: 'Dashboard Data', url: '/api/dashboard' },
  ]
  
  let passed = 0
  for (const check of checks) {
    try {
      const response = await fetch(`${API_URL}${check.url}`, {
        method: 'GET',
        timeout: 5000,
      })
      
      if (response.status < 300) {
        console.log(`[Prod Init] ✓ ${check.name}`)
        passed++
      } else {
        console.warn(`[Prod Init] ✗ ${check.name} (HTTP ${response.status})`)
      }
    } catch (err) {
      console.warn(`[Prod Init] ✗ ${check.name} (${err.message})`)
    }
  }
  
  console.log(`[Prod Init] Health checks: ${passed}/${checks.length} passed`)
  return passed === checks.length
}

async function main() {
  console.log(`\n${'='.repeat(70)}`)
  console.log(`PRODUCTION DEPLOYMENT INITIALIZATION`)
  console.log(`${'='.repeat(70)}\n`)
  
  // Wait for API to be ready
  await waitForApiReady()
  
  // Initialize connections
  await initializeConnections()
  
  // Trigger migrations (if needed)
  await triggerMigrations()
  
  // Wait a bit for migrations to complete
  await sleep(2000)
  
  // Verify progression state
  await verifyProgressionState()
  
  // Run health checks
  const healthy = await runHealthChecks()
  
  console.log(`\n${'='.repeat(70)}`)
  if (healthy) {
    console.log(`✓ PRODUCTION DEPLOYMENT READY`)
    console.log(`Timestamp: ${new Date().toISOString()}`)
    console.log(`API URL: ${API_URL}`)
  } else {
    console.warn(`⚠ PRODUCTION DEPLOYMENT PARTIAL (some checks failed)`)
    console.warn(`Please verify manually or check logs`)
  }
  console.log(`${'='.repeat(70)}\n`)
  
  process.exit(healthy ? 0 : 1)
}

main().catch(err => {
  console.error(`[Prod Init] Fatal error:`, err.message)
  process.exit(1)
})

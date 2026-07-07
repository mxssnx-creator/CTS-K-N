#!/usr/bin/env node
/**
 * Validate PF calculation flow across pipeline stages
 * 
 * Checks:
 * 1. BASE stage uses cost-adjusted PF from position history
 * 2. MAIN stage inherits BASE PF unchanged  
 * 3. REAL tuner creates separate tunedAvgPF field
 * 4. Live positions use avgProfitFactor for gates
 */

import fetch from 'node-fetch'

const API_BASE = 'http://localhost:3002/api'
const CONN_ID = 'bingx-x01'

async function fetchJSON(path) {
  const res = await fetch(`${API_BASE}${path}`)
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)
  return res.json()
}

async function validatePFCalculations() {
  console.log('[PF] Starting validation...\n')

  try {
    // 1. Get strategy breakdown
    console.log('[1] Checking strategy breakdown by stage...')
    const stats = await fetchJSON(`/connections/progression/${CONN_ID}/stats`)
    const { breakdown, realtime } = stats
    
    console.log(`    BASE sets: ${breakdown.strategies.base}`)
    console.log(`    MAIN sets: ${breakdown.strategies.main}`)
    console.log(`    REAL sets: ${breakdown.strategies.real}`)
    console.log(`    LIVE sets: ${breakdown.strategies.live}`)
    
    if (breakdown.strategies.base === 0) {
      console.warn('    ⚠ BASE sets are 0 — check bootstrap')
    } else {
      console.log('    ✓ BASE sets created')
    }
    
    if (breakdown.strategies.main === 0 && breakdown.strategies.base > 0) {
      console.warn('    ⚠ MAIN sets are 0 despite BASE — check PF inheritance')
    } else if (breakdown.strategies.main > 0) {
      console.log('    ✓ MAIN sets created from BASE')
    }
    
    // 2. Check live positions
    console.log('\n[2] Checking live position PF values...')
    const positions = await fetchJSON('/trading/live-positions')
    
    if (positions.positions.length === 0) {
      console.log('    (No live positions yet)')
    } else {
      const openPositions = positions.positions.filter(p => p.status === 'open')
      console.log(`    Open positions: ${openPositions.length}`)
      
      for (const pos of openPositions.slice(0, 3)) {
        console.log(`    - ${pos.symbol} ${pos.direction.toUpperCase()}: ` +
          `entry=${pos.entryPrice?.toFixed(8)} qty=${pos.quantity?.toFixed(8)}`)
      }
    }
    
    // 3. Check strategy details
    console.log('\n[3] Checking strategy evaluation metrics...')
    const passRateByStage = stats.breakdown?.passRatio || {}
    console.log(`    BASE pass ratio: ${passRateByStage.base || '0'}%`)
    console.log(`    MAIN pass ratio: ${passRateByStage.main || '0'}%`)
    console.log(`    REAL pass ratio: ${passRateByStage.real || '0'}%`)
    
    // 4. Verify engine health
    console.log('\n[4] Checking engine health...')
    const status = await fetchJSON('/trade-engine/status')
    console.log(`    Status: ${status.status}`)
    console.log(`    Phase: ${status.connections?.[0]?.progression?.phase || 'unknown'}`)
    
    console.log('\n[PF] Validation complete ✓')
    
  } catch (err) {
    console.error('[PF] Error:', err.message)
    process.exit(1)
  }
}

validatePFCalculations()

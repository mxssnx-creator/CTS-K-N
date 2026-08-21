#!/usr/bin/env node

/**
 * TP/SL range regression verifier.
 *
 * Fresh set grids are intentionally defined centrally rather than duplicated
 * as loops in each engine:
 * - TP PositionCost multiples: 5, 10, 15, 20 (fresh default; 5 is the
 *   minimum supported fresh step)
 * - Stop-loss ratios: 0.25 to 2.5 in 0.25 increments
 *
 * Existing explicitly saved legacy grids remain readable.  This verifier
 * covers only the fresh defaults that every generator must share.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

console.log('\n=== TP/SL RANGE REGRESSION VALIDATION ===\n')

const failures = []
const assertContains = (content, fragment, label) => {
  if (!content.includes(fragment)) failures.push(label)
}

console.log('1. CANONICAL TP POSITION-COST GRID')
const positionCostPath = path.join(process.cwd(), 'lib/position-cost.ts')
const positionCostContent = fs.readFileSync(positionCostPath, 'utf8')
assertContains(positionCostContent, 'DEFAULT_TAKE_PROFIT_POSITION_COST_RATIO = 5', 'TP minimum must be five PositionCost multiples')
assertContains(positionCostContent, 'DEFAULT_TAKE_PROFIT_POSITION_COST_STEPS = [5, 10, 15, 20]', 'TP default grid must be [5, 10, 15, 20]')
console.log('   ✓ TP factors: 5, 10, 15, 20 (4 values)')
console.log('   ✓ Fresh TP minimum: 5 PositionCost multiples')

console.log('\n2. CANONICAL STOP-LOSS GRID')
const stopLossPath = path.join(process.cwd(), 'lib/stoploss-ratio-range.ts')
const stopLossContent = fs.readFileSync(stopLossPath, 'utf8')
assertContains(stopLossContent, 'STOP_LOSS_RATIO_MIN = 0.25', 'stop-loss minimum must come from the canonical module')
assertContains(stopLossContent, 'STOP_LOSS_RATIO_MAX = 2.5', 'stop-loss maximum must come from the canonical module')
assertContains(stopLossContent, 'STOP_LOSS_RATIO_STEP = 0.25', 'stop-loss step must come from the canonical module')
assertContains(stopLossContent, 'buildStopLossRatios', 'canonical stop-loss builder missing')
console.log('   ✓ SL ratios: 0.25–2.5 in 0.25 steps (10 values)')

console.log('\n3. ENGINE CONSUMERS')
const indPath = path.join(process.cwd(), 'lib/indications.ts')
const indContent = fs.readFileSync(indPath, 'utf8')
const ismPath = path.join(process.cwd(), 'lib/indication-state-manager.ts')
const ismContent = fs.readFileSync(ismPath, 'utf8')
assertContains(indContent, 'DEFAULT_TAKE_PROFIT_POSITION_COST_STEPS', 'Indication engine does not use canonical TP grid')
assertContains(indContent, 'buildStopLossRatios', 'Indication engine does not use canonical SL grid')
assertContains(ismContent, 'DEFAULT_TAKE_PROFIT_POSITION_COST_STEPS', 'Indication state manager does not use canonical TP grid')
assertContains(ismContent, 'buildStopLossRatios', 'Indication state manager does not use canonical SL grid')
console.log('   ✓ indication engines consume canonical TP and SL builders')

// Calculate expected config count
const tpCount = 4
const slCount = 10
const trailingCount = 4
const configsPerDirection = tpCount * slCount * trailingCount
const configsPerSymbol = configsPerDirection * 2  // Long and short

console.log('\n4. EXPECTED STRATEGY CONFIGURATIONS')
console.log(`   • TP Factors: ${tpCount}`)
console.log(`   • SL Ratios: ${slCount}`)
console.log(`   • Trailing Options: ${trailingCount}`)
console.log(`   • Configs per Direction: ${tpCount} × ${slCount} × ${trailingCount} = ${configsPerDirection.toLocaleString()}`)
console.log(`   • Total per Symbol (Long + Short): ${configsPerSymbol.toLocaleString()}`)
console.log(`   • For 20 symbols: ${(configsPerSymbol * 20).toLocaleString()} strategies`)

// Check indication-calculator's diagnostic derives the same cardinality.
console.log('\n5. INDICATION CALCULATOR - Verification')
const icPath = path.join(process.cwd(), 'lib/indication-calculator.ts')
const icContent = fs.readFileSync(icPath, 'utf8')
assertContains(icContent, 'DEFAULT_TAKE_PROFIT_POSITION_COST_STEPS.length', 'calculator does not derive TP count from canonical grid')
assertContains(icContent, 'Math.floor((2.5 - 0.25) / 0.25) + 1', 'calculator SL count is not aligned to canonical grid')
console.log('   ✓ calculator cardinality matches the canonical grids')

if (failures.length > 0) {
  console.error(`\nTP/SL regression validation failed:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log('\n=== VALIDATION PASSED ===\n')
}

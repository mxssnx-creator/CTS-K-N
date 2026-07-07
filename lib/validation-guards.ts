/**
 * Validation guards for trailing stops and block strategy
 * These functions perform edge case checks and log warnings (not rejections)
 * to help diagnose issues without interrupting engine operation
 */

/**
 * Validate trailing stop parameters and conditions
 * Returns warnings array (empty if all valid) without rejecting the operation
 */
export function validateTrailingStopEdgeCases(
  symbol: string,
  fillPrice: number,
  leverage: number,
  slPct: number,
  trailingActive: boolean,
  currentTrailingStop: number,
  lastPrice: number
): string[] {
  const warnings: string[] = []

  // Guard: leverage too high for trailing (extreme SL distance)
  if (leverage > 20 && slPct > 0.02) {
    warnings.push(
      `[v0] [GUARD] ${symbol} trailing with extreme leverage=${leverage} and slPct=${slPct}; ` +
      `SL distance may be too large for stable ratcheting`
    )
  }

  // Guard: trailing minimum distance too small (0.5% minimum recommended)
  if (trailingActive && slPct < 0.005) {
    warnings.push(
      `[v0] [GUARD] ${symbol} trailing slPct=${slPct} is very small (<0.5%); ` +
      `may cause excessive ratchets and unnecessary SL updates`
    )
  }

  // Guard: price overshoot (SL already breached on same tick)
  if (trailingActive && currentTrailingStop > 0) {
    const breached = lastPrice <= currentTrailingStop
    if (breached) {
      warnings.push(
        `[v0] [GUARD] ${symbol} trailing SL already breached: lastPrice=${lastPrice} <= SL=${currentTrailingStop}; ` +
        `position should have closed on prior tick`
      )
    }
  }

  // Guard: rapid consecutive ratchets (more than 1 ratchet per 100ms)
  if (trailingActive && fillPrice > 0 && lastPrice > 0) {
    const priceChange = Math.abs(lastPrice - fillPrice) / fillPrice
    if (priceChange > 0.05 && slPct < 0.01) {
      // 5%+ price move with <1% SL distance = potential rapid ratchets
      warnings.push(
        `[v0] [GUARD] ${symbol} trailing: large price move (${(priceChange * 100).toFixed(2)}%) with tight SL (${slPct * 100}%); ` +
        `potential for rapid ratchet cascade`
      )
    }
  }

  // Guard: stale price data (same price for multiple cycles)
  if (trailingActive && lastPrice <= 0) {
    warnings.push(
      `[v0] [GUARD] ${symbol} trailing: stale/missing lastPrice=${lastPrice}; ` +
      `cannot compute trailing ratchet, SL unchanged`
    )
  }

  return warnings
}

/**
 * Validate block strategy parameters and conditions
 * Returns warnings array (empty if all valid) without rejecting the operation
 */
export function validateBlockStrategyEdgeCases(
  symbol: string,
  blockStackDepth: number,
  blockMaxStack: number,
  sizeMultiplier: number,
  continuousCount: number,
  positionCount: number,
  isIndependentBlock: boolean
): string[] {
  const warnings: string[] = []

  // Guard: stack overflow approaching (>80% of max)
  if (blockStackDepth >= blockMaxStack * 0.8) {
    warnings.push(
      `[v0] [GUARD] ${symbol} block stack at ${blockStackDepth}/${blockMaxStack} (${((blockStackDepth / blockMaxStack) * 100).toFixed(0)}%); ` +
      `approaching max allowed blocks`
    )
  }

  // Guard: stack overflow imminent (at max)
  if (blockStackDepth >= blockMaxStack) {
    warnings.push(
      `[v0] [GUARD] ${symbol} block stack at MAX (${blockStackDepth}/${blockMaxStack}); ` +
      `cannot create new block, gate should prevent this`
    )
  }

  // Guard: extreme size multiplier (>3x or <0.3x)
  if (sizeMultiplier > 3 || sizeMultiplier < 0.3) {
    warnings.push(
      `[v0] [GUARD] ${symbol} block size multiplier=${sizeMultiplier} is extreme; ` +
      `recommended range [0.5, 2.0]`
    )
  }

  // Guard: independent block with existing positions (may be confusing but allowed)
  if (isIndependentBlock && continuousCount > 0) {
    warnings.push(
      `[v0] [GUARD] ${symbol} independent block created but ${continuousCount} continuous position(s) exist; ` +
      `block is firing standalone (expected behavior, just noting)`
    )
  }

  // Guard: add-on block with no positions (gate should prevent, but log if it happens)
  if (!isIndependentBlock && continuousCount === 0) {
    warnings.push(
      `[v0] [GUARD] ${symbol} add-on block attempted with 0 open positions; ` +
      `gate should have prevented this, check gate logic`
    )
  }

  // Guard: position count mismatch (blocks don't match position reality)
  if (blockStackDepth > 0 && positionCount === 0) {
    warnings.push(
      `[v0] [GUARD] ${symbol} block stack depth=${blockStackDepth} but positionCount=0; ` +
      `orphaned block entries, reconcile or close manually`
    )
  }

  // Guard: extreme position count (>10 per symbol)
  if (positionCount > 10) {
    warnings.push(
      `[v0] [GUARD] ${symbol} has ${positionCount} open positions; ` +
      `unusual concentration, verify no orphaned/duplicate entries`
    )
  }

  return warnings
}

/**
 * Log validation warnings with context
 * Called after validation functions return warnings
 */
export function logValidationWarnings(warnings: string[], context: string): void {
  if (warnings.length === 0) return
  
  warnings.forEach(warning => {
    console.warn(warning)
  })
  
  if (warnings.length > 2) {
    console.warn(
      `[v0] [GUARD] Multiple warnings in ${context} — review conditions above`
    )
  }
}

/**
 * Guard helper: check if price movement is anomalous
 * Returns true if movement exceeds expected bounds
 */
export function isAnomalousPrice(
  lastPrice: number,
  previousPrice: number,
  maxChangePercent: number = 5 // 5% default
): boolean {
  if (lastPrice <= 0 || previousPrice <= 0) return false
  
  const changePercent = Math.abs(lastPrice - previousPrice) / previousPrice * 100
  return changePercent > maxChangePercent
}

/**
 * Guard helper: check if ratchet distance is reasonable
 * Warns if ratchet is unusually large (>2x SL distance)
 */
export function isExcessiveRatchet(
  ratchetDistance: number,
  slDistance: number
): boolean {
  if (slDistance <= 0) return false
  
  const ratio = ratchetDistance / slDistance
  return ratio > 2
}

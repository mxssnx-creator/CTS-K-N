/**
 * Calculate indication parameter ranges based on 50% from default value
 * with dynamic step sizes based on value magnitude
 */

export interface IndicationParameterRange {
  min: number
  max: number
  step: number
  default: number
}

/**
 * Calculate step size based on default value:
 * - Round number over 10: step 1
 * - 2-5: step 0.5
 * - 0.1 to 2: step 0.1
 * - 0.0x (like 0.01, 0.05): step 0.01
 */
export function calculateStepSize(defaultValue: number): number {
  const absValue = Math.abs(defaultValue)

  if (absValue >= 10 && Number.isInteger(defaultValue)) {
    return 1
  } else if (absValue >= 2 && absValue <= 5) {
    return 0.5
  } else if (absValue >= 0.1 && absValue < 2) {
    return 0.1
  } else if (absValue < 0.1) {
    return 0.01
  }

  return 1 // fallback
}

/**
 * Calculate 60% range from default value (updated from 50%)
 */
export function calculateRange(defaultValue: number, rangePercent = 0.6): IndicationParameterRange {
  const step = calculateStepSize(defaultValue)

  const min = Math.max(0, defaultValue - defaultValue * rangePercent)
  const max = defaultValue + defaultValue * rangePercent

  // Round to step precision
  const roundedMin = Math.round(min / step) * step
  const roundedMax = Math.round(max / step) * step

  return {
    min: roundedMin,
    max: roundedMax,
    step,
    default: defaultValue,
  }
}

/**
 * Common indicator defaults with calculated ranges
 * Updated to work with trade engine and proper step values
 */
export const INDICATOR_DEFAULTS = {
  rsi: {
    period: calculateRange(14), // 8.4-22.4, step 1
    oversold: calculateRange(30), // 18-48, step 1
    overbought: calculateRange(70), // 42-98, step 1 (capped at 100 in UI)
  },
  macd: {
    fastPeriod: calculateRange(12), // 7.2-19.2, step 1
    slowPeriod: calculateRange(26), // 15.6-37.6, step 1
    signalPeriod: calculateRange(9), // 5.4-12.6, step 1
  },
  bollinger: {
    period: calculateRange(20), // 12-32, step 1
    stdDev: calculateRange(2), // 1.2-3.2, step 0.5
  },
  sar: {
    acceleration: calculateRange(0.02), // 0.012-0.032, step 0.01
    maximum: calculateRange(0.2), // 0.12-0.32, step 0.1
  },
  adx: {
    period: calculateRange(14), // 8.4-22.4, step 1
    threshold: calculateRange(25), // 15-40, step 1
  },
  ema: {
    period: calculateRange(20), // 12-32, step 1
  },
  sma: {
    period: calculateRange(20), // 12-32, step 1
  },
  stochastic: {
    kPeriod: calculateRange(14), // 8.4-22.4, step 1
    dPeriod: calculateRange(3), // 1.8-4.8, step 0.5
    smooth: calculateRange(3), // 1.8-4.8, step 0.5
  },
  atr: {
    period: calculateRange(14), // 8.4-22.4, step 1
  },
  cci: {
    period: calculateRange(20), // 12-32, step 1
  },
  mfi: {
    period: calculateRange(14), // 8.4-22.4, step 1
  },
  obv: {
    // OBV doesn't have configurable parameters
  },
  vwap: {
    // VWAP doesn't have configurable parameters
  },
} as const

/**
 * Get default parameters for an indicator type
 */
export function getIndicatorDefaults(indicatorType: string): Record<string, IndicationParameterRange> {
  return INDICATOR_DEFAULTS[indicatorType as keyof typeof INDICATOR_DEFAULTS] || {}
}

/**
 * Generate all possible parameter combinations for an indicator
 */
export function generateParameterCombinations(
  indicatorType: string,
  customRanges?: Record<string, Partial<IndicationParameterRange>>,
): Record<string, any>[] {
  const defaults = getIndicatorDefaults(indicatorType)
  const combinations: Record<string, any>[] = []

  // Merge custom ranges with defaults
  const ranges: Record<string, IndicationParameterRange> = {}
  for (const [key, defaultRange] of Object.entries(defaults)) {
    ranges[key] = {
      ...defaultRange,
      ...(customRanges?.[key] || {}),
    }
  }

  // Generate combinations
  const paramKeys = Object.keys(ranges)
  if (paramKeys.length === 0) return [{}]

  function generateRecursive(index: number, current: Record<string, any>): void {
    if (index === paramKeys.length) {
      combinations.push({ ...current })
      return
    }

    const key = paramKeys[index]
    const range = ranges[key]

    for (let value = range.min; value <= range.max; value += range.step) {
      current[key] = Math.round(value * 100) / 100 // Round to 2 decimals
      generateRecursive(index + 1, current)
    }
  }

  generateRecursive(0, {})
  return combinations
}

/**
 * Calculate position step range based on indication step and ratio settings
 * @param indicationStep The step size for indication parameters
 * @param minRatio Minimum ratio (default: 0.2)
 * @param maxRatio Maximum ratio (default: 1.0)
 * @returns Object with min and max position step values
 */
export function calculatePositionStepRange(
  indicationStep: number,
  minRatio = 0.2,
  maxRatio = 1.0,
): { min: number; max: number } {
  if (indicationStep <= 0) {
    throw new Error("Indication step must be greater than 0")
  }

  if (minRatio <= 0 || maxRatio <= 0) {
    throw new Error("Ratios must be greater than 0")
  }

  if (minRatio > maxRatio) {
    throw new Error("Minimum ratio cannot be greater than maximum ratio")
  }

  const minStep = Math.max(1, Math.round(indicationStep * minRatio))
  const maxStep = Math.max(minStep, Math.round(indicationStep * maxRatio))

  return {
    min: minStep,
    max: maxStep,
  }
}

/**
 * Validate if a position step is within the allowed range for a given indication step
 * @param positionStep The position step to validate
 * @param indicationStep The indication step
 * @param minRatio Minimum ratio (default: 0.2)
 * @param maxRatio Maximum ratio (default: 1.0)
 * @returns true if valid, false otherwise
 */
export function isValidPositionStep(
  positionStep: number,
  indicationStep: number,
  minRatio = 0.2,
  maxRatio = 1.0,
): boolean {
  const range = calculatePositionStepRange(indicationStep, minRatio, maxRatio)
  return positionStep >= range.min && positionStep <= range.max
}

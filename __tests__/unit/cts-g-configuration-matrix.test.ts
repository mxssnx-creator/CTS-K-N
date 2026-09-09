import { buildCtsGConfigurations, ctsGConfigurationKey, evaluateCtsGTrend, evaluateCtsGBreak } from '@/lib/cts-g-indications'
import { calculateIndicationConfigurationCounts } from '@/lib/indication-configuration-counts'
import { isConnectionVisibleInServerOverview } from '@/lib/connection-state-utils'

test.each(['trend', 'break'] as const)('%s matrix preserves baseline, unique identities and count parity', kind => {
  const configs = buildCtsGConfigurations(kind)
  const expected = kind === 'trend' ? 18 : 12
  expect(configs).toHaveLength(expected)
  expect(configs[0]).toEqual(buildCtsGConfigurations(kind, { ctsGConfigMode: 'single' })[0])
  expect(new Set(configs.map(ctsGConfigurationKey)).size).toBe(expected)
  const counts = calculateIndicationConfigurationCounts({}, undefined).types.find(row => row.type === kind)!
  expect(counts.evaluationConfigurations).toBe(configs.length * 4)
  expect(counts.possibleSets).toBe(configs.length * 8)
  const evaluate = kind === 'trend' ? evaluateCtsGTrend : evaluateCtsGBreak
  for (const direction of ['long', 'short']) {
    const prices = Array.from({ length: 80 }, (_, i) => direction === 'long' ? 100 + i : 200 - i)
    for (const config of configs) expect(evaluate(prices, config)?.direction).toBe(direction)
  }
  for (const config of configs) expect(evaluate(Array(80).fill(100), config)).toBeNull()
})

test('bounded Break axes deduplicate saturated ranges and zero noise', () => {
  const settings = { breakRange: 240, breakNoisePct: 0 }
  expect(buildCtsGConfigurations('break', settings)).toHaveLength(2)
  const counts = calculateIndicationConfigurationCounts(settings, undefined).types.find(row => row.type === 'break')!
  expect(counts.evaluationConfigurations).toBe(8)
  expect(buildCtsGConfigurations('trend', { ctsGMinimumConfidence: 0 })[0].minimumConfidence).toBe(0)
})

test('new period/confirmation identities retain the baseline and reject invalid relationships', () => {
  const baseline = buildCtsGConfigurations('trend', { ctsGConfigMode: 'single' })[0]
  expect(ctsGConfigurationKey(baseline)).toBe('spread0.001:confidence0.6:range16:noise0.05:confirm3')
  const prices = Array.from({ length: 50 }, (_, i) => 100 + i)
  expect(evaluateCtsGTrend(prices, { fastPeriod: 21, slowPeriod: 8 })).toBeNull()
  expect(evaluateCtsGTrend(prices.slice(0, 40), { fastPeriod: 13, slowPeriod: 34 })).toBeNull()
  expect(evaluateCtsGTrend(prices, { fastPeriod: 13, slowPeriod: 34 })?.metadata.model).toBe('cts-g-ema13-34')
  expect(buildCtsGConfigurations('trend', { ctsGTrendMultiplePeriods: false })).toHaveLength(6)
  expect(buildCtsGConfigurations('break', { ctsGBreakMultipleConfirmations: false })).toHaveLength(6)
})

test('two-bar Break waits for two closes beyond the same prior range', () => {
  const oneBreak = [...Array(40).fill(100), 102]
  expect(evaluateCtsGBreak(oneBreak, { breakConfirmationBars: 1 })?.direction).toBe('long')
  expect(evaluateCtsGBreak(oneBreak, { breakConfirmationBars: 2 })).toBeNull()
  expect(evaluateCtsGBreak([...oneBreak, 103], { breakConfirmationBars: 2 })?.metadata.confirmationBars).toBe(2)
})

test('server overview requires both Base flags and handles Redis flag representations', () => {
  for (const flag of [true, 1, '1', 'true']) expect(isConnectionVisibleInServerOverview({ is_inserted: flag, is_enabled: flag })).toBe(true)
  for (const flags of [{}, { is_enabled: true }, { is_inserted: true }, { is_inserted: true, is_enabled: '0', is_enabled_dashboard: true }]) expect(isConnectionVisibleInServerOverview(flags)).toBe(false)
})

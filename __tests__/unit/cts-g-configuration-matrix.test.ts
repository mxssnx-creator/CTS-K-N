import { buildCtsGConfigurations, ctsGConfigurationKey, evaluateCtsGTrend, evaluateCtsGBreak } from '@/lib/cts-g-indications'
import { calculateIndicationConfigurationCounts } from '@/lib/indication-configuration-counts'
import { isConnectionVisibleInServerOverview } from '@/lib/connection-state-utils'

test.each(['trend', 'break'] as const)('%s matrix preserves baseline, unique identities and count parity', kind => {
  const configs = buildCtsGConfigurations(kind)
  expect(configs).toHaveLength(6)
  expect(configs[0]).toEqual(buildCtsGConfigurations(kind, { ctsGConfigMode: 'single' })[0])
  expect(new Set(configs.map(ctsGConfigurationKey)).size).toBe(6)
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
  expect(buildCtsGConfigurations('break', settings)).toHaveLength(1)
  const counts = calculateIndicationConfigurationCounts(settings, undefined).types.find(row => row.type === 'break')!
  expect(counts.evaluationConfigurations).toBe(4)
  expect(buildCtsGConfigurations('trend', { ctsGMinimumConfidence: 0 })[0].minimumConfidence).toBe(0)
})

test('server overview requires both Base flags and handles Redis flag representations', () => {
  for (const flag of [true, 1, '1', 'true']) expect(isConnectionVisibleInServerOverview({ is_inserted: flag, is_enabled: flag })).toBe(true)
  for (const flags of [{}, { is_enabled: true }, { is_inserted: true }, { is_inserted: true, is_enabled: '0', is_enabled_dashboard: true }]) expect(isConnectionVisibleInServerOverview(flags)).toBe(false)
})

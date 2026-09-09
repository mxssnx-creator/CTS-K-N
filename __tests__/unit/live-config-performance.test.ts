const hashes = new Map<string, Record<string, string>>()
const sorted = new Map<string, Map<string, number>>()
const mockSettings = { liveConfigLossWindow: 5, liveConfigAutoDeactivateEnabled: true }
const mockClient = {
  hget: jest.fn(async (key: string, field: string) => hashes.get(key)?.[field] ?? null),
  hset: jest.fn(async (key: string, fields: Record<string, string>) => { hashes.set(key, { ...hashes.get(key), ...fields }); return 1 }),
  zadd: jest.fn(async (key: string, score: number, member: string) => { const index = sorted.get(key) || new Map(); index.set(member, score); sorted.set(key, index); return 1 }),
  zrange: jest.fn(async (key: string, start: number, end: number) => [...(sorted.get(key) || new Map()).entries()].sort((a,b) => a[1]-b[1]).map(([id]) => id).slice(start,end+1)),
  zcard: jest.fn(async (key: string) => sorted.get(key)?.size || 0),
}
jest.mock('@/lib/redis-db', () => ({
  getRedisClient: () => mockClient,
  getAppSettings: async () => mockSettings,
  withSharedPersistenceLease: async (_scope: string, fn: () => Promise<unknown>) => fn(),
}))

import { confirmedLiveConfigOutcome, recordLiveConfigOutcome, findDeactivatedLiveConfig, listDeactivatedLiveConfigs, updateLiveConfigOutcome } from '@/lib/live-config-performance'
import { liveConfigLossPolicy, normalizeLiveConfigLossWindow } from '@/lib/live-config-loss-policy'

const row = (n: number, overrides = {}) => ({
  id: `p${n}`, connectionId: 'x02', symbol: 'BTCUSDT', direction: 'long', setKey: 'trend#ema8-21',
  executionMode: 'live', executionIntent: 'main', status: 'closed', orderId: `venue${n}`,
  executedQuantity: 0.001, remainingQuantity: 0, realizedPnlComplete: true,
  realizedPnlSource: 'exchange_settlement', realizedPnL: -1, closedAt: 1000 + n, ...overrides,
})

beforeEach(() => { hashes.clear(); sorted.clear(); jest.clearAllMocks(); mockSettings.liveConfigLossWindow = 5; mockSettings.liveConfigAutoDeactivateEnabled = true })

test('operator range is integer 5–25, default 12; string false stays false', () => {
  expect([undefined, null, '', NaN].map(normalizeLiveConfigLossWindow)).toEqual([12,12,12,12])
  expect([1, 5, 12.4, 12.8, 99].map(normalizeLiveConfigLossWindow)).toEqual([5,5,12,13,25])
  expect(liveConfigLossPolicy().enabled).toBe(true)
  expect(liveConfigLossPolicy({ liveConfigAutoDeactivateEnabled: 'false' }).enabled).toBe(false)
})

test.each([
  { executionMode: 'simulation' }, { status: 'rejected' }, { status: 'open' },
  { realizedPnlComplete: false }, { realizedPnlSource: 'exchange_fills_incomplete_fees' },
  { realizedPnlSource: 'simulation_model' }, { realizedPnL: undefined }, { realizedPnL: NaN },
  { executedQuantity: 0 }, { orderId: undefined }, { remainingQuantity: 1 },
])('excludes non-confirmed/unfinished outcomes: %j', async override => {
  expect(confirmedLiveConfigOutcome(row(1, override))).toBeNull()
  await recordLiveConfigOutcome(row(1, override))
  expect(mockClient.hset).not.toHaveBeenCalled()
})

test('full negative window latches exact Set, direction, connection and intent only', async () => {
  for (let n=1;n<=4;n++) await recordLiveConfigOutcome(row(n))
  expect(await findDeactivatedLiveConfig('x02', row(1), mockSettings)).toBeNull()
  await recordLiveConfigOutcome(row(5))
  expect(await findDeactivatedLiveConfig('x02', row(1), mockSettings)).toMatchObject({ netPnl: -5, window: 5, sampleCount: 5 })
  for (const override of [{ setKey: 'trend#ema13-34' }, { direction: 'short' }, { executionIntent: 'direct' }]) {
    expect(await findDeactivatedLiveConfig('x02', row(1, override), mockSettings)).toBeNull()
  }
  expect(await findDeactivatedLiveConfig('x01', row(1), mockSettings)).toBeNull()
  await recordLiveConfigOutcome(row(6, { realizedPnL: 100 }))
  expect((await listDeactivatedLiveConfigs('x02')).rows[0].netPnl).toBe(-5)
  expect(await findDeactivatedLiveConfig('x02', row(1), { liveConfigAutoDeactivateEnabled: false })).toBeNull()
})

test('duplicates, concurrent saves and out-of-order settlements preserve a bounded last-N window', async () => {
  mockSettings.liveConfigAutoDeactivateEnabled = false
  await Promise.all(Array.from({ length: 40 }, (_, i) => recordLiveConfigOutcome(row(i))))
  await Promise.all(Array.from({ length: 8 }, () => recordLiveConfigOutcome(row(39))))
  await recordLiveConfigOutcome(row(0, { realizedPnL: -999 }))
  const states = Object.values(hashes.get('live:config-outcomes:x02') || {}).map(raw => JSON.parse(raw))
  expect(states).toHaveLength(1)
  expect(states[0].samples).toHaveLength(25)
  expect(states[0].samples[0].id).toBe('p39')
  expect(states[0].samples.at(-1).id).toBe('p15')
  expect(await listDeactivatedLiveConfigs('x02')).toEqual({ rows: [], total: 0 })
})

test('zero is not negative; fees can make a nominal win negative; changing window retains latch', () => {
  const meta = { id: 'id', setKey: 'set', symbol: 'BTCUSDT', direction: 'long', executionIntent: 'main' }
  const samples = Array.from({ length: 5 }, (_, i) => ({ id: String(i), closedAt: i+1, pnl: i === 4 ? -4 : 1 }))
  let state = updateLiveConfigOutcome({ samples }, samples[4], meta, { enabled: true, window: 5 }, 10)
  expect(state.disabled).toBeUndefined()
  state = updateLiveConfigOutcome(state, { ...samples[4], pnl: -4.01 }, meta, { enabled: true, window: 5 }, 11)
  expect(state.disabled?.netPnl).toBeCloseTo(-0.01)
  expect(updateLiveConfigOutcome(state, { id: 'later', closedAt: 100, pnl: 50 }, meta, { enabled: true, window: 25 }, 12).disabled).toEqual(state.disabled)
})

test('participating Sets are deduplicated and the unexecuted parent is excluded', async () => {
  for (let n=0;n<5;n++) await recordLiveConfigOutcome(row(n, { parentSetKey: 'parent', accumulatedSetKeys: ['trend#ema8-21', 'block#count2', 'block#count2'] }))
  expect((await listDeactivatedLiveConfigs('x02')).total).toBe(2)
  expect((await listDeactivatedLiveConfigs('x02', 1, 1)).rows).toHaveLength(1)
  expect(await findDeactivatedLiveConfig('x02', row(1, { setKey: 'parent' }), mockSettings)).toBeNull()
})

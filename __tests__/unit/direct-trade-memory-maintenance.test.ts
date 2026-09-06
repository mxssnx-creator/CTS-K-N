jest.mock('@/lib/direct-trade-config-store', () => ({ cleanupDirectTradeOrphanChunks: jest.fn() }))
import { cleanupDirectTradeOrphanChunks } from '@/lib/direct-trade-config-store'
import { maintainDirectTradeMemory } from '@/lib/direct-trade-memory-maintenance'
const cleanup = cleanupDirectTradeOrphanChunks as jest.Mock
beforeEach(() => cleanup.mockReset())
test('shared cadence prevents duplicate work and resumes a bounded scan', async () => {
  const client = { set: jest.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce('OK').mockResolvedValue(null), get: jest.fn().mockResolvedValue('123') }
  cleanup.mockResolvedValue({ cursor: '456', removed: 2, skippedActiveLease: false })
  await maintainDirectTradeMemory(client, 'bingx-x02')
  await maintainDirectTradeMemory(client, 'bingx-x02')
  expect(cleanup).toHaveBeenCalledTimes(1)
  expect(cleanup).toHaveBeenCalledWith(client, { connectionId: 'bingx-x02', apply: true, cursor: '123', maxPages: 20 })
  expect(client.set.mock.calls[0][2]).toEqual({ NX: true, EX: 300 })
  expect(client.set.mock.calls[1][1]).toBe('456')
})
test('an active calculation retains the maintenance cursor for the next sweep', async () => {
  const client = { set: jest.fn().mockResolvedValue('OK'), get: jest.fn().mockResolvedValue('123') }
  cleanup.mockResolvedValue({ cursor: '123', skippedActiveLease: true })
  await maintainDirectTradeMemory(client, 'bingx-x02')
  expect(client.set).toHaveBeenCalledTimes(1)
})

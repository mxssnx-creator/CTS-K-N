import { cleanupDirectTradeOrphanChunks } from './direct-trade-config-store'
import { directTradeKeyspace } from './direct-trade-keyspace'

/** One bounded sweep per connection every five minutes, shared across workers. */
export async function maintainDirectTradeMemory(client: any, connectionId: string): Promise<void> {
  const prefix = `${directTradeKeyspace(connectionId).configs}:maintenance`
  // No expensive database walk on the high-frequency heartbeat path. The
  // durable NX cadence also prevents duplicate scans after module reloads.
  const acquired = await client.set(`${prefix}:cadence`, '1', { NX: true, EX: 300 })
  if (acquired !== 'OK' && acquired !== true) return
  const cursor = await client.get(`${prefix}:cursor`) || '0'
  const result = await cleanupDirectTradeOrphanChunks(client, {
    connectionId, apply: true, cursor, maxPages: 20,
  })
  if (!result.skippedActiveLease) {
    await client.set(`${prefix}:cursor`, result.cursor, { EX: 86400 })
  }
}

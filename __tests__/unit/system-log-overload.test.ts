const mockHashes = new Map<string, Record<string, string>>()
const mockLists = new Map<string, string[]>()
const mockClient = {
  pipeline: () => {
    const operations: (() => unknown)[] = []
    const pipeline: any = {
      hset: (key: string, row: Record<string, string>) => { operations.push(() => { mockHashes.set(key, row); return 1 }); return pipeline },
      lpush: (key: string, id: string) => { operations.push(() => { const list = mockLists.get(key) || []; list.unshift(id); mockLists.set(key, list); return list.length }); return pipeline },
      lrange: (key: string, start: number, end: number) => { operations.push(() => (mockLists.get(key) || []).slice(start, end + 1)); return pipeline },
      ltrim: (key: string, start: number, end: number) => { operations.push(() => { mockLists.set(key, (mockLists.get(key) || []).slice(start, end + 1)); return "OK" }); return pipeline },
      expire: () => { operations.push(() => 1); return pipeline },
      del: (key: string) => { operations.push(() => Number(mockHashes.delete(key))); return pipeline },
      exec: async () => operations.map(operation => operation()),
    }
    return pipeline
  },
}
jest.mock("@/lib/redis-db", () => ({ getRedisClient: () => mockClient }))
import { SystemLogger } from "@/lib/system-logger"

it("caps queued memory, detaches metadata and removes hashes evicted from the 1000-log archive", async () => {
  const old = Array.from({ length: 1000 }, (_, i) => `log:1:old${i}`)
  mockLists.set("logs:all:list", [...old])
  for (const id of old) mockHashes.set(id, { id })
  const metadata = { values: Array.from({ length: 50_000 }, (_, i) => i), label: "before" }
  for (let i = 0; i < 1500; i++) await SystemLogger.logToDatabase({ timestamp: new Date().toISOString(), level: "info", category: "test", message: `event ${i}`, metadata })
  const globals = (globalThis as any).__v0_system_logger
  expect(globals.queue).toHaveLength(1000)
  expect(globals.queue[0].metadata.values.length).toBeLessThanOrEqual(13)
  metadata.label = "after"
  for (let tick = 0; tick < 100 && (globals.flushing || globals.queue.length); tick++) await new Promise<void>(resolve => setImmediate(resolve))
  expect(globals.queue).toHaveLength(0)
  expect(mockLists.get("logs:all:list")).toHaveLength(1000)
  expect(mockHashes.size).toBe(1000)
  expect(old.some(id => mockHashes.has(id))).toBe(false)
  for (const row of mockHashes.values()) {
    expect(JSON.parse(row.metadata).label).toBe("before")
    expect(row.metadata.length).toBeLessThanOrEqual(8192)
  }
})

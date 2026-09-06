import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { buildProgressionScope } from "@/lib/progression-scope"

describe("completed pipeline outcome accounting", () => {
  beforeAll(async () => { await initRedis() })
  test("quiet and productive passes succeed; a partial pipeline error fails once", async () => {
    const id = `pipeline-outcome-${Date.now()}`
    const client = getRedisClient()
    const key = buildProgressionScope(id).legacyProgressionKey
    try {
      await ProgressionStateManager.recordPipelineCycle(id, [{}, {}])
      await ProgressionStateManager.recordPipelineCycle(id, [{}, { error: "market read failed" }])
      await ProgressionStateManager.recordPipelineCycle(id, [])
      await ProgressionStateManager.recordPipelineCycle(id, [{}])
      const counters = await client.hgetall(key)
      expect(Number(counters.cycles_completed)).toBe(3)
      expect(Number(counters.successful_cycles)).toBe(2)
      expect(Number(counters.failed_cycles)).toBe(1)
    } finally {
      await client.del(key)
    }
  })

  test("300 concurrent quiet passes preserve exact successful and failed totals", async () => {
    const id = `pipeline-concurrency-${Date.now()}`
    const client = getRedisClient()
    const key = buildProgressionScope(id).legacyProgressionKey
    try {
      await Promise.all(Array.from({ length: 300 }, (_, index) =>
        ProgressionStateManager.recordPipelineCycle(id, [{ error: index % 10 === 0 ? "failed" : undefined }]),
      ))
      const counters = await client.hgetall(key)
      expect(Number(counters.cycles_completed)).toBe(300)
      expect(Number(counters.successful_cycles)).toBe(270)
      expect(Number(counters.failed_cycles)).toBe(30)
    } finally {
      await client.del(key)
    }
  })
})

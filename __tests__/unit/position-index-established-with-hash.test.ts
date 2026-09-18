import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
const save = src.slice(src.indexOf("const openIndexKey = `live:positions:${position.connectionId}`", src.indexOf("async function savePosition")))

describe("a live row is never written without its index entry", () => {
  test("the open index is upserted immediately after the hash write", () => {
    const hashWrite = save.indexOf("await client.hset(posKey, {")
    const earlyIndex = save.indexOf("await upsertRedisListHead(client, openIndexKey, position.id).catch(() => undefined)")
    const jsonWrite = save.indexOf("await client.set(\n      jsonKey,")
    expect(hashWrite).toBeGreaterThanOrEqual(0)
    expect(earlyIndex).toBeGreaterThan(hashWrite)
    // Before the next durable write, so nothing in between can strand the row.
    expect(earlyIndex).toBeLessThan(jsonWrite)
  })

  test("only non-terminal rows are indexed — a closed row must not reappear as open", () => {
    const block = save.slice(save.indexOf("await client.hset(posKey, {"))
    expect(block).toContain("if (!incomingTerminal) {")
    const guardIndex = block.indexOf("if (!incomingTerminal) {")
    const upsertIndex = block.indexOf("await upsertRedisListHead(client, openIndexKey, position.id)")
    expect(guardIndex).toBeLessThan(upsertIndex)
  })

  test("the established index never breaks the save path", () => {
    expect(save).toContain("upsertRedisListHead(client, openIndexKey, position.id).catch(() => undefined)")
  })

  test("the original later upsert is kept — it is idempotent, not replaced", () => {
    const occurrences = save.match(/upsertRedisListHead\(client, openIndexKey, position\.id\)/g) || []
    expect(occurrences.length).toBe(2)
  })
})

/**
 * The per-connection outcome-set ceiling lives in a Lua script, so it is
 * verified against a REAL Redis rather than a mock: an eviction bug here is
 * what turned one connection into 1M+ keys and 5 GB of memory.
 *
 * SAFETY: this suite also runs on the production host during deploy, where the
 * reachable Redis is the live one. It therefore NEVER flushes, only ever
 * touches keys under its own unique run prefix, and deletes exactly those keys
 * again. No pattern scans, no flushall, no shared key names.
 */
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const CANDIDATE_PORTS = [process.env.REDIS_TEST_PORT, "6399", "6379"].filter(Boolean) as string[]
const SCRIPT_PATH = `/tmp/outcome-ceiling-${process.pid}.lua`
const RUN = `cts-test:${randomUUID().slice(0, 8)}`

let port = ""
function cli(...args: string[]): string {
  return execFileSync("redis-cli", ["-p", port, ...args], { encoding: "utf8" }).trim()
}

/** Every key this suite creates, so teardown removes exactly what it made. */
const created = new Set<string>()
function setKeyFor(scope: string, name: string): string {
  const key = `${RUN}:indication_set:${scope}:${name}`
  created.add(`${key}:outcomes`)
  created.add(`${key}:outcome_stats`)
  return key
}
function indexKey(scope: string): string {
  const key = `${RUN}:idx:${scope}`
  created.add(key)
  return key
}
function lruKey(scope: string): string {
  const key = `${RUN}:lru:${scope}`
  created.add(key)
  return key
}

function record(setKey: string, scope: string, maxSets: number, nowMs: number, profit = 1): void {
  cli("--eval", SCRIPT_PATH,
    `${setKey}:outcomes`, `${setKey}:outcome_stats`, indexKey(scope), lruKey(scope),
    ",", JSON.stringify({ profit, loss: 0 }), String(profit), "0", "1000", "basisA",
    String(maxSets), String(nowMs))
}

const source = readFileSync(resolve(process.cwd(), "lib/indication-sets-processor.ts"), "utf8")
const match = source.match(/const RECORD_OUTCOME_SAMPLE_SCRIPT = `([\s\S]*?)`\n/)

describe("per-connection outcome-set ceiling (real Redis, real Lua)", () => {
  beforeAll(() => {
    expect(match).toBeTruthy()
    writeFileSync(SCRIPT_PATH, match![1])
    for (const candidate of CANDIDATE_PORTS) {
      try {
        if (execFileSync("redis-cli", ["-p", candidate, "ping"], { encoding: "utf8" }).trim() === "PONG") {
          port = candidate
          break
        }
      } catch { /* try the next candidate */ }
    }
    expect(port).not.toBe("")
  })

  afterAll(() => {
    // Delete only what this run created, by exact key. Never a pattern scan.
    if (!port) return
    const keys = [...created]
    for (let i = 0; i < keys.length; i += 100) {
      try { cli("del", ...keys.slice(i, i + 100)) } catch { /* best effort */ }
    }
  })

  test("the oldest sets are evicted with their samples once the ceiling is exceeded", () => {
    const scope = "a"
    for (let i = 1; i <= 5; i++) record(setKeyFor(scope, `SYM${i}`), scope, 3, 1_789_000_000_000 + i)
    expect(Number(cli("zcard", lruKey(scope)))).toBe(3)
    for (const survivor of ["SYM3", "SYM4", "SYM5"]) {
      expect(cli("exists", `${setKeyFor(scope, survivor)}:outcome_stats`)).toBe("1")
    }
    for (const evicted of ["SYM1", "SYM2"]) {
      expect(cli("exists", `${setKeyFor(scope, evicted)}:outcome_stats`)).toBe("0")
      // The sample list must go with its stats — orphaned lists were the leak.
      expect(cli("exists", `${setKeyFor(scope, evicted)}:outcomes`)).toBe("0")
    }
  })

  test("rewriting an existing set does not grow the ceiling and keeps aggregating", () => {
    const scope = "b"
    for (let i = 1; i <= 3; i++) record(setKeyFor(scope, `S${i}`), scope, 3, 1_789_000_000_000 + i)
    record(setKeyFor(scope, "S3"), scope, 3, 1_789_000_000_099, 2)
    expect(Number(cli("zcard", lruKey(scope)))).toBe(3)
    expect(cli("hget", `${setKeyFor(scope, "S3")}:outcome_stats`, "count")).toBe("2")
    expect(cli("exists", `${setKeyFor(scope, "S1")}:outcome_stats`)).toBe("1")
  })

  test("a ceiling of 0 disables eviction entirely", () => {
    const scope = "c"
    for (let i = 1; i <= 5; i++) record(setKeyFor(scope, `S${i}`), scope, 0, 1_789_000_000_000 + i)
    expect(Number(cli("zcard", lruKey(scope)))).toBe(0)
    for (let i = 1; i <= 5; i++) {
      expect(cli("exists", `${setKeyFor(scope, `S${i}`)}:outcome_stats`)).toBe("1")
    }
  })

  test("eviction removes the set from the discovery index too", () => {
    const scope = "d"
    for (let i = 1; i <= 4; i++) record(setKeyFor(scope, `S${i}`), scope, 2, 1_789_000_000_000 + i)
    const members = cli("smembers", indexKey(scope)).split("\n").filter(Boolean)
    expect(members.some((m) => m.includes(":S1:") || m.endsWith(":S1:outcome_stats"))).toBe(false)
    expect(members.some((m) => m.includes(":S4"))).toBe(true)
  })
})

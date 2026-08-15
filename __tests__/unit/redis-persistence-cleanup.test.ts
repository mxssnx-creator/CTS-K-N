import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const script = join(process.cwd(), "scripts/redis-persistence-cleanup.mjs")

function run(directory: string, ...args: string[]) {
  return JSON.parse(execFileSync(
    process.execPath,
    [script, "--dir", directory, ...args],
    { encoding: "utf8" },
  ))
}

describe("npm Redis manifest-aware persistence cleanup", () => {
  let root = ""

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cts-redis-cleanup-test-"))
    mkdirSync(join(root, "appendonlydir"))
  })

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  test("preserves the current recovery chain and removes only obsolete artifacts", () => {
    const appendOnly = join(root, "appendonlydir")
    writeFileSync(join(appendOnly, "appendonly.aof.manifest"), [
      "file appendonly.aof.106.base.rdb seq 106 type b",
      "file appendonly.aof.106.incr.aof seq 106 type i startoffset 12",
      "",
    ].join("\n"))
    for (const file of [
      "appendonly.aof.106.base.rdb",
      "appendonly.aof.106.incr.aof",
      "appendonly.aof.105.base.rdb",
      "appendonly.aof.105.incr.aof",
      ".appendonly.aof.106.incr.aof.temp",
      "operator-note.txt",
    ]) writeFileSync(join(appendOnly, file), file)
    for (const file of ["dump.rdb", "temp-123.rdb", "temp-rewriteaof-456.aof", ".dump.rdb.orphan", "keep.bin"]) {
      writeFileSync(join(root, file), file)
    }

    const preview = run(root, "--dry-run")
    expect(preview.activeAofSegments).toEqual([
      "appendonly.aof.106.base.rdb",
      "appendonly.aof.106.incr.aof",
    ])
    expect(preview.removedFiles).toBe(6)
    expect(existsSync(join(appendOnly, "appendonly.aof.105.base.rdb"))).toBe(true)

    const applied = run(root, "--stopped")
    expect(applied.removedFiles).toBe(6)
    for (const file of [
      "appendonly.aof.manifest",
      "appendonly.aof.106.base.rdb",
      "appendonly.aof.106.incr.aof",
      "operator-note.txt",
    ]) expect(readFileSync(join(appendOnly, file), "utf8")).toBeTruthy()
    for (const file of ["dump.rdb", "keep.bin"]) {
      expect(readFileSync(join(root, file), "utf8")).toBe(file)
    }
    for (const file of ["appendonly.aof.105.base.rdb", "appendonly.aof.105.incr.aof", ".appendonly.aof.106.incr.aof.temp"]) {
      expect(existsSync(join(appendOnly, file))).toBe(false)
    }
    for (const file of ["temp-123.rdb", "temp-rewriteaof-456.aof", ".dump.rdb.orphan"]) {
      expect(existsSync(join(root, file))).toBe(false)
    }
  })

  test("never deletes canonical AOF generations when no manifest exists", () => {
    const segment = join(root, "appendonlydir", "appendonly.aof.9.incr.aof")
    const temporary = join(root, "appendonlydir", ".appendonly.aof.9.incr.aof.temp")
    writeFileSync(segment, "recovery")
    writeFileSync(temporary, "partial")

    const result = run(root, "--stopped")
    expect(result.activeAofSegments).toEqual([])
    expect(result.removedFiles).toBe(1)
    expect(readFileSync(segment, "utf8")).toBe("recovery")
    expect(existsSync(temporary)).toBe(false)
  })

  test("does not remove young rewrite artifacts while the Redis service can still own them", () => {
    const young = join(root, "temp-rewriteaof-456.aof")
    const old = join(root, "temp-rewriteaof-123.aof")
    writeFileSync(young, "active rewrite")
    writeFileSync(old, "abandoned rewrite")
    const oldDate = new Date(Date.now() - 180_000)
    utimesSync(old, oldDate, oldDate)

    const result = run(root, "--minimum-age-ms", "120000", "--stopped")
    expect(result.removedFiles).toBe(1)
    expect(result.skippedYoungFiles).toBe(1)
    expect(result.removed).toEqual(["temp-rewriteaof-123.aof"])
    expect(result.skippedYoung).toEqual(["temp-rewriteaof-456.aof"])
    expect(existsSync(old)).toBe(false)
    expect(readFileSync(young, "utf8")).toBe("active rewrite")
  })
})

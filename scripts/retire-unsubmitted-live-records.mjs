import { createClient } from "redis"
import { readFileSync, existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
const { isRetirableUnsubmittedFailure, retireUnsubmittedRedisRecord } = createRequire(import.meta.url)("../lib/unsubmitted-live-retention.cjs")

// One-time legacy repair. Recurring repair calls the same predicate and CAS.
// No application initialization, migrations, exchange requests or value logs.
const apply = process.argv.includes("--apply")
const connectionId = "bingx-x02"
const client = createClient({ url: "redis://127.0.0.1:6379/0" })
client.on("error", () => {})
function assertApplyReady() {
  if (!apply) return
  const backup = process.env.CTS_RETENTION_VERIFIED_BACKUP || ""
  if (!backup.startsWith("/var/backups/cts-kn/") || !existsSync(`${backup}/VERIFIED`)) throw new Error("A verified CTS-K-N backup is required")
  if (!existsSync("/opt/cts-kn/.cts-runtime/maintenance-stop")) throw new Error("CTS-K-N maintenance marker is required")
  for (const unit of ["cts-kn", "cts-kn-direct-trade", "cts-kn-scheduler"]) {
    let state
    try { state = execFileSync("systemctl", ["is-active", unit], { encoding: "utf8" }).trim() }
    catch (error) { state = String(error.stdout || "").trim() }
    if (state !== "inactive") throw new Error("All CTS-K-N trading services must be inactive")
  }
  // Read the verified marker without exposing paths/backup contents in logs.
  if (!readFileSync(`${backup}/VERIFIED`, "utf8").trim()) throw new Error("Empty backup verification marker")
}
assertApplyReady()
await client.connect()
const report = { apply, connectionId, scanned: 0, eligible: 0, retired: 0, preservedAtWrite: 0, complete: false }
try {
  for (const [pattern, kind] of [[`live_positions:${connectionId}:*`, "hash"], [`live:position:live:${connectionId}:*`, "string"]]) {
    let cursor = "0"
    do {
      assertApplyReady()
      const page = await client.scan(cursor, { MATCH: pattern, COUNT: 500 })
      cursor = page.cursor
      // Keep both socket work and decoded records bounded. Never materialize
      // the million-key database or the whole rejected archive in memory.
      for (let offset = 0; offset < page.keys.length; offset += 16) {
        await Promise.all(page.keys.slice(offset, offset + 16).map(async key => {
          if (await client.type(key) !== kind) return
          const raw = kind === "hash" ? await client.hGetAll(key) : await client.get(key)
          report.scanned++
          let row
          try { row = kind === "hash" ? raw : JSON.parse(raw) } catch { return }
          if (String(row?.connectionId || row?.connection_id || "") !== connectionId || !isRetirableUnsubmittedFailure(row)) return
          report.eligible++
          if (!apply) return
          const retired = Number(await retireUnsubmittedRedisRecord(client, key, kind, raw))
          report.retired += retired
          report.preservedAtWrite += retired ? 0 : 1
        }))
      }
    } while (cursor !== "0")
  }
  report.complete = true
  console.log(JSON.stringify(report))
} finally { await client.quit() }

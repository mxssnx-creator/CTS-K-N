#!/usr/bin/env node
/**
 * Verify migration status on BOTH the dev and production servers by querying
 * the `/api/install/database/migrations-info` endpoint.
 *
 * WHY: production strips `console.log` from the server bundle, so a healthy
 * boot looks silent and it is impossible to tell from logs whether the
 * startup coordinator / migrations actually ran. The migrations-info endpoint
 * returns the authoritative `current_version` (what is actually applied in
 * Redis) vs `target_version` (the latest migration the code defines). If
 * `current_version === target_version` on a server, its migrations have run.
 *
 * USAGE:
 *   node scripts/verify-migration-status.mjs
 *   DEV_URL=https://dev.example.com PROD_URL=https://app.example.com \
 *     node scripts/verify-migration-status.mjs
 *
 * Exits non-zero if either server is not at the latest migration version.
 */
const DEV_URL = (process.env.DEV_URL || "http://localhost:3002").replace(/\/$/, "")
const PROD_URL = (process.env.PROD_URL || "http://localhost:3000").replace(/\/$/, "")

async function query(label, base) {
  const url = `${base}/api/install/database/migrations-info`
  try {
    const res = await fetch(url, { cache: "no-store" })
    if (!res.ok) {
      return { label, base, ok: false, status: res.status, error: `HTTP ${res.status}` }
    }
    const json = await res.json()
    return { label, base, ok: true, data: json }
  } catch (err) {
    return { label, base, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function report(r) {
  if (!r.ok) {
    console.log(`  ${r.label.padEnd(8)} ${r.base}`)
    console.log(`           ✗ unreachable: ${r.error}`)
    return false
  }
  const d = r.data
  const upToDate = d.is_up_to_date === true
  const status = upToDate ? "UP TO DATE" : "PENDING"
  console.log(`  ${r.label.padEnd(8)} ${r.base}`)
  console.log(
    `           migrations: v${d.current_version} / v${d.target_version} ` +
      `[${status}] (pending=${d.pending}, total=${d.total_migrations})`,
  )
  console.log(`           message: ${d.message}`)
  return upToDate
}

;(async () => {
  console.log("=== Migration status verification (dev vs production) ===")
  const [dev, prod] = await Promise.all([
    query("DEV", DEV_URL),
    query("PROD", PROD_URL),
  ])

  const devOk = report(dev)
  console.log("")
  const prodOk = report(prod)

  console.log("\n=== Summary ===")
  console.log(`  DEV : ${dev.ok ? (devOk ? "OK (at latest)" : "NOT at latest") : "UNREACHABLE"}`)
  console.log(`  PROD: ${prod.ok ? (prodOk ? "OK (at latest)" : "NOT at latest") : "UNREACHABLE"}`)

  const bothOk = dev.ok && prod.ok && devOk && prodOk
  if (!bothOk) {
    console.log("\n✗ One or both servers are not at the latest migration version.")
    process.exit(1)
  }
  console.log("\n✓ Both servers report migrations UP TO DATE.")
})()

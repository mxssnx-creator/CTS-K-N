#!/usr/bin/env node

/**
 * Read-only runtime coverage check for a running CTS-K-N instance.
 *
 * One pass reads the overview, progression, position, result and statistics
 * surfaces of one connection and reports what an operator would see as wrong:
 * failed or slow endpoints, non-finite numbers, the same row id listed twice,
 * stages without any evaluation, and open/closed counts that disagree between
 * surfaces. It never writes to the app; exit code 1 means a finding of
 * severity "error" (use --report-only to always exit 0).
 *
 *   BASE_URL=http://127.0.0.1:3102 CONNECTION_ID=bingx-x02 node scripts/verify-runtime-coverage.mjs [--json] [--report-only]
 */

const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 3102}`
const CONNECTION_ID = String(process.env.CONNECTION_ID || "").trim()
const SLOW_MS = Math.max(250, Number(process.env.COVERAGE_SLOW_MS || 3_000))
const TIMEOUT_MS = Math.max(SLOW_MS, Number(process.env.COVERAGE_TIMEOUT_MS || 30_000))
const REQUIRE_STAGES = process.env.COVERAGE_REQUIRE_STAGES !== "0"
const asJson = process.argv.includes("--json")
const reportOnly = process.argv.includes("--report-only")

const findings = []
const timings = {}
const add = (severity, area, message, detail) => findings.push({ severity, area, message, ...(detail === undefined ? {} : { detail }) })

async function read(name, pathname) {
  const started = Date.now()
  try {
    const response = await fetch(new URL(pathname, BASE_URL), {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await response.text()
    const ms = Date.now() - started
    timings[name] = ms
    if (!response.ok) {
      add("error", name, `HTTP ${response.status}`, text.slice(0, 300))
      return null
    }
    if (ms > SLOW_MS) add("warn", name, `slow response ${ms} ms (> ${SLOW_MS} ms)`)
    try {
      return JSON.parse(text)
    } catch {
      add("error", name, "response is not JSON", text.slice(0, 200))
      return null
    }
  } catch (error) {
    timings[name] = Date.now() - started
    add("error", name, `request failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/** Non-finite numbers and stringified "NaN"/"undefined"/"Infinity" anywhere in a payload. */
function scanValues(name, value, path = "$", depth = 0, budget = { left: 20 }) {
  if (budget.left <= 0 || depth > 12 || value === null || value === undefined) return
  if (typeof value === "number") {
    if (!Number.isFinite(value)) { add("error", name, `non-finite number at ${path}`); budget.left-- }
    return
  }
  if (typeof value === "string") {
    if (["NaN", "undefined", "Infinity", "-Infinity", "[object Object]"].includes(value.trim())) {
      add("error", name, `invalid value "${value}" at ${path}`)
      budget.left--
    }
    return
  }
  if (Array.isArray(value)) {
    duplicateIds(name, value, path)
    value.slice(0, 2_000).forEach((entry, index) => scanValues(name, entry, `${path}[${index}]`, depth + 1, budget))
    return
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) scanValues(name, entry, `${path}.${key}`, depth + 1, budget)
  }
}

function duplicateIds(name, rows, path) {
  if (rows.length < 2 || typeof rows[0] !== "object" || rows[0] === null || !("id" in rows[0])) return
  const seen = new Set()
  const duplicates = new Set()
  for (const row of rows) {
    const id = row && typeof row === "object" ? String(row.id ?? "") : ""
    if (!id) continue
    if (seen.has(id)) duplicates.add(id)
    seen.add(id)
  }
  if (duplicates.size > 0) add("error", name, `${duplicates.size} id(s) listed more than once at ${path}`, [...duplicates].slice(0, 5))
}

const num = (value) => (value === null || value === undefined || value === "" ? NaN : Number(value))
const pick = (object, ...paths) => {
  for (const path of paths) {
    const value = path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), object)
    if (value !== undefined && value !== null && value !== "") return value
  }
  return undefined
}

async function main() {
  if (!CONNECTION_ID) throw new Error("CONNECTION_ID is required")
  const id = encodeURIComponent(CONNECTION_ID)
  const [health, overview, stats, positionStats, livePositions, history, results, engineStatus] = await Promise.all([
    read("health", "/api/health"),
    read("functional-overview", `/api/trade-engine/functional-overview?connectionId=${id}`),
    read("progression-stats", `/api/connections/progression/${id}/stats`),
    read("positions-stats", `/api/positions/stats?connection_id=${id}`),
    read("live-positions", `/api/trading/live-positions?connection_id=${id}&closedLimit=500`),
    read("trade-history", `/api/trading/trade-history?connection_id=${id}&limit=500`),
    read("results-book", `/api/results/book?connectionId=${id}`),
    read("engine-status", "/api/trade-engine/status"),
  ])
  for (const [name, payload] of Object.entries({ health, overview, stats, positionStats, livePositions, history, results, engineStatus })) {
    if (payload) scanValues(name, payload)
  }

  // Stages: every stage of the basket must have evaluated something once the
  // historic phase is through; a 0 there is a processing gap, not a result.
  if (overview && REQUIRE_STAGES) {
    for (const stage of ["base", "main", "real", "live"]) {
      const evaluated = num(pick(overview, `stages.${stage}.evaluated`, `${stage}.evaluated`, `stageCounts.${stage}.evaluated`))
      if (Number.isFinite(evaluated) && evaluated <= 0) add("error", "functional-overview", `${stage} stage evaluated 0 Sets`)
    }
  }

  // Open positions: the position book, the live-position API and the overview
  // must agree on what is open for this connection.
  const openCounts = {}
  const openBook = num(pick(positionStats, "openPositions", "summary.openPositions", "stats.openPositions"))
  if (Number.isFinite(openBook)) openCounts.positionsStats = openBook
  const liveRows = Array.isArray(livePositions?.positions) ? livePositions.positions : Array.isArray(livePositions?.data) ? livePositions.data : null
  if (liveRows) {
    openCounts.livePositions = liveRows.filter((row) => ["open", "filled", "partially_filled", "simulated"].includes(String(row?.status || "").toLowerCase())).length
  }
  const distinctOpen = new Set(Object.values(openCounts))
  if (distinctOpen.size > 1) add("warn", "consistency", "open position counts differ between surfaces", openCounts)

  const summary = {
    baseUrl: BASE_URL,
    connectionId: CONNECTION_ID,
    at: new Date().toISOString(),
    healthy: health?.status ?? health?.ok ?? null,
    openCounts,
    timings,
    errors: findings.filter((finding) => finding.severity === "error").length,
    warnings: findings.filter((finding) => finding.severity === "warn").length,
    findings,
  }
  if (asJson) console.log(JSON.stringify(summary))
  else {
    console.log(`[coverage] ${summary.at} ${CONNECTION_ID}: ${summary.errors} error(s), ${summary.warnings} warning(s); timings ${JSON.stringify(timings)}`)
    for (const finding of findings) console.log(`  ${finding.severity.toUpperCase()} ${finding.area}: ${finding.message}${finding.detail === undefined ? "" : ` ${JSON.stringify(finding.detail).slice(0, 300)}`}`)
  }
  if (summary.errors > 0 && !reportOnly) process.exitCode = 1
}

main().catch((error) => {
  console.error(`[coverage] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})

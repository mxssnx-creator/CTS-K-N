#!/usr/bin/env node
/**
 * CTS-K-N live health monitor.
 *
 * One run collects a snapshot of the running system (service, engines,
 * connection switches, entry pipeline, protection holds, funnel, live results,
 * scheduler ticks, memory), evaluates it against the previous run and stores
 * the verdict in Redis. It is READ-ONLY towards the trading system: the only
 * writes are the monitor:live-health:* keys.
 *
 * Self-contained on purpose (node builtins + redis-cli): it must keep running
 * while the application is being rebuilt, and a deploy replaces /opt/cts-kn.
 * Installed by scripts/install-monitor.sh as a systemd timer (every 15 min).
 *
 *   node monitor-live-health.mjs             one run (what the timer does)
 *   node monitor-live-health.mjs --report 8  the last 8 runs as a table
 *   node monitor-live-health.mjs --latest    the last verdict with every check
 *
 * Every check carries a level (OK / INFO / WARN / CRIT). The overall level is
 * the highest one. Lines are prefixed with the journald priority marker
 * (<4> warning, <3> error) so `journalctl -u cts-kn-monitor -p warning` shows
 * only what needs attention.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import os from "node:os"
import { pathToFileURL } from "node:url"

export const LEVELS = ["OK", "INFO", "WARN", "CRIT"]
const rank = (level) => LEVELS.indexOf(level)
const worst = (a, b) => (rank(b) > rank(a) ? b : a)

export const DEFAULT_THRESHOLDS = Object.freeze({
  // No own trade closed for this long while the connection is live.
  noCloseWarnMin: 360,
  noCloseCritMin: 720,
  // Profit factor of own settled results.
  pfWarn: 1.0,
  pfCrit: 0.7,
  pfMinSamples6h: 15,
  pfMinSamples24h: 30,
  // Protection holds and halts.
  holdLongTtlSec: 3600,
  slotHaltsWarn: 5,
  slotHaltsCrit: 15,
  cooldownBlocksWarn: 50,
  // Results ledger not advanced for this long (the close-accounting background run moves it every minute).
  ledgerStaleMin: 10,
  // An aggregate protection hand-off (accumulation / reduction) normally settles within a minute or two.
  aggregateStuckMin: 10,
  ledgerLagInfo: 1000,
  // Eligible candidates but nothing opened for this long; dispatches blocked before the venue.
  noOpeningWarnMin: 60,
  blockedWarn: 100,
  // Funnel: consecutive runs with Main evaluating nothing.
  funnelStarvedRuns: 3,
  // Scheduler ticks: operator target, every tick under one second (the cron routes
  // answer within a time budget and run their work in the background). The
  // installer's freshness limit is 90 s; a tick that long is critical.
  tickSlowMs: 1_000,
  tickSlowWarnCount: 1,
  tickMaxWarnMs: 1_000,
  tickCritMs: 30_000,
  // Resources.
  rssWarnMb: 2500,
  rssCritMb: 3500,
  rssGrowthWarnMb: 400,
  rssGrowthWithinMin: 90,
  redisWarnMb: 2048,
  diskWarnPct: 85,
})

const EXPECTED_HEALTHY = new Set(["running"])

function check(id, level, message, value) {
  return value === undefined ? { id, level, message } : { id, level, message, value }
}

/**
 * Pure evaluation. `snap` is the collected snapshot, `prev` the previous run's
 * { snapshot, state } (or null). Returns { level, checks, state }.
 */
export function evaluateHealth(snap, prev = null, t = DEFAULT_THRESHOLDS) {
  const checks = []
  const add = (id, level, message, value) => checks.push(check(id, level, message, value))
  const before = prev && prev.snapshot ? prev.snapshot : null
  const state = { funnelZeroRuns: { ...(prev?.state?.funnelZeroRuns || {}) } }

  // ── service and engines ────────────────────────────────────────────
  if (!snap.service?.active) add("service", "CRIT", "cts-kn service is not active")
  else add("service", "OK", "cts-kn service active")

  const live = snap.expectedLive || []
  if (!snap.engines) add("engines", "CRIT", "engine health endpoint did not answer")
  else {
    if (snap.engines.overall && snap.engines.overall !== "healthy") add("engines_overall", "WARN", `engine health is ${snap.engines.overall}`)
    for (const conn of live) {
      const status = snap.engines.byConn?.[conn]
      if (!EXPECTED_HEALTHY.has(status)) add(`engine_${conn}`, "CRIT", `${conn} is live but its engine is ${status || "missing"}`)
    }
    if (!checks.some((c) => c.id.startsWith("engine") && c.level !== "OK")) add("engines", "OK", `engines running: ${live.join(", ") || "none live"}`)
  }

  // ── connection switches and volume factors ────────────────────────
  for (const [conn, now] of Object.entries(snap.connections || {})) {
    const was = before?.connections?.[conn]
    if (was) {
      for (const flag of ["live", "assigned", "active", "dashboard"]) {
        if (was[flag] !== undefined && now[flag] !== undefined && was[flag] !== now[flag]) {
          add(`flag_${conn}_${flag}`, "WARN", `${conn} ${flag} switch changed ${was[flag] || "-"} -> ${now[flag] || "-"}`)
        }
      }
      const a = Number(was.liveVolumeFactor), b = Number(now.liveVolumeFactor)
      if (Number.isFinite(a) && Number.isFinite(b) && a !== b) {
        add(`volume_${conn}`, b <= 0.1 && a > 0.1 ? "CRIT" : "WARN", `${conn} live_volume_factor changed ${was.liveVolumeFactor} -> ${now.liveVolumeFactor}`)
      }
    }
    if (now.liveVolumeFactor && now.volumeFactorLive && Number(now.liveVolumeFactor) !== Number(now.volumeFactorLive)) {
      add(`volume_mirror_${conn}`, live.includes(conn) ? "WARN" : "INFO", `${conn} live_volume_factor ${now.liveVolumeFactor} differs from volume_factor_live ${now.volumeFactorLive}`)
    }
    if (live.includes(conn) && now.positionMode && !/hedge|dual/i.test(now.positionMode)) {
      add(`position_mode_${conn}`, "WARN", `${conn} position_mode is ${now.positionMode}, hedge expected`)
    }
  }
  for (const [conn, audit] of Object.entries(snap.audit || {})) {
    if (audit.blockedVolumeResets > 0) add(`audit_volume_${conn}`, "WARN", `${conn}: ${audit.blockedVolumeResets} implicit volume reset(s) were blocked`)
  }

  // ── holds and halts ────────────────────────────────────────────────
  for (const [conn, h] of Object.entries(snap.holds || {})) {
    // A hold only matters where entries are placed; on a connection that is not live it is noted.
    if (h.longHolds > 0) add(`holds_${conn}`, live.includes(conn) ? "WARN" : "INFO", `${conn}: ${h.longHolds} entry hold(s) with more than ${Math.round(t.holdLongTtlSec / 60)} min left`, h.longHolds)
  }
  for (const [conn, n] of Object.entries(snap.slotHalts || {})) {
    if (n >= t.slotHaltsCrit) add(`slot_halts_${conn}`, "CRIT", `${conn}: ${n} slot halts`, n)
    else if (n >= t.slotHaltsWarn) add(`slot_halts_${conn}`, "WARN", `${conn}: ${n} slot halts`, n)
  }
  for (const [conn, ttl] of Object.entries(snap.connHaltTtl || {})) {
    if (ttl > 0) add(`conn_halt_${conn}`, "CRIT", `${conn}: connection-wide entry halt active (${ttl}s left)`, ttl)
  }

  // ── entry pipeline ─────────────────────────────────────────────────
  const e = snap.entries
  if (e) {
    if ((e.errors?.["109400"] || 0) > 0) add("entries_positionside", "CRIT", `${e.errors["109400"]} entry order(s) rejected with 109400 (positionSide)`, e.errors["109400"])
    else if (e.attempts > 0 && e.success === 0) add("entries_failed", "WARN", `${e.attempts} entry attempt(s), none succeeded`, e.attempts)
    if ((e.blocked?.post_rollback_cooldown || 0) >= t.cooldownBlocksWarn) add("entries_blocked", "WARN", `${e.blocked.post_rollback_cooldown} entries blocked by rollback cooldown in the window`, e.blocked.post_rollback_cooldown)
    if (!checks.some((c) => c.id.startsWith("entries_") && c.level !== "OK")) add("entries", "OK", `entry orders in window: ${e.attempts} attempts, ${e.success} ok, ${e.failed} failed`)
  } else add("entries", "WARN", "entry log could not be read")

  // ── funnel ──────────────────────────────────────────────────────────
  for (const conn of live) {
    const f = snap.funnel?.[conn]
    if (!f) continue
    const starved = f.baseCount > 0 && (f.mainEvaluated || 0) === 0
    state.funnelZeroRuns[conn] = starved ? (state.funnelZeroRuns[conn] || 0) + 1 : 0
    if (state.funnelZeroRuns[conn] >= t.funnelStarvedRuns) {
      add(`funnel_${conn}`, "WARN", `${conn}: Main evaluated nothing for ${state.funnelZeroRuns[conn]} runs while Base has sets`, state.funnelZeroRuns[conn])
    }
  }

  // ── dispatch gate: qualifying sets that may not be dispatched ───────
  // X01 sat without an entry order for hours while the funnel produced
  // thousands of live-ready sets: the Historic Test admitted nothing, and the
  // dispatch detail labelled that "execution_family_disabled". This check reads
  // the numbers, not the label.
  for (const conn of live) {
    const g = snap.gate?.[conn]
    if (!g) continue
    const wasOn = before?.gate?.[conn]?.historic?.enabled
    if (wasOn !== undefined && g.historic && wasOn !== g.historic.enabled) {
      add(`historic_toggle_${conn}`, "WARN", `${conn}: Historic Test switched ${wasOn ? "on" : "off"} -> ${g.historic.enabled ? "on" : "off"}`)
    }
    if (g.freshSymbols > 0 && g.candidates > 0 && g.eligible === 0) {
      const top = Object.entries(g.suppressedReasons || {}).sort((a, b) => b[1] - a[1])[0]
      let message = `${conn}: ${g.candidates} live candidate(s) in ${g.freshSymbols} symbol(s), none eligible for dispatch`
      const h = g.historic
      if (h?.enabled) {
        const families = Object.entries(h.families || {}).map(([f, n]) => `${f}:${n}`).join(" ") || "none"
        message += ` — Historic Test is ON with ${h.validated} validated combination(s) (${families}); it validated indications [${(h.indications || []).join(", ")}]`
      } else if (top) message += ` (${top[0]})`
      add(`dispatch_gate_${conn}`, "CRIT", message, g.candidates)
    } else if (g.freshSymbols > 0 && g.candidates > 0) {
      add(`dispatch_gate_${conn}`, "OK", `${conn}: ${g.eligible} of ${g.candidates} live candidates eligible, ${g.selected} selected`)
    }
  }

  // ── aggregate protection hand-offs that do not settle ───────────────
  for (const [conn, rows] of Object.entries(snap.aggregateStuck || {})) {
    const old = (rows || []).filter((r) => r.ageMin >= t.aggregateStuckMin)
    if (old.length > 0) add(`aggregate_stuck_${conn}`, "CRIT", `${conn}: ${old.length} aggregate protection hand-off(s) unsettled for up to ${Math.max(...old.map((r) => r.ageMin))} min (${old.slice(0, 3).map((r) => r.symbol).join(", ")}): the slot is unprotected and entries are halted`, old.length)
  }

  // ── account without balance ─────────────────────────────────────────
  // X01, 2026-09-30: the BingX balance was 0.0005 USDT after a mass liquidation of another
  // system's positions on the shared account (31 positions, -63 USDT, 09:51-09:58 UTC on
  // 09-29). The exposure ceiling is derived from the balance, so every volume calculated to ~0
  // and every entry was refused before the venue. The dispatch counters said "eligible",
  // the log said "0 orders"; nothing said the account was empty.
  for (const conn of live) {
    const g = snap.gate?.[conn]
    if (g && g.zeroCeiling > 0) add(`balance_exhausted_${conn}`, "CRIT", `${conn}: live exposure ceiling is 0.00 USD (${g.zeroCeiling} dispatches refused) — the account has no usable balance and every entry is refused before the venue; it has to be funded`, g.zeroCeiling)
  }

  // ── results: the shown figures against the data they are meant to be computed from ─────
  // Two days of different "positions" for one connection (16 / 98 / 111 / 305 / 1135 across routes, X02: 2
  // against 1,287 filled rows) went unnoticed because nothing compared the answer with the rows.
  for (const [conn, c] of Object.entries(snap.resultsCheck || {})) {
    if (c.api === null) { add(`results_api_${conn}`, "WARN", `${conn}: /api/results/book did not answer`); continue }
    const diffs = []
    for (const k of ["closed", "settled", "wins", "losses"]) if (c.api[k] !== c.ledger[k]) diffs.push(`${k} ${c.api[k]} vs ${c.ledger[k]}`)
    if (Math.abs((c.api.net ?? 0) - (c.ledger.net ?? 0)) > 1e-6) diffs.push(`net ${c.api.net} vs ${c.ledger.net}`)
    if (diffs.length > 0) add(`results_inconsistent_${conn}`, "CRIT", `${conn}: the results answer differs from the ledger (${diffs.join(", ")})`)
    if (c.ledgerAgeMin !== null && c.ledgerAgeMin > t.ledgerStaleMin && c.keys > 0) add(`ledger_stale_${conn}`, "WARN", `${conn}: results ledger not advanced for ${c.ledgerAgeMin} min`, c.ledgerAgeMin)
    if (c.complete === false && c.ledgerAgeMin !== null && c.ledgerAgeMin <= t.ledgerStaleMin && c.remaining > 0) add(`ledger_building_${conn}`, "INFO", `${conn}: results ledger still building (${c.remaining} rows left)`)
    // Built, but behind: new rows wait for the next passes (the app is CPU-bound). Informational, never a fallback.
    else if (c.complete === true && c.remaining > t.ledgerLagInfo) add(`ledger_lag_${conn}`, "INFO", `${conn}: results ledger ${c.remaining} rows behind`, c.remaining)
  }

  // ── openings: rows with executed quantity, counted in Redis ─────────
  // The journal is not a reliable source for this: journald rate-limits the app
  // (849 lines dropped in one hour on 2026-09-29) and "[LiveOrder] [POST]: 0"
  // was reported while positions were being opened. Rows are the ground truth.
  for (const conn of live) {
    const o = snap.openings?.[conn]
    const g = snap.gate?.[conn]
    if (!o) continue
    const top = Object.entries(g?.blockedReasons || {}).sort((a, b) => b[1] - a[1])[0]
    const blockedTotal = Object.values(g?.blockedReasons || {}).reduce((a, b) => a + b, 0)
    if (g && g.freshSymbols > 0 && g.eligible > 0 && (o.lastAgoMin === null || o.lastAgoMin >= t.noOpeningWarnMin)) {
      add(`no_entries_${conn}`, "WARN", `${conn}: ${g.eligible} eligible live candidate(s) but no position opened for ${o.lastAgoMin === null ? "as long as recorded" : `${o.lastAgoMin} min`}${top ? ` — most frequent block: ${top[0]} (${top[1]}x)` : ""}`, o.lastAgoMin)
    } else {
      add(`openings_${conn}`, "OK", `${conn}: ${o.last60} position(s) opened in the last hour, last ${o.lastAgoMin === null ? "never" : `${o.lastAgoMin} min ago`}`)
    }
    if (blockedTotal >= t.blockedWarn && top) {
      add(`dispatch_blocked_${conn}`, "INFO", `${conn}: ${blockedTotal} dispatches blocked before the venue, most frequent: ${top[0]} (${top[1]}x)`, blockedTotal)
    }
  }

  // ── live results ────────────────────────────────────────────────────
  for (const [conn, r] of Object.entries(snap.results || {})) {
    if (!live.includes(conn)) continue
    const idle = r.lastClosedAgoMin
    if (idle === null || idle === undefined) add(`no_trades_${conn}`, "WARN", `${conn}: no closed own trade on record`)
    else if (idle >= t.noCloseCritMin) add(`no_trades_${conn}`, "CRIT", `${conn}: no trade closed for ${Math.round(idle / 60)} h`, idle)
    else if (idle >= t.noCloseWarnMin) add(`no_trades_${conn}`, "WARN", `${conn}: no trade closed for ${Math.round(idle / 60)} h`, idle)
    const w6 = r.window6h, w24 = r.window24h
    if (w6 && w6.settled >= t.pfMinSamples6h && w6.pf !== null && w6.pf < t.pfWarn) add(`pf6h_${conn}`, "WARN", `${conn}: PF ${w6.pf.toFixed(2)} over ${w6.settled} settled trades (6 h)`, w6.pf)
    if (w24 && w24.settled >= t.pfMinSamples24h && w24.pf !== null && w24.pf < t.pfCrit) add(`pf24h_${conn}`, "CRIT", `${conn}: PF ${w24.pf.toFixed(2)} over ${w24.settled} settled trades (24 h)`, w24.pf)
    else if (w24 && w24.settled >= t.pfMinSamples24h && w24.pf !== null && w24.pf < t.pfWarn) add(`pf24h_${conn}`, "WARN", `${conn}: PF ${w24.pf.toFixed(2)} over ${w24.settled} settled trades (24 h)`, w24.pf)
    if (w6 && w6.closed >= 10 && (w6.reasons?.exchange_reconciliation || 0) / w6.closed >= 0.6) add(`attribution_${conn}`, "INFO", `${conn}: ${Math.round(((w6.reasons.exchange_reconciliation || 0) / w6.closed) * 100)}% of closes are attributed exchange_reconciliation`)
  }

  // ── scheduler ticks ─────────────────────────────────────────────────
  if (snap.ticks && snap.ticks.count > 0) {
    const over = snap.ticks.over1s ?? snap.ticks.over30s ?? 0
    if (snap.ticks.maxMs >= t.tickCritMs) add("ticks_slow", "CRIT", `slowest scheduler tick ${Math.round(snap.ticks.maxMs / 1000)}s (target under ${t.tickSlowMs / 1000}s)`, snap.ticks.maxMs)
    else if (over >= t.tickSlowWarnCount) add("ticks_slow", "WARN", `${over} of ${snap.ticks.count} scheduler ticks took more than ${t.tickSlowMs / 1000}s (slowest ${(snap.ticks.maxMs / 1000).toFixed(1)}s)`, over)
    else add("ticks", "OK", `all ${snap.ticks.count} scheduler ticks under ${t.tickSlowMs / 1000}s (max ${snap.ticks.maxMs} ms)`)
  }

  // ── resources ───────────────────────────────────────────────────────
  const res = snap.resources
  if (res) {
    if (res.rssMb >= t.rssCritMb) add("rss", "CRIT", `next-server RSS ${res.rssMb} MB`, res.rssMb)
    else if (res.rssMb >= t.rssWarnMb) add("rss", "WARN", `next-server RSS ${res.rssMb} MB`, res.rssMb)
    const prevRes = before?.resources
    if (prevRes && prevRes.rssMb && res.rssMb && res.rssMb - prevRes.rssMb >= t.rssGrowthWarnMb) {
      const minutes = (Date.parse(snap.at) - Date.parse(before.at)) / 60000
      if (minutes > 0 && minutes <= t.rssGrowthWithinMin) add("rss_growth", "WARN", `RSS grew ${res.rssMb - prevRes.rssMb} MB in ${Math.round(minutes)} min`, res.rssMb - prevRes.rssMb)
    }
    if (res.redisMb >= t.redisWarnMb) add("redis_memory", "WARN", `Redis uses ${res.redisMb} MB`, res.redisMb)
    if (res.diskPct >= t.diskWarnPct) add("disk", "WARN", `disk ${res.diskPct}% full`, res.diskPct)
  }

  for (const name of snap.collectorFailures || []) add(`collector_${name}`, "WARN", `collector "${name}" failed`)

  const level = checks.reduce((acc, c) => worst(acc, c.level), "OK")
  return { level, checks, state }
}

// ─────────────────────────────── collection ───────────────────────────────
const PORT = process.env.CTS_REDIS_PORT || "6379"
const APP_URL = process.env.CTS_MONITOR_APP_URL || "http://127.0.0.1:3002"
const CONNECTIONS = (process.env.CTS_MONITOR_CONNECTIONS || "bingx-x01,bingx-x02").split(",").map((s) => s.trim()).filter(Boolean)
const WINDOW_MIN = Number(process.env.CTS_MONITOR_WINDOW_MIN || 20)
const LATEST_KEY = "monitor:live-health:latest"
const HISTORY_KEY = "monitor:live-health:history"

function redis(args, input) {
  return execFileSync("redis-cli", ["-p", PORT, "--raw", ...args], { encoding: "utf8", input, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })
}
const lines = (out) => { const l = out.split("\n"); l.pop(); return l }
/** redis-cli --raw prints an empty line for a missing key; that is "no value", not invalid JSON. */
function readJson(key) {
  const raw = redis(["get", key]).trim()
  return raw ? JSON.parse(raw) : null
}
function batch(commands) {
  if (commands.length === 0) return []
  return lines(redis([], commands.join("\n") + "\n"))
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

function collectService() {
  const out = execFileSync("systemctl", ["is-active", "cts-kn"], { encoding: "utf8" }).trim()
  return { active: out === "active" }
}

function collectEngines() {
  const body = execFileSync("curl", ["-s", "-m", "20", `${APP_URL}/api/trade-engine/health`], { encoding: "utf8", timeout: 25_000 })
  const data = JSON.parse(body)
  const byConn = {}
  for (const engine of data.engines || []) byConn[engine.connectionId] = engine.status
  return { overall: data.overall, byConn }
}

function collectConnections() {
  const fields = ["is_live_trade", "is_assigned", "is_active", "is_enabled_dashboard", "live_volume_factor", "volume_factor_live", "position_mode"]
  const out = batch(CONNECTIONS.map((c) => `HMGET connection:${c} ${fields.join(" ")}`))
  const connections = {}
  CONNECTIONS.forEach((conn, i) => {
    const v = out.slice(i * fields.length, (i + 1) * fields.length)
    connections[conn] = { live: v[0], assigned: v[1], active: v[2], dashboard: v[3], liveVolumeFactor: v[4], volumeFactorLive: v[5], positionMode: v[6] }
  })
  return connections
}

function collectHolds() {
  const holds = {}, slotHalts = {}, connHaltTtl = {}
  for (const conn of CONNECTIONS) {
    const keys = lines(redis(["--scan", "--pattern", `live:entry-rollback-cooldown:${conn}:*`]))
    const ttls = batch(keys.map((k) => `TTL ${k}`)).map(num)
    holds[conn] = { count: keys.length, longHolds: ttls.filter((t) => t > DEFAULT_THRESHOLDS.holdLongTtlSec).length }
    slotHalts[conn] = lines(redis(["--scan", "--pattern", `live:entry-protection-halt:${conn}:slot:*`])).length
    connHaltTtl[conn] = num(redis(["ttl", `live:entry-protection-halt:${conn}`]).trim())
  }
  return { holds, slotHalts, connHaltTtl }
}

function collectFunnel() {
  const funnel = {}
  for (const conn of CONNECTIONS) {
    const [baseCount, mainEvaluated, liveEvaluated] = batch([`GET strategies:${conn}:base:count`, `GET strategies:${conn}:main:evaluated`, `GET strategies:${conn}:live:evaluated`])
    funnel[conn] = { baseCount: num(baseCount), mainEvaluated: num(mainEvaluated), liveEvaluated: num(liveEvaluated) }
  }
  return funnel
}

function statsOf(rows) {
  let gp = 0, gl = 0, wins = 0, losses = 0
  const reasons = {}
  for (const r of rows) {
    reasons[r.reason || "?"] = (reasons[r.reason || "?"] || 0) + 1
    if (!r.settled) continue
    if (r.pnl > 0) { wins++; gp += r.pnl } else if (r.pnl < 0) { losses++; gl += -r.pnl }
  }
  const settled = rows.filter((r) => r.settled).length
  return { closed: rows.length, settled, wins, losses, net: Math.round((gp - gl) * 1e4) / 1e4, pf: gl > 0 ? gp / gl : gp > 0 ? null : null, winRate: wins + losses > 0 ? wins / (wins + losses) : null, reasons }
}

function ledgerEntries(conn) {
  const flat = lines(redis(["hgetall", `results:ledger:v3:${conn}:entries`]))
  const entries = []
  for (let i = 1; i < flat.length; i += 2) { try { entries.push(JSON.parse(flat[i])) } catch { /* damaged entry */ } }
  return entries
}

function ledgerBook(entries) {
  const closed = entries.filter((e) => e.status === "closed")
  const settled = closed.filter((e) => e.settled && e.pnl !== null)
  let net = 0, wins = 0, losses = 0
  for (const e of settled) { net += e.pnl; if (e.pnl > 0) wins++; else if (e.pnl < 0) losses++ }
  return { closed: closed.length, settled: settled.length, wins, losses, net: Math.round(net * 1e8) / 1e8 }
}

// Open rows whose aggregate protection hand-off has been "in flight" for long: the slot is unprotected and every entry of the
// connection is halted until it settles (X02, 2026-10-02: BTCUSDT long, 18 min and counting, no stop loss / take profit).
function collectAggregateStuck(now) {
  const out = {}
  for (const conn of CONNECTIONS) {
    const ids = lines(redis(["smembers", `results:ledger:v3:${conn}:open`]))
    const stuck = []
    for (const id of ids.slice(0, 200)) {
      const at = num(redis(["hget", `live_positions:${conn}:${id}`, "aggregateProtectionMutationRequestedAt"]))
      if (at > 0) stuck.push({ id: id.slice(-28), symbol: String(redis(["hget", `live_positions:${conn}:${id}`, "symbol"])).trim(), ageMin: Math.round((now - at) / 60000) })
    }
    out[conn] = stuck
  }
  return out
}

function collectResultsCheck(now) {
  const out = {}
  for (const conn of CONNECTIONS) {
    const meta = lines(redis(["hgetall", `results:ledger:v3:${conn}:meta`]))
    const metaMap = {}
    for (let i = 0; i + 1 < meta.length; i += 2) metaMap[meta[i]] = meta[i + 1]
    if (!metaMap.updatedAt) continue
    const ledger = ledgerBook(ledgerEntries(conn))
    let api = null
    try {
      const body = JSON.parse(execFileSync("curl", ["-s", "-m", "20", `${APP_URL}/api/results/book?connection_id=${conn}&window=all`], { encoding: "utf8", timeout: 25_000 }))
      if (body?.book) api = { closed: body.book.closed, settled: body.book.settled, wins: body.book.wins, losses: body.book.losses, net: Math.round(body.book.net * 1e8) / 1e8 }
    } catch { api = null }
    out[conn] = { api, ledger, ledgerAgeMin: Math.round((now - num(metaMap.updatedAt)) / 60000), keys: num(metaMap.keys), complete: metaMap.complete === "1" || num(metaMap.lastCompletePassAt) > 0, remaining: num(metaMap.remaining) }
  }
  return out
}

function collectResults(now) {
  // Prefer the results ledger (filled real rows, complete, updated when the accounting settles);
  // the row scan below is the fallback for a connection that has none yet.
  const fromLedger = {}
  for (const conn of CONNECTIONS) {
    const entries = ledgerEntries(conn)
    if (entries.length === 0) continue
    const closed = entries.filter((e) => e.status === "closed")
    const rows = closed.map((e) => ({ closedAt: e.closed, pnl: e.pnl ?? 0, reason: e.reason, createdAt: e.opened, settled: e.settled }))
    const within = (ms) => rows.filter((r) => r.closedAt >= now - ms)
    const lastClosed = rows.reduce((m, r) => Math.max(m, r.closedAt), 0)
    fromLedger[conn] = { window6h: statsOf(within(6 * 3600e3)), window24h: statsOf(within(24 * 3600e3)), lastClosedAgoMin: lastClosed > 0 ? Math.round((now - lastClosed) / 60000) : null, source: "ledger" }
  }
  const scanned = collectResultsFromRows(now, CONNECTIONS.filter((c) => !fromLedger[c]))
  return { ...scanned, ...fromLedger }
}

function collectResultsFromRows(now, connections) {
  const fields = ["status", "executedQuantity", "closedAt", "realizedPnL", "closeReason", "createdAt", "realizedPnlComplete", "system_tracking_id"]
  const results = {}
  for (const conn of connections) {
    const ids = lines(redis(["lrange", `live:positions:${conn}:closed`, "0", "299"]))
    const out = batch(ids.map((id) => `HMGET live_positions:${conn}:${id} ${fields.join(" ")}`))
    const rows = []
    ids.forEach((id, i) => {
      const v = out.slice(i * fields.length, (i + 1) * fields.length)
      if (v[0] !== "closed" || !(num(v[1]) > 0)) return
      const tracking = v[7]
      if (tracking && !tracking.startsWith(`sys-${conn}-`)) return
      rows.push({ closedAt: num(v[2]), pnl: num(v[3]), reason: v[4], createdAt: num(v[5]), settled: v[6] === "true" })
    })
    const within = (ms) => rows.filter((r) => r.closedAt >= now - ms)
    const lastClosed = rows.reduce((m, r) => Math.max(m, r.closedAt), 0)
    results[conn] = { window6h: statsOf(within(6 * 3600e3)), window24h: statsOf(within(24 * 3600e3)), lastClosedAgoMin: lastClosed > 0 ? Math.round((now - lastClosed) / 60000) : null }
  }
  return results
}

function collectDispatchGate(now, liveConnections) {
  const gate = {}
  for (const conn of liveConnections) {
    const flat = lines(redis(["hgetall", `strategy_detail:${conn}:live`]))
    const bySymbol = {}
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const m = /^s:([A-Z0-9]+):(.+)$/.exec(flat[i])
      if (m) (bySymbol[m[1]] ||= {})[m[2]] = flat[i + 1]
    }
    const g = { freshSymbols: 0, candidates: 0, eligible: 0, selected: 0, suppressed: 0, suppressedHistoric: 0, zeroCeiling: 0, suppressedReasons: {}, blockedReasons: {} }
    for (const d of Object.values(bySymbol)) {
      if (num(d.dispatch_completed_at) < now - WINDOW_MIN * 60000) continue
      g.freshSymbols++
      g.candidates += num(d.dispatch_candidates)
      g.eligible += num(d.dispatch_eligible_count)
      g.selected += num(d.dispatch_selected_count)
      g.suppressed += num(d.dispatch_suppressed_count)
      g.suppressedHistoric += num(d.dispatch_suppressed_historic_count)
      for (const [field, target] of [["dispatch_suppressed", g.suppressedReasons], ["dispatch_blocked_reasons", g.blockedReasons]]) {
        try {
          for (const row of JSON.parse(d[field] || "[]")) {
            // "Live exposure ceiling 0.00 USD": the exposure ceiling comes from the account balance,
            // so 0 means the account has nothing to trade with. The normalisation below masks the
            // amount, so it is counted here.
            if (/exposure ceiling 0(?:\.0+)? USD/i.test(String(row.reason || ""))) g.zeroCeiling += num(row.count)
            const reason = String(row.reason || "?").replace(/\b[A-Z0-9]{3,12}USDT\b/g, "SYM").replace(/[0-9]+(\.[0-9]+)? USD/g, "N USD")
            target[reason] = (target[reason] || 0) + num(row.count)
          }
        } catch { /* not JSON */ }
      }
    }
    let historic = null
    try {
      const settings = JSON.parse(redis(["hget", `connection_settings:${conn}`, "historicTestSettings"]).trim() || "null")
      const validated = JSON.parse(redis(["get", `historic_test:validated:${conn}`]).trim() || "null")
      const rows = Array.isArray(validated?.combinations) ? validated.combinations : []
      const families = {}, indications = new Set()
      for (const r of rows) { families[r.family] = (families[r.family] || 0) + 1; if (r.indication) indications.add(r.indication) }
      historic = { enabled: settings?.enabled === true, validated: rows.length, families, indications: [...indications], ranAt: validated?.ranAt ?? null }
    } catch { historic = null }
    g.historic = historic
    gate[conn] = g
  }
  return gate
}

function collectOpenings(now, liveConnections) {
  const openings = {}
  for (const conn of liveConnections) {
    const keys = lines(redis(["--scan", "--pattern", `live_positions:${conn}:*`]))
    const out = batch(keys.map((k) => `HMGET ${k} createdAt executedQuantity system_tracking_id`))
    let last60 = 0, last = 0
    keys.forEach((k, i) => {
      const [created, qty, tracking] = out.slice(i * 3, i * 3 + 3)
      if (!(num(qty) > 0)) return
      if (tracking && !tracking.startsWith(`sys-${conn}-`)) return
      const at = num(created)
      if (at > last) last = at
      if (at >= now - 60 * 60000) last60++
    })
    openings[conn] = { last60, lastAgoMin: last > 0 ? Math.round((now - last) / 60000) : null }
  }
  return openings
}

function collectAudit(now) {
  const audit = {}
  for (const conn of CONNECTIONS) {
    const entries = lines(redis(["lrange", `audit:connection-changes:${conn}`, "0", "40"]))
    let blocked = 0
    for (const raw of entries) {
      try {
        const d = JSON.parse(raw)
        if (d.blockedVolumeReset && Date.parse(d.at) >= now - WINDOW_MIN * 60000 * 1.5) blocked++
      } catch { /* not JSON */ }
    }
    audit[conn] = { blockedVolumeResets: blocked }
  }
  return audit
}

function collectEntries() {
  const log = execFileSync("journalctl", ["-u", "cts-kn", "--since", `${WINDOW_MIN} min ago`, "--no-pager", "-o", "cat", "-n", "40000"], { encoding: "utf8", timeout: 60_000, maxBuffer: 256 * 1024 * 1024 })
  const entries = { attempts: 0, success: 0, failed: 0, errors: {}, blocked: {} }
  for (const line of log.split("\n")) {
    if (line.includes("[LiveOrder] [POST]")) {
      entries.attempts++
      if (/success=true/.test(line)) entries.success++
      else if (/success=false/.test(line)) {
        entries.failed++
        const code = /err=[^|]*?code=(\d+)/.exec(line)
        if (code) entries.errors[code[1]] = (entries.errors[code[1]] || 0) + 1
      }
    }
    const blocked = /Live exchange order blocked \(([a-z_]+)\)/.exec(line)
    if (blocked) entries.blocked[blocked[1]] = (entries.blocked[blocked[1]] || 0) + 1
  }
  return entries
}

function collectTicks() {
  const log = execFileSync("journalctl", ["-u", "cts-kn-scheduler", "--since", `${WINDOW_MIN} min ago`, "--no-pager", "-o", "cat"], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })
  const durations = []
  for (const line of log.split("\n")) {
    if (!line.includes("minute_scheduler_tick")) continue
    try { const d = JSON.parse(line.trim()); if (Number.isFinite(d.durationMs)) durations.push(d.durationMs) } catch { /* partial line */ }
  }
  return { count: durations.length, over1s: durations.filter((d) => d > DEFAULT_THRESHOLDS.tickSlowMs).length, maxMs: durations.reduce((m, d) => Math.max(m, d), 0) }
}

function collectResources() {
  let rssMb = 0
  try {
    const pid = execFileSync("pgrep", ["-f", "next-server"], { encoding: "utf8" }).trim().split("\n")[0]
    const rss = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))
    rssMb = rss ? Math.round(Number(rss[1]) / 1024) : 0
  } catch { /* no process */ }
  const used = /used_memory:(\d+)/.exec(redis(["info", "memory"]))
  const df = execFileSync("df", ["-P", "/"], { encoding: "utf8" }).trim().split("\n").pop().split(/\s+/)
  return { rssMb, load1: Math.round(os.loadavg()[0] * 100) / 100, diskPct: num(String(df[4]).replace("%", "")), redisMb: used ? Math.round(Number(used[1]) / 1048576) : 0 }
}

export function collectSnapshot() {
  const now = Date.now()
  const failures = []
  const safe = (name, fn, fallback = null) => { try { return fn() } catch { failures.push(name); return fallback } }
  const connections = safe("connections", collectConnections, {})
  const holdData = safe("holds", collectHolds, { holds: {}, slotHalts: {}, connHaltTtl: {} })
  return {
    at: new Date(now).toISOString(),
    windowMin: WINDOW_MIN,
    service: safe("service", collectService, { active: false }),
    engines: safe("engines", collectEngines),
    connections,
    expectedLive: Object.entries(connections).filter(([, c]) => c.live === "1").map(([id]) => id),
    holds: holdData.holds,
    slotHalts: holdData.slotHalts,
    connHaltTtl: holdData.connHaltTtl,
    funnel: safe("funnel", collectFunnel, {}),
    openings: safe("openings", () => collectOpenings(now, Object.entries(connections).filter(([, c]) => c.live === "1").map(([id]) => id)), {}),
    gate: safe("gate", () => collectDispatchGate(now, Object.entries(connections).filter(([, c]) => c.live === "1").map(([id]) => id)), {}),
    results: safe("results", () => collectResults(now), {}),
    resultsCheck: safe("resultsCheck", () => collectResultsCheck(now), {}),
    aggregateStuck: safe("aggregateStuck", () => collectAggregateStuck(now), {}),
    audit: safe("audit", () => collectAudit(now), {}),
    entries: safe("entries", collectEntries),
    ticks: safe("ticks", collectTicks),
    resources: safe("resources", collectResources),
    collectorFailures: failures,
  }
}

function priorityPrefix(level) { return level === "CRIT" ? "<3>" : level === "WARN" ? "<4>" : "" }

function runOnce() {
  let previous = null
  try { previous = readJson(LATEST_KEY) } catch { previous = null }
  const snapshot = collectSnapshot()
  const verdict = evaluateHealth(snapshot, previous)
  const record = { at: snapshot.at, level: verdict.level, checks: verdict.checks, state: verdict.state, snapshot }
  try {
    redis(["set", LATEST_KEY, JSON.stringify(record), "EX", "21600"])
    const compact = {
      at: snapshot.at, level: verdict.level,
      rssMb: snapshot.resources?.rssMb, attempts: snapshot.entries?.attempts, ok: snapshot.entries?.success,
      lastClosedAgoMin: Object.fromEntries(Object.entries(snapshot.results || {}).map(([c, r]) => [c, r.lastClosedAgoMin])),
      pf6h: Object.fromEntries(Object.entries(snapshot.results || {}).map(([c, r]) => [c, r.window6h?.pf ?? null])),
      slotHalts: snapshot.slotHalts, live: snapshot.expectedLive,
      opened60: Object.fromEntries(Object.entries(snapshot.openings || {}).map(([c, o]) => [c, o.last60])),
      eligible: Object.fromEntries(Object.entries(snapshot.gate || {}).map(([c, g]) => [c, `${g.eligible}/${g.candidates}`])),
      // Most severe first: the report shows the first one.
      issues: verdict.checks.filter((c) => c.level !== "OK").sort((a, b) => rank(b.level) - rank(a.level)).map((c) => `${c.level} ${c.message}`).slice(0, 6),
    }
    redis(["lpush", HISTORY_KEY, JSON.stringify(compact)])
    redis(["ltrim", HISTORY_KEY, "0", "671"])
  } catch (error) {
    console.error(`<4>[monitor] could not store the verdict: ${error.message}`)
  }
  const issues = verdict.checks.filter((c) => c.level !== "OK")
  console.log(`${priorityPrefix(verdict.level)}[monitor] ${snapshot.at} ${verdict.level} — ${issues.length === 0 ? "all checks ok" : `${issues.length} finding(s)`}`)
  for (const c of [...issues].sort((a, b) => rank(b.level) - rank(a.level))) console.log(`${priorityPrefix(c.level)}[monitor]   ${c.level} ${c.id}: ${c.message}`)
  return record
}

function report(count) {
  const rows = lines(redis(["lrange", HISTORY_KEY, "0", String(Math.max(1, count) - 1)])).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  if (rows.length === 0) { console.log("no monitor history yet"); return }
  const pad = (v, n) => String(v ?? "-").padEnd(n)
  console.log(`${pad("time (UTC)", 20)}${pad("level", 6)}${pad("rss MB", 8)}${pad("orders ok/all", 14)}${pad("last close (min)", 20)}${pad("PF 6h", 22)}${pad("eligible/cand", 15)}${pad("opened 60m", 12)}most severe finding`)
  for (const r of rows) {
    const closes = Object.entries(r.lastClosedAgoMin || {}).map(([c, v]) => `${c.replace("bingx-", "")}:${v ?? "-"}`).join(" ")
    const pf = Object.entries(r.pf6h || {}).map(([c, v]) => `${c.replace("bingx-", "")}:${v === null || v === undefined ? "-" : v.toFixed(2)}`).join(" ")
    console.log(`${pad(r.at.slice(0, 19).replace("T", " "), 20)}${pad(r.level, 6)}${pad(r.rssMb, 8)}${pad(`${r.ok ?? "-"}/${r.attempts ?? "-"}`, 14)}${pad(closes, 20)}${pad(pf, 22)}${pad(Object.entries(r.eligible || {}).map(([c, v]) => `${c.replace("bingx-", "")}:${v}`).join(" ") || "-", 15)}${pad(Object.entries(r.opened60 || {}).map(([c, v]) => `${c.replace("bingx-", "")}:${v}`).join(" ") || "-", 12)}${(r.issues || [])[0] || ""}`)
  }
}

function main() {
  const args = process.argv.slice(2)
  if (args[0] === "--report") return report(Number(args[1]) || 8)
  if (args[0] === "--latest") {
    const latest = readJson(LATEST_KEY)
    if (!latest) { console.log("no verdict stored (older than 6 h or never run)"); return }
    console.log(`${latest.at} ${latest.level}`)
    for (const c of latest.checks) console.log(`  ${c.level.padEnd(4)} ${c.id}: ${c.message}`)
    return
  }
  runOnce()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()

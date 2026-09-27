#!/usr/bin/env node
/**
 * Offline engine stats audit helpers used by scripts/run-offline-50-engine-soak.mjs.
 *
 * sampleOnce: RSS of the server process tree, Redis key count, open/closed
 * paper positions and a NaN/Infinity scan of the UI statistics routes.
 * runAudit: final cross-check of the statistics APIs against the Redis
 * position ledger (live:positions:<id>[:closed]) plus duplicate/ownership
 * and per-symbol coverage checks. Read-only against the loopback test Redis.
 */
import { readFileSync, readdirSync } from "node:fs"

export function statsRoutes(connectionId) {
  const id = encodeURIComponent(connectionId)
  return [
    `/api/connections/progression/${id}/stats`,
    `/api/trading/trade-history?connection_id=${id}&limit=500`,
    `/api/trading/live-positions?connection_id=${id}&closedLimit=500`,
    `/api/trading/stats?connection_id=${id}`,
    `/api/trading/engine-stats?connection_id=${id}`,
    `/api/positions/stats?connection_id=${id}`,
    `/api/exchange/live-summary?connection_id=${id}`,
    `/api/statistics/indications?connectionId=${id}`,
    `/api/statistics/families?connectionId=${id}`,
    `/api/main/system-stats-v3`,
    `/api/main/strategies-evaluation?connectionId=${id}`,
    `/api/main/indications-stats?connectionId=${id}`,
    `/api/system/monitoring`,
    `/api/trade-engine/status-all`,
    `/api/connections/${id}/engine-states`,
  ]
}

/** Paths whose value is a NaN/Infinity-like string or a non-finite number. */
export function findNonFinite(value, path = "$", out = []) {
  if (out.length > 50) return out
  if (typeof value === "number" && !Number.isFinite(value)) out.push(path)
  else if (typeof value === "string" && /^(NaN|-?Infinity|undefined)$/.test(value.trim())) out.push(`${path}=${value}`)
  else if (typeof value === "string" && /\bNaN\b/.test(value) && value.length < 200) out.push(`${path}~${value}`)
  else if (Array.isArray(value)) value.forEach((v, i) => findNonFinite(v, `${path}[${i}]`, out))
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) findNonFinite(v, `${path}.${k}`, out)
  return out
}

async function getJson(baseUrl, path) {
  const started = Date.now()
  const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(60_000), cache: "no-store" })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* reported below */ }
  return { path, status: response.status, ms: Date.now() - started, json, text: json ? "" : text.slice(0, 300) }
}

function processTreeRssMb(rootPid) {
  const children = new Map()
  const rss = new Map()
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8")
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
      const ppid = Number(fields[1])
      rss.set(Number(entry), Number(fields[21]) * 4096)
      if (!children.has(ppid)) children.set(ppid, [])
      children.get(ppid).push(Number(entry))
    } catch { /* exited */ }
  }
  let total = 0
  const stack = [rootPid]
  while (stack.length) {
    const pid = stack.pop()
    total += rss.get(pid) || 0
    stack.push(...(children.get(pid) || []))
  }
  return Math.round(total / 1024 / 1024)
}

async function ledgerIds(redis, connectionId) {
  const open = await redis.lRange(`live:positions:${connectionId}`, 0, -1)
  const closed = await redis.lRange(`live:positions:${connectionId}:closed`, 0, -1)
  return { open, closed }
}

export async function sampleOnce({ baseUrl, redis, connectionId, serverPid }) {
  const results = await Promise.all(statsRoutes(connectionId).map((p) => getJson(baseUrl, p).catch((e) => ({ path: p, status: 0, ms: 60_000, error: String(e) }))))
  const nanPaths = []
  const failures = []
  for (const r of results) {
    if (r.status !== 200) failures.push(`${r.path}:${r.status}${r.error ? `:${r.error}` : ""}`)
    if (r.json) for (const p of findNonFinite(r.json)) nanPaths.push(`${r.path.split("?")[0]} ${p}`)
  }
  const { open, closed } = await ledgerIds(redis, connectionId)
  return {
    at: new Date().toISOString(),
    rssMb: processTreeRssMb(serverPid),
    redisKeys: await redis.dbSize(),
    redisUsedMb: Math.round(Number((/used_memory:(\d+)/.exec(await redis.info("memory")) || [])[1] || 0) / 1048576),
    openPositions: new Set(open).size,
    closedPositions: new Set(closed).size,
    slowestMs: Math.max(...results.map((r) => r.ms)),
    slowest: results.reduce((a, b) => (b.ms > a.ms ? b : a)).path.split("?")[0],
    failures,
    nanPaths: [...new Set(nanPaths)].slice(0, 40),
  }
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export async function runAudit({ baseUrl, redis, connectionId, symbols }) {
  const issues = []
  const info = {}
  const { open, closed } = await ledgerIds(redis, connectionId)
  const dupOpen = open.length - new Set(open).size
  const dupClosed = closed.length - new Set(closed).size
  const both = open.filter((id) => closed.includes(id))
  info.ledger = { open: open.length, closed: closed.length, dupOpen, dupClosed, openAndClosed: both.length }
  if (dupOpen) issues.push(`open index has ${dupOpen} duplicate ids`)
  if (dupClosed) issues.push(`closed index has ${dupClosed} duplicate ids`)
  if (both.length) issues.push(`${both.length} ids present in both open and closed index: ${both.slice(0, 5)}`)

  const lp = await getJson(baseUrl, `/api/trading/live-positions?connection_id=${encodeURIComponent(connectionId)}&closedLimit=5000`)
  const th = await getJson(baseUrl, `/api/trading/trade-history?connection_id=${encodeURIComponent(connectionId)}&limit=5000`)
  const prog = await getJson(baseUrl, `/api/connections/progression/${encodeURIComponent(connectionId)}/stats`)
  info.routes = { livePositions: lp.status, tradeHistory: th.status, progression: prog.status }

  const livePositions = [
    ...(Array.isArray(lp.json?.positions) ? lp.json.positions : []),
    ...(Array.isArray(lp.json?.openPositions) ? lp.json.openPositions : []),
    ...(Array.isArray(lp.json?.closedPositions) ? lp.json.closedPositions : []),
  ]
  const byId = new Map()
  for (const p of livePositions) if (p?.id) byId.set(String(p.id), p)
  const apiOpen = [...byId.values()].filter((p) => String(p.status).toLowerCase() !== "closed")
  const apiClosed = [...byId.values()].filter((p) => String(p.status).toLowerCase() === "closed")
  info.livePositionsApi = { unique: byId.size, open: apiOpen.length, closed: apiClosed.length, keys: Object.keys(lp.json || {}).slice(0, 30) }

  // Duplicate open exposure: one open paper row per (symbol, side, set/config) key.
  const exposure = new Map()
  for (const p of apiOpen) {
    const key = [p.symbol, p.side || p.direction, p.setKey || p.strategySetKey || p.configKey || p.strategyConfigId || ""].join("|")
    exposure.set(key, (exposure.get(key) || 0) + 1)
  }
  const dupExposure = [...exposure.entries()].filter(([, n]) => n > 1)
  info.duplicateOpenExposure = dupExposure.slice(0, 10)
  if (dupExposure.length) issues.push(`${dupExposure.length} duplicated open (symbol,side,set) rows: ${JSON.stringify(dupExposure.slice(0, 3))}`)

  // Ledger PnL recomputation from closed rows returned by the API.
  const pnlOf = (p) => num(p.realizedPnL ?? p.realizedPnl ?? p.realized_pnl ?? p.pnl ?? p.netPnl)
  const pnls = apiClosed.map(pnlOf)
  const gp = pnls.filter((x) => x > 0).reduce((a, b) => a + b, 0)
  const gl = -pnls.filter((x) => x < 0).reduce((a, b) => a + b, 0)
  info.ledgerRecomputed = {
    closed: apiClosed.length, wins: pnls.filter((x) => x > 0).length, losses: pnls.filter((x) => x < 0).length,
    realizedPnl: Number(pnls.reduce((a, b) => a + b, 0).toFixed(6)), profitFactor: gl > 0 ? Number((gp / gl).toFixed(4)) : null,
  }
  info.tradeHistorySummary = th.json?.summary ?? null

  // Stats aggregator (lifetime summary) vs the ledger rows it summarises.
  const lanes = lp.json?.stats?.lifetime?.lanes?.all
  if (lanes) {
    const recomputed = info.ledgerRecomputed
    info.lifetimeAll = {
      closedTrades: lanes.closedTrades, wins: lanes.wins, losses: lanes.losses,
      realizedPnl: lanes.realizedPnl, profitFactor: lanes.profitFactor,
    }
    const closedIndexUnique = new Set(closed).size
    if (num(lanes.closedTrades) !== closedIndexUnique) issues.push(`lifetime closedTrades ${lanes.closedTrades} != closed ledger ${closedIndexUnique}`)
    if (apiClosed.length === closedIndexUnique) {
      if (num(lanes.wins) !== recomputed.wins || num(lanes.losses) !== recomputed.losses) {
        issues.push(`lifetime wins/losses ${lanes.wins}/${lanes.losses} != ledger ${recomputed.wins}/${recomputed.losses}`)
      }
      if (Math.abs(num(lanes.realizedPnl) - recomputed.realizedPnl) > 0.01 + 0.005 * apiClosed.length) {
        issues.push(`lifetime realizedPnl ${lanes.realizedPnl} != ledger ${recomputed.realizedPnl}`)
      }
      const pf = lanes.profitFactor
      if (recomputed.profitFactor !== null && pf != null && Math.abs(num(pf) - recomputed.profitFactor) > 0.02 * Math.max(1, recomputed.profitFactor)) {
        issues.push(`lifetime PF ${pf} != ledger PF ${recomputed.profitFactor}`)
      }
    }
    const all = lp.json?.stats?.all
    if (all && (num(all.open) !== apiOpen.length || num(all.closed) !== apiClosed.length)) {
      issues.push(`live-positions stats.all open/closed ${all.open}/${all.closed} != rows ${apiOpen.length}/${apiClosed.length}`)
    }
  } else {
    issues.push("live-positions API returned no lifetime lane summary")
  }
  info.livePositionsSummary = lp.json?.summary ?? lp.json?.stats ?? null

  // Every open/closed id in the Redis ledger should be visible via the API.
  const missingOpen = [...new Set(open)].filter((id) => !byId.has(id))
  if (missingOpen.length) issues.push(`${missingOpen.length} open ledger ids missing from live-positions API: ${missingOpen.slice(0, 5)}`)

  // Per-symbol coverage: market data + indication activity for every symbol.
  const coverage = {}
  for (const symbol of symbols) {
    const keys = []
    for await (const batch of redis.scanIterator({ MATCH: `*${symbol}*`, COUNT: 1000 })) {
      keys.push(...(Array.isArray(batch) ? batch : [batch]))
      if (keys.length > 5_000) break
    }
    coverage[symbol] = {
      keys: keys.length,
      marketData: keys.some((k) => k.startsWith("market_data:")),
      indication: keys.some((k) => /indication/.test(k)),
      strategy: keys.some((k) => /strateg|pseudo|position/.test(k)),
    }
  }
  const uncovered = Object.entries(coverage).filter(([, c]) => !c.marketData || !c.indication).map(([s]) => s)
  info.coverage = { symbols: symbols.length, fullyCovered: symbols.length - uncovered.length, uncovered, withStrategyKeys: Object.values(coverage).filter((c) => c.strategy).length }
  if (uncovered.length) issues.push(`symbols without market data/indication keys: ${uncovered.join(",")}`)
  info.progression = prog.json ? {
    historic: prog.json.historic ? { processed: prog.json.historic.symbolsProcessed, total: prog.json.historic.symbolsTotal, complete: prog.json.historic.isComplete } : null,
    realtime: prog.json.realtime ? { cycles: prog.json.realtime.realtimeCycles, cycleCounters: prog.json.realtime.cycleCounters } : null,
    breakdown: prog.json.breakdown ?? null,
  } : null
  for (const r of [lp, th, prog]) {
    if (r.status !== 200) issues.push(`${r.path} HTTP ${r.status}`)
    if (r.json) for (const p of findNonFinite(r.json)) issues.push(`non-finite ${r.path.split("?")[0]} ${p}`)
  }
  return { issues, info }
}

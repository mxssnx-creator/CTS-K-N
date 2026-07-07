#!/usr/bin/env node
/**
 * Engine progression probe — boot quickstart for 2 symbols, poll
 * /api/connections/progression/{id}/stats every 10s for 5 min, write
 * a structured JSON report to stderr at exit. Designed for CI / dev
 * and read by the conversation agent.
 *
 * The script presumes the dev server is already up on PORT 3002.
 */

const PORT = process.env.PORT || "3002"
const BASE = `http://localhost:${PORT}`
const RUN_MS = parseInt(process.env.RUN_MS || "300000", 10) // 5 min
const POLL_MS = parseInt(process.env.POLL_MS || "10000", 10) // 10 s
const SYMBOL_COUNT = parseInt(process.env.SYMBOLS || "2", 10)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function jfetch(path, init = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  })
  const text = await r.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = { _raw: text.slice(0, 400) }
  }
  return { status: r.status, ok: r.ok, json }
}

function fmtNum(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

async function main() {
  console.error(`[probe] booting quickstart for ${SYMBOL_COUNT} symbols, run=${RUN_MS}ms, poll=${POLL_MS}ms`)

  // 1) Quickstart enable
  const qs = await jfetch("/api/trade-engine/quick-start", {
    method: "POST",
    body: JSON.stringify({ action: "enable", symbolCount: SYMBOL_COUNT }),
  })
  if (!qs.ok) {
    console.error(`[probe] quickstart FAILED status=${qs.status} body=${JSON.stringify(qs.json).slice(0, 300)}`)
    process.exit(2)
  }
  const connectionId = qs.json?.connection?.id
  if (!connectionId) {
    console.error(`[probe] no connectionId in response: ${JSON.stringify(qs.json).slice(0, 300)}`)
    process.exit(3)
  }
  console.error(`[probe] connectionId=${connectionId} symbols=${JSON.stringify(qs.json?.symbols)}`)

  // 2) Trigger startup (engine coordinator startAll)
  const sa = await jfetch("/api/trade-engine/start-all", { method: "POST" })
  console.error(`[probe] start-all status=${sa.status}`)

  // 3) Poll
  const start = Date.now()
  const samples = []
  let lastSummary = ""
  while (Date.now() - start < RUN_MS) {
    const t = Math.floor((Date.now() - start) / 1000)
    const s = await jfetch(`/api/connections/progression/${connectionId}/stats`)
    if (s.ok) {
      const j = s.json || {}
      const histDone = !!(j.historic?.isComplete)
      const histPct = fmtNum(j.historic?.progressPercent)
      const symProc = fmtNum(j.historic?.symbolsProcessed)
      const symTot = fmtNum(j.historic?.symbolsTotal)
      const candles = fmtNum(j.historic?.candlesLoaded)
      const indCalc = fmtNum(j.historic?.indicatorsCalculated)
      const histCycles = fmtNum(j.historic?.cyclesCompleted)
      const rtCycles = fmtNum(j.realtime?.realtimeCycles)
      const rtFrames = fmtNum(j.realtime?.framesProcessed)
      const isActive = !!j.realtime?.isActive
      const stratTotal = fmtNum(j.realtime?.strategiesTotal)
      const stratLive = fmtNum(j.realtime?.cycleCounters?.strategyLive)
      const indLive = fmtNum(j.realtime?.cycleCounters?.indicationLive)
      const rtLive = fmtNum(j.realtime?.cycleCounters?.realtimeLive)
      const baseSets = fmtNum(j.breakdown?.strategies?.base)
      const mainSets = fmtNum(j.breakdown?.strategies?.main)
      const realSets = fmtNum(j.breakdown?.strategies?.real)
      const baseEval = fmtNum(j.breakdown?.strategies?.baseEvaluated)
      const mainEval = fmtNum(j.breakdown?.strategies?.mainEvaluated)
      const realEval = fmtNum(j.breakdown?.strategies?.realEvaluated)
      const sample = {
        t,
        histDone,
        histPct,
        symProc,
        symTot,
        candles,
        indCalc,
        histCycles,
        rtCycles,
        rtFrames,
        rtActive: isActive,
        stratTotal,
        indLive,
        stratLive,
        rtLive,
        sets: { base: baseSets, main: mainSets, real: realSets },
        eval: { base: baseEval, main: mainEval, real: realEval },
      }
      samples.push(sample)
      const summary = `t=${t}s hist=${histPct.toFixed(0)}%${histDone ? "DONE" : ""} sym=${symProc}/${symTot} candles=${candles} indCalc=${indCalc} histCycles=${histCycles} | rt act=${isActive} cyc=${rtCycles} frames=${rtFrames} indLive=${indLive} stratLive=${stratLive} rtLive=${rtLive} | sets b/m/r=${baseSets}/${mainSets}/${realSets} eval=${baseEval}/${mainEval}/${realEval}`
      if (summary !== lastSummary) {
        console.error(`[probe] ${summary}`)
        lastSummary = summary
      }
    } else {
      console.error(`[probe] stats fail status=${s.status}`)
    }
    await sleep(POLL_MS)
  }

  // 4) Final report
  const last = samples[samples.length - 1] || {}
  const first = samples[0] || {}
  const histDoneAt = samples.find((s) => s.histDone)
  // `rtActive` means the engine/HTTP status is alive; it does NOT prove the
  // realtime progression has processed generated prehistoric Sets. Treat
  // realtime as "started" only after counters/frames advance, otherwise a
  // clean pre-history gate is falsely reported as rtBeforeHist at t=0.
  const rtStartedAt = samples.find((s) => s.rtCycles > 0 || s.rtFrames > 0 || s.indLive > 0 || s.stratLive > 0 || s.rtLive > 0)

  // Find first sample with any base set ever created
  const firstBaseSet = samples.find((s) => s.sets.base > 0)
  const firstMainSet = samples.find((s) => s.sets.main > 0)
  const firstRealSet = samples.find((s) => s.sets.real > 0)

  // Fetch current detailed tracking for prevPos / realPos avg
  const tr = await jfetch(`/api/connections/progression/${connectionId}/stats`)
  const detail = tr.json || {}

  const report = {
    connectionId,
    runSec: Math.floor((Date.now() - start) / 1000),
    samples: samples.length,
    final: last,
    transitions: {
      histDoneAt: histDoneAt ? histDoneAt.t : null,
      rtStartedAt: rtStartedAt ? rtStartedAt.t : null,
      firstBaseSet: firstBaseSet ? firstBaseSet.t : null,
      firstMainSet: firstMainSet ? firstMainSet.t : null,
      firstRealSet: firstRealSet ? firstRealSet.t : null,
      rtBeforeHist: histDoneAt && rtStartedAt ? rtStartedAt.t < histDoneAt.t : null,
    },
    knownIssues: {
      noBasePF: !last.eval?.base || last.eval.base === 0,
      noRealPosAvg: (last.sets?.real || 0) === 0,
      histEndedTooFast: histDoneAt ? histDoneAt.t < 30 : false,
      noSetsCreated: (last.sets?.base || 0) === 0,
      noSetsEvaluated: (last.eval?.base || 0) === 0,
      rtBeforeHist: histDoneAt && rtStartedAt ? rtStartedAt.t < histDoneAt.t : false,
    },
    detailSample: {
      historic: detail.historic,
      realtime: {
        cycleCounters: detail.realtime?.cycleCounters,
        strategiesTotal: detail.realtime?.strategiesTotal,
        framesProcessed: detail.realtime?.framesProcessed,
      },
      breakdown: detail.breakdown,
    },
  }
  console.error(`\n[probe] === FINAL REPORT ===`)
  console.error(JSON.stringify(report, null, 2))
}

main().catch((e) => {
  console.error(`[probe] crash: ${e?.stack || e?.message || e}`)
  process.exit(1)
})

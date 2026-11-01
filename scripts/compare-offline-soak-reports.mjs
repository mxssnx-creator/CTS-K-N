#!/usr/bin/env node
/**
 * Markdown delta table of two offline soak reports
 * (scripts/run-offline-engine-soak.mjs JSON output).
 *
 *   node scripts/compare-offline-soak-reports.mjs before.json after.json [--labels "baseline,after"]
 */
import { readFileSync } from "node:fs"
import process from "node:process"

const [beforePath, afterPath] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
if (!beforePath || !afterPath) {
  console.error("usage: compare-offline-soak-reports.mjs before.json after.json [--labels a,b]")
  process.exit(2)
}
const labelArg = process.argv.indexOf("--labels")
const [labelA, labelB] = labelArg > 0 ? String(process.argv[labelArg + 1]).split(",") : ["before", "after"]
const read = (path) => JSON.parse(readFileSync(path, "utf8"))
const a = read(beforePath)
const b = read(afterPath)
const get = (report, path) => path.split(".").reduce((value, key) => (value == null ? value : value[key]), report.summary)
const rows = [
  ["Symbols", "symbols"],
  ["Pass p50 (ms)", "realtimePass.sampledLastPassMs.p50"],
  ["Pass p95 (ms)", "realtimePass.sampledLastPassMs.p95"],
  ["Pass max recorded (ms)", "realtimePass.recordedMaxMs"],
  ["Per-symbol p95 (ms)", "perSymbolMs.p95OfPassP95"],
  ["Indication phase per pass, median (ms)", "phaseSplitMedianMs.indication"],
  ["Strategy phase per pass, median (ms)", "phaseSplitMedianMs.strategy"],
  ["Realtime cycles", "realtimePass.realtimeCycleCount"],
  ["Event-loop delay p95, lifetime (ms)", "eventLoopLifetime.delayP95Ms"],
  ["Event-loop delay p99, lifetime (ms)", "eventLoopLifetime.delayP99Ms"],
  ["Event-loop delay max, lifetime (ms)", "eventLoopLifetime.delayMaxMs"],
  ["Liveness p50 (ms)", "liveness.p50Ms"],
  ["Liveness p95 (ms)", "liveness.p95Ms"],
  ["Liveness max (ms)", "liveness.maxMs"],
  ["Liveness > 1 s (%)", "liveness.over1sPct"],
  ["Slowest stats route p95 (ms)", "statsApiSlowestMs.p95"],
  ["RSS end (MB)", "rssMb.end"],
  ["RSS peak (MB)", "rssMb.peak"],
  ["Heap used end (MB)", "heapUsedMb.end"],
  ["Redis keys end", "redisKeys.end"],
  ["Redis used_memory end (MB)", "redisUsedMb.end"],
  ["Set keys total", "setInventory.total"],
  ["Set keys per symbol (median)", "setInventory.perSymbolMedian"],
  ["Simulated positions created", "simulatedOrders.created"],
  ["Simulated positions closed", "simulatedOrders.closed"],
  ["Audit issues", "auditIssues"],
  ["Server alerts", "serverAlerts"],
]
const delta = (x, y) => (Number.isFinite(x) && Number.isFinite(y) && x !== 0 ? `${y >= x ? "+" : ""}${Math.round(((y - x) / x) * 1000) / 10}%` : "")
console.log(`| Measure | ${labelA} | ${labelB} | Δ |`)
console.log("|---|---:|---:|---:|")
for (const [name, path] of rows) {
  const x = get(a, path)
  const y = get(b, path)
  console.log(`| ${name} | ${x ?? "–"} | ${y ?? "–"} | ${delta(Number(x), Number(y))} |`)
}
console.log(`\nVerifier exit: ${labelA} ${a.verifierExit}, ${labelB} ${b.verifierExit}.`)

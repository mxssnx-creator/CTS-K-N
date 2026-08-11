#!/usr/bin/env node
/*
 * Full 48-hour Direct-Trade CPU/process coordination benchmark.
 *
 * Every child evaluates one complete synthetic symbol matrix through the
 * production evaluator. The parent varies how many independent symbols run
 * simultaneously, verifies identical set counts, and records wall time,
 * throughput, heap and parent event-loop delay. No network, Redis, credential
 * or exchange-order path is imported.
 */
const { spawn } = require("node:child_process")
const { availableParallelism, freemem, totalmem } = require("node:os")
const { performance } = require("node:perf_hooks")
const { writeFileSync } = require("node:fs")
const { resolve } = require("node:path")

const repositoryRoot = resolve(__dirname, "..")
const matrixScript = resolve(__dirname, "test-direct-trade-matrix.cjs")
const historyHours = Math.max(1, Math.floor(Number(process.env.DIRECT_TRADE_SCALE_HOURS) || 48))
const outputFile = String(process.env.DIRECT_TRADE_SCALE_REPORT_FILE || "").trim()
const workerHeapMB = Math.max(768, Math.floor(Number(process.env.DIRECT_TRADE_SCALE_WORKER_HEAP_MB) || 1536))
const detectedParallelism = Math.max(1, availableParallelism())
const defaultSpecs = "1:1,2:1,2:2,3:1,3:2,3:3,4:1,4:2,4:4,8:2,8:4,8:7,8:8,16:4,16:7,16:8"
const firstSymbolIndex = Math.max(0, Math.floor(Number(process.env.DIRECT_TRADE_SCALE_START_SYMBOL) || 0))

function parseSpecs(raw) {
  const seen = new Set()
  return String(raw || defaultSpecs).split(",").map((entry) => {
    const [symbolsRaw, concurrencyRaw] = entry.trim().split(":")
    const symbols = Math.max(1, Math.floor(Number(symbolsRaw) || 1))
    const concurrency = Math.max(1, Math.min(symbols, Math.floor(Number(concurrencyRaw) || 1)))
    return { symbols, concurrency }
  }).filter((spec) => {
    const key = `${spec.symbols}:${spec.concurrency}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function runSymbol(symbolIndex) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      "-r",
      "ts-node/register",
      matrixScript,
    ], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        DIRECT_TRADE_MATRIX_SYMBOLS: "1",
        DIRECT_TRADE_MATRIX_START_SYMBOL: String(symbolIndex),
        DIRECT_TRADE_MATRIX_HOURS: String(historyHours),
        DIRECT_TRADE_MATRIX_PROGRESS: "0",
        DIRECT_TRADE_MATRIX_SUMMARY_ONLY: "1",
        NODE_OPTIONS: `--max-old-space-size=${workerHeapMB}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += String(chunk) })
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 16_000) stderr += String(chunk)
    })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`symbol ${symbolIndex} exited ${code}: ${stderr.slice(-4_000)}`))
        return
      }
      try {
        const line = stdout.trim().split(/\r?\n/).at(-1)
        resolvePromise(JSON.parse(line))
      } catch (error) {
        reject(new Error(`symbol ${symbolIndex} returned invalid JSON: ${stdout.slice(-2_000)} (${error})`))
      }
    })
  })
}

async function runSpec(spec, startSymbolIndex) {
  let next = 0
  const results = new Array(spec.symbols)
  let heartbeatExpected = performance.now() + 25
  let maximumParentEventLoopDelayMs = 0
  const heartbeat = setInterval(() => {
    const now = performance.now()
    maximumParentEventLoopDelayMs = Math.max(maximumParentEventLoopDelayMs, now - heartbeatExpected)
    heartbeatExpected = now + 25
  }, 25)
  const startedAt = performance.now()
  const worker = async () => {
    while (true) {
      const index = next++
      if (index >= spec.symbols) return
      results[index] = await runSymbol(startSymbolIndex + index)
    }
  }
  try {
    await Promise.all(Array.from({ length: spec.concurrency }, worker))
  } finally {
    clearInterval(heartbeat)
  }
  const wallMs = performance.now() - startedAt
  const expectedSetsPerSymbol = results[0]?.evaluatedSets
  if (!Number.isFinite(expectedSetsPerSymbol) || results.some((result) =>
    result?.historicHours !== historyHours || result?.evaluatedSets !== expectedSetsPerSymbol,
  )) {
    throw new Error(`matrix completeness mismatch for ${spec.symbols} symbols at concurrency ${spec.concurrency}`)
  }
  const evaluatedSets = results.reduce((sum, result) => sum + result.evaluatedSets, 0)
  const validSets = results.reduce((sum, result) => sum + result.validSets, 0)
  return {
    symbols: spec.symbols,
    concurrency: spec.concurrency,
    historicHours: historyHours,
    evaluatedSets,
    expectedSetsPerSymbol,
    validSets,
    wallMs: Math.round(wallMs),
    millisecondsPerSymbol: Math.round(wallMs / spec.symbols),
    setsPerSecond: Math.round(evaluatedSets / (wallMs / 1_000)),
    childElapsedMs: {
      minimum: Math.min(...results.map((result) => result.elapsedMs)),
      maximum: Math.max(...results.map((result) => result.elapsedMs)),
      mean: Math.round(results.reduce((sum, result) => sum + result.elapsedMs, 0) / results.length),
    },
    childHeapMiB: {
      maximum: Math.max(...results.map((result) => result.heapMiB)),
      sum: results.reduce((sum, result) => sum + result.heapMiB, 0),
    },
    maximumParentEventLoopDelayMs: Number(maximumParentEventLoopDelayMs.toFixed(2)),
  }
}

async function main() {
  const specs = parseSpecs(process.env.DIRECT_TRADE_SCALE_SPECS)
  const results = []
  for (const spec of specs) {
    // Every concurrency candidate for the same symbol count receives the
    // exact same deterministic market paths. Otherwise a faster/easier path
    // could be mistaken for a scheduler improvement.
    const result = await runSpec(spec, firstSymbolIndex)
    results.push(result)
    process.stderr.write(
      `[direct-scale] ${result.symbols} symbols @ ${result.concurrency}: ` +
      `${result.wallMs}ms, ${result.setsPerSecond} sets/s, heap max ${result.childHeapMiB.maximum}MiB\n`,
    )
  }
  const correctnessBySymbolCount = Object.values(results.reduce((groups, result) => {
    const group = groups[result.symbols] || (groups[result.symbols] = {
      symbols: result.symbols,
      expectedEvaluatedSets: result.evaluatedSets,
      expectedValidSets: result.validSets,
      variants: 0,
      identical: true,
    })
    group.variants++
    group.identical = group.identical &&
      group.expectedEvaluatedSets === result.evaluatedSets &&
      group.expectedValidSets === result.validSets
    return groups
  }, {}))
  if (correctnessBySymbolCount.some((group) => !group.identical)) {
    throw new Error("concurrency changed deterministic Direct-Trade results")
  }
  const fastestBySymbolCount = Object.values(results.reduce((best, result) => {
    const current = best[result.symbols]
    if (!current || result.wallMs < current.wallMs) best[result.symbols] = result
    return best
  }, {})).map((result) => ({
    symbols: result.symbols,
    concurrency: result.concurrency,
    wallMs: result.wallMs,
    setsPerSecond: result.setsPerSecond,
  }))
  const report = {
    test: "direct-trade-48h-symbol-coordination",
    runtime: {
      node: process.version,
      availableParallelism: detectedParallelism,
      totalMemoryMiB: Math.round(totalmem() / 1024 / 1024),
      freeMemoryMiBAtFinish: Math.round(freemem() / 1024 / 1024),
      workerHeapLimitMiB: workerHeapMB,
    },
    correctness: {
      allSpecsComplete: true,
      deterministicAcrossConcurrency: true,
      bySymbolCount: correctnessBySymbolCount,
      noNetworkRedisCredentialsOrOrders: true,
    },
    results,
    fastestBySymbolCount,
  }
  const serialized = JSON.stringify(report, null, 2)
  if (outputFile) writeFileSync(outputFile, `${serialized}\n`, "utf8")
  process.stdout.write(`${serialized}\n`)
}

main().catch((error) => {
  console.error("[direct-scale] failed", error)
  process.exitCode = 1
})

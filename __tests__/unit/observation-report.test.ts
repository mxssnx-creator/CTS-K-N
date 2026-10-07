import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * scripts/build-observation-report.mjs turns an observation directory into
 * report.html + summary.json. The figures it publishes (PF, drawdown,
 * profitable hours, acceptance criteria) must be exact.
 */
describe("observation report", () => {
  const HOUR = 3_600_000
  const base = Date.UTC(2026, 9, 6, 10)
  let dir = ""
  let out = ""

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "obs-in-"))
    out = mkdtempSync(join(tmpdir(), "obs-out-"))
    const at = (ms: number) => new Date(base + ms).toISOString()
    writeFileSync(join(dir, "run.json"), JSON.stringify({ connectionId: "bingx-x02", symbols: ["BTCUSDT", "ETHUSDT"], prehistoricHours: 24, startedAt: at(0) }))
    writeFileSync(join(dir, "events.jsonl"), [
      { at: at(0), type: "quickstart" },
      {
        at: at(60_000), type: "prehistoric_complete", afterMs: 60_000,
        prehistoric: { complete: true, processed: 2, total: 2, profitFactor: 1.4, profitFactorCount: 30 },
        marketData: { BTCUSDT: { source: "bingx" }, ETHUSDT: { source: "bingx" } },
      },
    ].map((line) => JSON.stringify(line)).join("\n"))
    const stage = (n: number) => ({ evaluated: n, passed: 1 })
    const sample = (ms: number, realtimeMs: number, rssMb: number) => ({
      at: at(ms), elapsedMs: ms, realtimeMs, rssMb, redis: { keys: 100, usedMb: 20 }, engineRunning: true,
      http: { stats: { status: 200, ms: 300 }, overview: { status: 200, ms: 100 }, status: { status: 200, ms: 50 } },
      stats: { stages: { base: stage(5), main: stage(4), real: stage(3), live: stage(2) }, open: { pseudo: 3, live: 1 } },
    })
    writeFileSync(join(dir, "samples.jsonl"), [sample(30_000, 0, 900), sample(90_000, 30_000, 1000), sample(150_000, 90_000, 1100)].map((line) => JSON.stringify(line)).join("\n"))
    const trade = (id: string, symbol: string, pnl: number, closedMs: number, setKey: string) => ({
      id, symbol, direction: "long", realizedPnl: pnl, grossPnl: pnl + 0.01, fees: 0.01,
      openedAt: base + closedMs - 120_000, closedAt: base + closedMs, setKey,
    })
    writeFileSync(join(dir, "simulated-trades.json"), JSON.stringify([
      trade("a", "BTCUSDT", 2, 5 * 60_000, "BTCUSDT:direction:long#block:2"),
      trade("b", "BTCUSDT", -1, 10 * 60_000, "BTCUSDT:direction:long"),     // hour 10: +1
      trade("c", "ETHUSDT", -3, HOUR + 60_000, "ETHUSDT:move:long"),        // hour 11: -3 (drawdown 4 from peak 2)
      trade("d", "ETHUSDT", 1.5, 2 * HOUR + 60_000, "ETHUSDT:move:long#dca"), // hour 12: +1.5
      { id: "open", symbol: "BTCUSDT", realizedPnl: null, closedAt: 0 },
    ]))
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ realtimeObservedMs: 90_000 }))
    writeFileSync(join(dir, "stats-final.json"), JSON.stringify({
      historic: {
        rangeHours: 24,
        dataCoverageHours: 24,
        typeMeasurement: {
          closes: 9,
          byTypeDirection: {
            "trend:long": { closed: 6, wins: 5, losses: 1, netPctSum: 2.4, positionCostRatio: 1.4 },
            "direction:long": { closed: 3, wins: 1, losses: 2, netPctSum: -0.9, positionCostRatio: 0.7 },
          },
        },
      },
      connectionStageOverview: { base: { pfMinimum: 1.3 } },
    }))
    writeFileSync(join(dir, "coverage-final.json"), JSON.stringify({ errors: 0, warnings: 1, findings: [{ severity: "warn", area: "x", message: "slow" }] }))
    execFileSync(process.execPath, ["scripts/build-observation-report.mjs", dir, out, "--title", "Fixture run"], { cwd: process.cwd() })
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  })

  test("paper figures are computed from closed trades only", () => {
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"))
    expect(summary.paper).toMatchObject({ trades: 4, wins: 2, losses: 2, activeHours: 3, profitableHours: 2 })
    expect(summary.paper.net).toBeCloseTo(-0.5, 10)
    expect(summary.paper.profitFactor).toBeCloseTo(3.5 / 4, 10)
    expect(summary.paper.maxDrawdown).toBeCloseTo(4, 10)
    expect(summary.paper.fees).toBeCloseTo(0.04, 10)
    expect(summary.bySymbol.map((row: any) => [row.key, row.trades])).toEqual([["BTCUSDT", 2], ["ETHUSDT", 2]])
    expect(summary.byType.map((row: any) => row.key).sort()).toEqual(["direction", "move"])
  })

  test("the per-type measurement is reported against the Base gate", () => {
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"))
    expect(summary.typeMeasurement.basePfMinimum).toBe(1.3)
    const [direction, trend] = summary.typeMeasurement.rows
    expect(direction).toMatchObject({ key: "direction:long", closed: 3, wins: 1, losses: 2, ratio: 0.7, meetsBase: false })
    expect(direction.meanNetPct).toBeCloseTo(-0.3, 10)
    expect(trend).toMatchObject({ key: "trend:long", closed: 6, wins: 5, losses: 1, ratio: 1.4, meetsBase: true })
    expect(trend.meanNetPct).toBeCloseTo(0.4, 10)
    expect(summary.typeMeasurement.rows).toHaveLength(2)
    const html = readFileSync(join(out, "report.html"), "utf8")
    expect(html).toContain("Prehistoric measurement per indication type")
    expect(html).toContain("trend:long")
  })

  test("acceptance criteria pass for a healthy run", () => {
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"))
    expect(summary.criteria.filter((criterion: any) => !criterion.pass)).toEqual([])
    expect(summary.passed).toBe(true)
    expect(summary.rssGrowthMb).toBe(100)
  })

  test("the trading outcome reports trades, qualifying types and downstream stages", () => {
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"))
    const byName = Object.fromEntries(summary.outcome.map((entry: any) => [entry.name, entry]))
    expect(byName["Paper trades closed"].value).toBe("4")
    expect(byName["Types at or above the Base threshold (whole range, all symbols)"]).toMatchObject({ value: "1/2", detail: "trend:long" })
    expect(byName["Stages beyond Base evaluated"].value).toBe("yes")
  })

  test("a run where no type qualifies passes on stability and explains the missing trades", () => {
    const quiet = mkdtempSync(join(tmpdir(), "obs-quiet-"))
    const quietOut = mkdtempSync(join(tmpdir(), "obs-quiet-out-"))
    try {
      for (const name of ["run.json", "events.jsonl", "summary.json", "coverage-final.json"]) {
        writeFileSync(join(quiet, name), readFileSync(join(dir, name)))
      }
      const samples = readFileSync(join(dir, "samples.jsonl"), "utf8").trim().split("\n").map((line) => {
        const sample = JSON.parse(line)
        for (const stage of ["main", "real", "live"]) sample.stats.stages[stage] = { evaluated: 0, passed: 0 }
        sample.stats.open = { pseudo: 0, live: 0 }
        return JSON.stringify(sample)
      })
      writeFileSync(join(quiet, "samples.jsonl"), samples.join("\n"))
      writeFileSync(join(quiet, "simulated-trades.json"), "[]")
      writeFileSync(join(quiet, "stats-final.json"), JSON.stringify({
        historic: {
          rangeHours: 24,
          dataCoverageHours: 24,
          typeMeasurement: { closes: 9, byTypeDirection: { "move:short": { closed: 9, wins: 4, losses: 5, netPctSum: -0.4, positionCostRatio: 0.96 } } },
        },
        connectionStageOverview: { base: { pfMinimum: 1.1 } },
      }))
      execFileSync(process.execPath, ["scripts/build-observation-report.mjs", quiet, quietOut], { cwd: process.cwd() })
      const summary = JSON.parse(readFileSync(join(quietOut, "summary.json"), "utf8"))
      expect(summary.passed).toBe(true)
      const trades = summary.outcome.find((entry: any) => entry.name === "Paper trades closed")
      expect(trades).toMatchObject({ value: "0", detail: "no trade: no type × direction reached the Base threshold 1.10" })
    } finally {
      rmSync(quiet, { recursive: true, force: true })
      rmSync(quietOut, { recursive: true, force: true })
    }
  })

  test("synthetic prices or missing coverage fail the market data criterion", () => {
    const synthetic = mkdtempSync(join(tmpdir(), "obs-syn-"))
    const syntheticOut = mkdtempSync(join(tmpdir(), "obs-syn-out-"))
    try {
      for (const name of ["events.jsonl", "samples.jsonl", "simulated-trades.json", "summary.json", "coverage-final.json"]) {
        writeFileSync(join(synthetic, name), readFileSync(join(dir, name)))
      }
      writeFileSync(join(synthetic, "run.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, "run.json"), "utf8")), marketDataMode: "synthetic" }))
      execFileSync(process.execPath, ["scripts/build-observation-report.mjs", synthetic, syntheticOut], { cwd: process.cwd() })
      const summary = JSON.parse(readFileSync(join(syntheticOut, "summary.json"), "utf8"))
      const criterion = summary.criteria.find((entry: any) => entry.name === "Prehistoric range covered by real market data")
      expect(criterion.pass).toBe(false)
      expect(summary.passed).toBe(false)
    } finally {
      rmSync(synthetic, { recursive: true, force: true })
      rmSync(syntheticOut, { recursive: true, force: true })
    }
  })

  test("the report is self-contained HTML with the verdict and checksums", () => {
    const html = readFileSync(join(out, "report.html"), "utf8")
    expect(html).toContain("PASS: 8/8 stability criteria met.")
    expect(html).toContain("Trading outcome")
    expect(html).toContain("<svg")
    expect(html).not.toMatch(/<script[^>]+src=/)
    const sums = readFileSync(join(out, "SHA256SUMS"), "utf8")
    expect(sums).toMatch(/^[0-9a-f]{64} {2}report\.html$/m)
  })
})

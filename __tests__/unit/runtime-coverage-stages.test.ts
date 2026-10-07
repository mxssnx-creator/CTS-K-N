import { execFile } from "node:child_process"
import { createServer, type Server } from "node:http"
import { promisify } from "node:util"

/**
 * scripts/verify-runtime-coverage.mjs reports a stage that evaluated nothing
 * as a processing gap — unless the stage before it passed nothing, in which
 * case the empty stage is the gates' outcome.
 */
const run = promisify(execFile)

function overview(evaluated: Record<string, number>) {
  return {
    strategiesEvaluatedByStage: evaluated,
    stageSnapshots: Object.fromEntries(Object.keys(evaluated).map((stage) => [stage, { complete: true }])),
  }
}

async function coverage(payloads: { overview: unknown; stats: unknown }): Promise<any> {
  const server: Server = createServer((request, response) => {
    const path = String(request.url || "").split("?")[0]
    const body = path === "/api/trade-engine/functional-overview"
      ? payloads.overview
      : path.startsWith("/api/connections/progression/")
        ? payloads.stats
        : { ok: true }
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    const { stdout } = await run(process.execPath, ["scripts/verify-runtime-coverage.mjs", "--json", "--report-only"], {
      cwd: process.cwd(),
      env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}`, CONNECTION_ID: "bingx-x01" },
    })
    return JSON.parse(stdout.trim().split("\n").pop() || "{}")
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe("runtime coverage: empty stages", () => {
  test("stages after a Base that passed nothing are the gates' outcome, not errors", async () => {
    const summary = await coverage({
      overview: overview({ base: 900, main: 0, real: 0, live: 0 }),
      stats: { strategyDetail: { base: { evaluated: 900, passed: 0 }, main: { evaluated: 0, passed: 0 }, real: { evaluated: 0, passed: 0 } } },
    })
    expect(summary.errors).toBe(0)
    expect(summary.findings.filter((finding: any) => finding.severity === "info").map((finding: any) => finding.message)).toEqual([
      "main stage evaluated 0 Sets: base passed none",
      "real stage evaluated 0 Sets: main passed none",
      "live stage evaluated 0 Sets: real passed none",
    ])
  })

  test("an empty stage after one that passed Sets stays an error", async () => {
    const summary = await coverage({
      overview: overview({ base: 900, main: 0, real: 0, live: 0 }),
      stats: { strategyDetail: { base: { evaluated: 900, passed: 12 }, main: { evaluated: 0, passed: 0 }, real: { evaluated: 0, passed: 0 } } },
    })
    expect(summary.findings.filter((finding: any) => finding.severity === "error").map((finding: any) => finding.message))
      .toEqual(["main stage evaluated 0 Sets"])
  })

  test("an empty Base is always an error", async () => {
    const summary = await coverage({
      overview: overview({ base: 0, main: 0, real: 0, live: 0 }),
      stats: { strategyDetail: { base: { evaluated: 0, passed: 0 } } },
    })
    expect(summary.findings.some((finding: any) => finding.severity === "error" && finding.message === "base stage evaluated 0 Sets")).toBe(true)
  })

  test("a historic phase complete with 0 candles is an error (no market data)", async () => {
    const summary = await coverage({
      overview: { strategiesEvaluatedByStage: {}, stageSnapshots: {} },
      stats: { historic: { isComplete: true, symbolsTotal: 15, candlesLoaded: 0 } },
    })
    expect(summary.findings.filter((finding: any) => finding.severity === "error").map((finding: any) => finding.message))
      .toEqual(["historic phase complete with 0 candles loaded for 15 symbols (no market data)"])
  })
})

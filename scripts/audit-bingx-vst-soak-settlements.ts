#!/usr/bin/env node

import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve, sep } from "node:path"

const VST_ORIGIN = "https://open-api-vst.bingx.com"

function finite(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function main(): Promise<void> {
  const startedAt = Date.now()
  const apiKey = String(process.env.BINGX_X02_API_KEY || "").trim()
  const apiSecret = String(process.env.BINGX_X02_API_SECRET || "").trim()
  if (apiKey.length < 10 || apiSecret.length < 10) {
    throw new Error("BINGX_X02_API_KEY and BINGX_X02_API_SECRET are required")
  }
  const logsDir = resolve(process.cwd(), ".agent-logs")
  const inputPath = resolve(String(process.env.BINGX_VST_REAUDIT_REPORT || ""))
  if (!inputPath.startsWith(`${logsDir}${sep}`) || !basename(inputPath).startsWith("bingx-vst-soak-")) {
    throw new Error("BINGX_VST_REAUDIT_REPORT must select a bingx-vst-soak report under .agent-logs")
  }
  const sourceBytes = await readFile(inputPath)
  const source = JSON.parse(sourceBytes.toString("utf8"))
  if (source?.environment !== "prod-vst" || source?.virtualFunds !== true || !Array.isArray(source?.cycles)) {
    throw new Error("The selected report is not a BingX Prod-VST soak report")
  }
  const executions = source.cycles.flatMap((cycle: any) => [
    { cycle, stage: "entry", order: cycle.entry },
    { cycle, stage: "accumulation", order: cycle.accumulation },
    { cycle, stage: "close", order: cycle.close },
  ])
  if (executions.some((row: any) => !String(row.order?.orderId || ""))) {
    throw new Error("The selected report contains a cycle without all three market-order IDs")
  }

  for (const key of ["BINGX_X02_API_KEY", "BINGX_X02_API_SECRET", "BINGX_API_KEY", "BINGX_API_SECRET"]) {
    delete process.env[key]
  }
  process.env.BINGX_ENVIRONMENT = "prod-vst"
  process.env.BINGX_VST_ORIGIN = VST_ORIGIN
  process.env.BINGX_PUBLIC_ORIGIN = VST_ORIGIN
  process.env.BINGX_PUBLIC_FALLBACK_ORIGIN = VST_ORIGIN
  process.env.DISABLE_BINGX_SDK_ORDERS = "1"

  const nativeFetch = globalThis.fetch.bind(globalThis)
  let blockedRequests = 0
  let networkRequests = 0
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url)
    if (url.protocol !== "https:" || url.origin !== VST_ORIGIN) {
      blockedRequests++
      throw new Error(`Settlement reaudit blocked non-VST origin ${url.origin}`)
    }
    networkRequests++
    return nativeFetch(input as any, init)
  }) as typeof fetch

  const { BingXConnector } = await import("@/lib/exchange-connectors/bingx-connector")
  const connector = new BingXConnector({
    apiKey,
    apiSecret,
    isTestnet: true,
    apiType: "perpetual_futures",
    contractType: "usdt-perpetual",
    positionMode: "hedge",
    connectionLibrary: "signed-rest-fallback",
  })
  const rows: any[] = []
  const missingOrderIds: string[] = []
  const mismatches: string[] = []
  for (const execution of executions) {
    const orderId = String(execution.order.orderId)
    let settlement = await connector.getOrderSettlement(execution.cycle.symbol, orderId)
    if (!settlement) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))
      settlement = await connector.getOrderSettlement(execution.cycle.symbol, orderId)
    }
    if (!settlement || String(settlement.orderId) !== orderId) {
      missingOrderIds.push(orderId)
      continue
    }
    const quantityDifference = finite(settlement.filledQuantity) - finite(execution.order.filledQuantity)
    const priceDifference = finite(settlement.averageFillPrice) - finite(execution.order.filledPrice)
    const quantityTolerance = Math.max(finite(execution.cycle.quantityStep) / 2, 1e-12)
    const priceTolerance = Math.max(1e-8, Math.abs(finite(execution.order.filledPrice)) * 1e-6)
    if (Math.abs(quantityDifference) > quantityTolerance) {
      mismatches.push(`${orderId}: quantity difference ${quantityDifference}`)
    }
    if (Math.abs(priceDifference) > priceTolerance) {
      mismatches.push(`${orderId}: price difference ${priceDifference}`)
    }
    rows.push({
      cycle: execution.cycle.index,
      tradePath: execution.cycle.tradePath,
      symbol: execution.cycle.symbol,
      direction: execution.cycle.direction,
      stage: execution.stage,
      orderId,
      filledQuantity: finite(settlement.filledQuantity),
      averageFillPrice: finite(settlement.averageFillPrice),
      grossRealizedPnl: finite(settlement.grossRealizedPnl),
      tradingFee: finite(settlement.tradingFee),
      netRealizedPnl: finite(settlement.netRealizedPnl),
      source: settlement.source,
      quantityDifference,
      priceDifference,
    })
  }
  const sum = (field: string) => rows.reduce((total, row) => total + finite(row[field]), 0)
  const paths = [...new Set(rows.map((row) => row.tradePath))].sort().map((tradePath) => {
    const pathRows = rows.filter((row) => row.tradePath === tradePath)
    return {
      tradePath,
      settledOrders: pathRows.length,
      grossRealizedPnl: pathRows.reduce((total, row) => total + row.grossRealizedPnl, 0),
      tradingFee: pathRows.reduce((total, row) => total + row.tradingFee, 0),
      netRealizedPnl: pathRows.reduce((total, row) => total + row.netRealizedPnl, 0),
    }
  })
  const success = blockedRequests === 0
    && missingOrderIds.length === 0
    && mismatches.length === 0
    && rows.length === executions.length
  const output = {
    schemaVersion: 1,
    success,
    environment: "prod-vst",
    virtualFunds: true,
    sourceReport: basename(inputPath),
    sourceReportSha256: createHash("sha256").update(sourceBytes).digest("hex"),
    sourceCycles: source.cycles.length,
    sourceExecutionAuditPassed: source.executionAudit?.success === true,
    sourceCounterAuditPassed: source.counters?.audit?.success === true,
    sourceTrailingAuditPassed: source.coverageMatrix?.trailingUpdate?.passed === true,
    sourceAccountFlat: source.account?.flatAfter === true && source.account?.baselineRestored === true,
    theoreticalPriceFallbackUsed: false,
    expectedMarketOrders: executions.length,
    settledMarketOrders: rows.length,
    missingOrderIds,
    mismatches,
    totals: {
      grossRealizedPnl: sum("grossRealizedPnl"),
      tradingFee: sum("tradingFee"),
      netRealizedPnl: sum("netRealizedPnl"),
    },
    paths,
    orders: rows,
    network: { exactOrigin: VST_ORIGIN, requests: networkRequests, blockedRequests },
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
  }
  const outputPath = join(logsDir, `bingx-vst-settlement-audit-${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}.json`)
  await mkdir(dirname(outputPath), { recursive: true })
  const serialized = `${JSON.stringify(output, null, 2)}\n`
  if (serialized.includes(apiKey) || serialized.includes(apiSecret)) {
    throw new Error("Credential redaction invariant failed; refusing to write settlement report")
  }
  await writeFile(outputPath, serialized, { encoding: "utf8", mode: 0o600 })
  if (!success) {
    throw new Error(`Settlement reaudit failed: missing=${missingOrderIds.length}, mismatches=${mismatches.length}`)
  }
  console.log(JSON.stringify({
    success,
    settledMarketOrders: rows.length,
    totals: output.totals,
    paths,
    elapsedMs: output.elapsedMs,
    report: outputPath,
  }))
}

void main().catch((error) => {
  console.error(`[bingx-vst-settlement-audit] ${errorText(error)}`)
  process.exitCode = 1
})

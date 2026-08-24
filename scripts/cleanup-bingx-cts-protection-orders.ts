#!/usr/bin/env node

import { BingXConnector } from "@/lib/exchange-connectors/bingx-connector"

type AccountName = "x01" | "x02"

function text(value: unknown): string {
  return String(value ?? "").trim()
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

function isCtsProtectionOrder(order: any): boolean {
  const clientOrderId = text(order?.clientOrderId ?? order?.clientOrderID ?? order?.client_oid).toLowerCase()
  const type = text(order?.type ?? order?.orderType).toUpperCase()
  return clientOrderId.startsWith("cts")
    && new Set(["STOP_MARKET", "TAKE_PROFIT_MARKET", "STOP", "TAKE_PROFIT"]).has(type)
}

async function main(): Promise<void> {
  const account = text(process.argv[2]).toLowerCase() as AccountName
  const apply = process.argv.includes("--apply")
  if (account !== "x01" && account !== "x02") {
    throw new Error("Usage: cleanup-bingx-cts-protection-orders.ts <x01|x02> [--apply]")
  }
  if (account === "x01" && apply && process.env.ALLOW_BINGX_LIVE_PROTECTION_CLEANUP !== "1") {
    throw new Error("X01 apply requires ALLOW_BINGX_LIVE_PROTECTION_CLEANUP=1")
  }
  const isDemo = account === "x02"
  const apiKey = text(process.env[isDemo ? "BINGX_X02_API_KEY" : "BINGX_API_KEY"])
  const apiSecret = text(process.env[isDemo ? "BINGX_X02_API_SECRET" : "BINGX_API_SECRET"])
  if (apiKey.length < 10 || apiSecret.length < 10) throw new Error(`Missing ${account.toUpperCase()} credentials`)

  const connector = new BingXConnector({
    apiKey,
    apiSecret,
    isTestnet: isDemo,
    apiType: "perpetual_futures",
    contractType: "usdt-perpetual",
    marginType: "cross",
    positionMode: "hedge",
    connectionLibrary: "signed-rest-fallback",
  })
  const openOrders = await connector.getOpenOrders()
  const ctsProtection = openOrders.filter(isCtsProtectionOrder)
  const externalOrUnknown = openOrders.filter((order: any) => !isCtsProtectionOrder(order))
  const bySymbol = new Map<string, string[]>()
  for (const order of ctsProtection) {
    const symbol = text(order?.symbol)
    const orderId = text(order?.orderId ?? order?.orderID ?? order?.id)
    if (!symbol || !orderId) continue
    const ids = bySymbol.get(symbol) || []
    ids.push(orderId)
    bySymbol.set(symbol, ids)
  }

  let requested = 0
  let batchesSucceeded = 0
  let batchesFailed = 0
  if (apply) {
    for (const [symbol, orderIds] of bySymbol) {
      for (const batch of chunks([...new Set(orderIds)], 10)) {
        requested += batch.length
        const response = await connector.batchCancelOrders(symbol, batch)
        if (response.success) batchesSucceeded++
        else batchesFailed++
      }
    }
  }
  const report = {
    account,
    environment: connector.getEnvironmentInfo(),
    dryRun: !apply,
    openOrders: openOrders.length,
    ctsProtectionOrders: ctsProtection.length,
    externalOrUnknownOrdersPreserved: externalOrUnknown.length,
    symbols: [...bySymbol.entries()].map(([symbol, ids]) => ({ symbol, count: new Set(ids).size })),
    requested,
    batchesSucceeded,
    batchesFailed,
  }
  const serialized = JSON.stringify(report)
  if (serialized.includes(apiKey) || serialized.includes(apiSecret)) throw new Error("Credential redaction invariant failed")
  console.log(JSON.stringify(report, null, 2))
  if (apply && batchesFailed > 0) process.exitCode = 1
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

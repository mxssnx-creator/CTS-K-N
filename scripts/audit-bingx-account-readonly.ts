#!/usr/bin/env node

import { BingXConnector } from "@/lib/exchange-connectors/bingx-connector"

type AccountName = "x01" | "x02"

function finite(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function text(value: unknown): string {
  return String(value ?? "").trim()
}

function orderClientId(order: any): string {
  return text(order?.clientOrderId ?? order?.clientOrderID ?? order?.client_oid)
}

function ownerClass(order: any): "cts" | "external" | "missing" {
  const clientId = orderClientId(order)
  if (!clientId) return "missing"
  return clientId.toLowerCase().startsWith("cts") ? "cts" : "external"
}

function ctsPrefix(order: any): string {
  const clientId = orderClientId(order)
  if (!clientId.toLowerCase().startsWith("cts")) return ""
  const withoutTimeSuffix = clientId.replace(/[0-9].*$/, "")
  return (withoutTimeSuffix || clientId).slice(0, 16)
}

function groupCount(rows: any[], keyFor: (row: any) => string): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = keyFor(row)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

function compactPosition(position: any): Record<string, unknown> {
  return {
    symbol: text(position?.symbol),
    side: text(position?.positionSide ?? position?.side).toUpperCase(),
    quantity: Math.abs(finite(position?.positionAmt ?? position?.contracts ?? position?.size)),
    entryPrice: finite(position?.entryPrice ?? position?.avgPrice),
  }
}

function orderDuplicateKey(order: any): string {
  return [
    text(order?.symbol),
    text(order?.type ?? order?.orderType),
    text(order?.side),
    text(order?.positionSide),
    finite(order?.stopPrice ?? order?.triggerPrice ?? order?.price).toPrecision(12),
    finite(order?.origQty ?? order?.quantity).toPrecision(12),
    ownerClass(order),
  ].join("|")
}

async function inspectAccount(account: AccountName): Promise<Record<string, unknown>> {
  const isDemo = account === "x02"
  const apiKey = text(process.env[isDemo ? "BINGX_X02_API_KEY" : "BINGX_API_KEY"])
  const apiSecret = text(process.env[isDemo ? "BINGX_X02_API_SECRET" : "BINGX_API_SECRET"])
  if (apiKey.length < 10 || apiSecret.length < 10) {
    throw new Error(`Missing server-side BingX ${account.toUpperCase()} credentials`)
  }

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
  const [rawPositions, openOrders] = await Promise.all([
    connector.getPositions(),
    connector.getOpenOrders(),
  ])
  const positions = rawPositions
    .filter((position: any) => Math.abs(finite(position?.positionAmt ?? position?.contracts ?? position?.size)) > 0)
    .map(compactPosition)
    .sort((a, b) => `${a.symbol}|${a.side}`.localeCompare(`${b.symbol}|${b.side}`))
  const duplicateGroups = groupCount(openOrders, orderDuplicateKey)
    .filter((group) => group.count > 1)
    .slice(0, 40)

  const result = {
    account,
    environment: connector.getEnvironmentInfo(),
    positionsSnapshot: connector.getLastPositionsSnapshotStatus(),
    openOrdersSnapshot: connector.getLastOpenOrdersSnapshotStatus(),
    positionCount: positions.length,
    positions,
    openOrderCount: openOrders.length,
    ordersByOwner: groupCount(openOrders, ownerClass),
    ordersByShape: groupCount(openOrders, (order) => [
      text(order?.type ?? order?.orderType),
      text(order?.side),
      text(order?.positionSide),
      ownerClass(order),
    ].join("|")),
    ordersBySymbol: groupCount(openOrders, (order) => text(order?.symbol)),
    ctsClientPrefixes: groupCount(openOrders.filter((order) => ownerClass(order) === "cts"), ctsPrefix),
    duplicateGroupCount: duplicateGroups.length,
    duplicateGroups,
  }
  const serialized = JSON.stringify(result)
  if (serialized.includes(apiKey) || serialized.includes(apiSecret)) {
    throw new Error("Credential redaction invariant failed")
  }
  return result
}

async function main(): Promise<void> {
  const requested = text(process.argv[2] || "both").toLowerCase()
  const accounts: AccountName[] = requested === "both"
    ? ["x01", "x02"]
    : requested === "x01" || requested === "x02"
      ? [requested]
      : (() => { throw new Error("Usage: audit-bingx-account-readonly.ts [x01|x02|both]") })()
  const reports = []
  for (const account of accounts) reports.push(await inspectAccount(account))
  console.log(JSON.stringify({ readOnly: true, generatedAt: new Date().toISOString(), reports }, null, 2))
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

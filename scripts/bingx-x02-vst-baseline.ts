#!/usr/bin/env node

/**
 * Read-only X02 Prod-VST account baseline: COUNTS ONLY.
 *
 * Before and after a VST engine run this records how many positions and open
 * orders the virtual-funds account holds and who owns the orders, so the
 * close-out can prove that this run left nothing behind and touched nothing
 * foreign. It prints no symbol, price, quantity, order id or balance (no raw
 * account report), and refuses to run unless the connector resolves to the
 * BingX VST host. Credentials come from BINGX_X02_API_KEY/SECRET only.
 *
 *   node --import tsx scripts/bingx-x02-vst-baseline.ts [--system cts-k-n-cloud] [--out snapshot.json] [--compare before.json]
 *
 * Owner classes of an open order (client order id):
 *   run         this run's system id (kn/kt + hash of CTS_SYSTEM_ID|bingx-x02)
 *   server      the deployed CTS-K-N (default system id "cts-k-n", or the legacy "ctsbingxx02" prefix)
 *   other-cts   any other "cts…" client id (other CTS variants on the account)
 *   other       every other client id; missing = no client id
 */
import { readFileSync, writeFileSync } from "node:fs"
import { BingXConnector } from "@/lib/exchange-connectors/bingx-connector"
import { clientOrderConnectionPrefix, systemOrderHash } from "@/lib/system-order-ownership"

const CONNECTION_ID = "bingx-x02"
const VST_HOSTS = new Set(["open-api-vst.bingx.com", "open-api-vst.bingx.pro"])

const arg = (name: string): string => {
  const index = process.argv.indexOf(name)
  return index > 0 ? String(process.argv[index + 1] || "") : ""
}
const text = (value: unknown): string => String(value ?? "").trim()
const finite = (value: unknown): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export type OwnerClass = "run" | "server" | "other-cts" | "other" | "missing"

export function orderOwnerClass(clientOrderId: unknown, runSystemId: string): OwnerClass {
  const id = text(clientOrderId).toLowerCase()
  if (!id) return "missing"
  const prefixes = (systemId: string) => [`kn${systemOrderHash(CONNECTION_ID, systemId)}`, `kt${systemOrderHash(CONNECTION_ID, systemId)}`]
  if (prefixes(runSystemId).some((prefix) => id.length > prefix.length && id.startsWith(prefix))) return "run"
  const server = [...prefixes("cts-k-n"), clientOrderConnectionPrefix(CONNECTION_ID)]
  if (server.some((prefix) => id.length > prefix.length && id.startsWith(prefix))) return "server"
  if (id.startsWith("cts")) return "other-cts"
  return "other"
}

function countBy<T>(rows: readonly T[], key: (row: T) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const row of rows) out[key(row)] = (out[key(row)] || 0) + 1
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

async function main(): Promise<void> {
  const apiKey = text(process.env.BINGX_X02_API_KEY)
  const apiSecret = text(process.env.BINGX_X02_API_SECRET)
  if (apiKey.length < 10 || apiSecret.length < 10) throw new Error("BINGX_X02_API_KEY/SECRET are required")
  const runSystemId = arg("--system") || text(process.env.CTS_SYSTEM_ID) || "cts-k-n-cloud"
  const connector = new BingXConnector({
    apiKey,
    apiSecret,
    isTestnet: true,
    apiType: "perpetual_futures",
    contractType: "usdt-perpetual",
    marginType: "cross",
    positionMode: "hedge",
    connectionLibrary: "signed-rest-fallback",
  } as any)
  const environment = connector.getEnvironmentInfo() as Record<string, unknown>
  const host = (() => {
    try { return new URL(text(environment?.baseUrl ?? environment?.origin ?? environment?.url)).hostname } catch { return "" }
  })()
  if (!VST_HOSTS.has(host)) throw new Error(`refusing: connector does not resolve to the BingX VST host (got "${host || "unknown"}")`)

  const [rawPositions, openOrders] = await Promise.all([connector.getPositions(), connector.getOpenOrders()])
  // An empty answer only counts when the venue answered: a failed snapshot is
  // reported as such instead of looking like an empty account.
  const positionsStatus = connector.getLastPositionsSnapshotStatus() as { ok?: boolean; error?: string }
  const ordersStatus = connector.getLastOpenOrdersSnapshotStatus()
  if (!positionsStatus?.ok || !ordersStatus?.ok) {
    throw new Error(`venue snapshot not authoritative (positions ${positionsStatus?.ok ? "ok" : "failed"}, orders ${ordersStatus?.ok ? "ok" : "failed"})`)
  }
  const positions = (rawPositions || []).filter((position: any) => Math.abs(finite(position?.positionAmt ?? position?.contracts ?? position?.size)) > 0)
  const orders = openOrders || []
  const snapshot = {
    readOnly: true,
    at: new Date().toISOString(),
    host,
    runSystemId,
    positions: {
      count: positions.length,
      bySide: countBy(positions, (position: any) => text(position?.positionSide ?? position?.side).toUpperCase() || "UNKNOWN"),
    },
    openOrders: {
      count: orders.length,
      byOwner: countBy(orders, (order: any) => orderOwnerClass(order?.clientOrderId ?? order?.clientOrderID ?? order?.client_oid, runSystemId)),
      byType: countBy(orders, (order: any) => text(order?.type ?? order?.orderType).toUpperCase() || "UNKNOWN"),
    },
  }
  const compareFile = arg("--compare")
  const output: Record<string, unknown> = { ...snapshot }
  if (compareFile) {
    const before = JSON.parse(readFileSync(compareFile, "utf8"))
    const ownerKeys = new Set([...Object.keys(before?.openOrders?.byOwner || {}), ...Object.keys(snapshot.openOrders.byOwner)])
    output.delta = {
      positions: snapshot.positions.count - Number(before?.positions?.count || 0),
      openOrdersByOwner: Object.fromEntries([...ownerKeys].sort().map((key) => [
        key,
        Number((snapshot.openOrders.byOwner as Record<string, number>)[key] || 0) - Number(before?.openOrders?.byOwner?.[key] || 0),
      ])),
      runOrdersLeft: Number((snapshot.openOrders.byOwner as Record<string, number>).run || 0),
    }
  }
  const serialized = JSON.stringify(output, null, 2)
  if (serialized.includes(apiKey) || serialized.includes(apiSecret)) throw new Error("Credential redaction invariant failed")
  // The connector logs to stdout as well; --out keeps a clean JSON file.
  const outFile = arg("--out")
  if (outFile) writeFileSync(outFile, `${serialized}\n`, { mode: 0o600 })
  console.log(serialized)
}

if (process.argv[1] && /bingx-x02-vst-baseline\.ts$/.test(process.argv[1])) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

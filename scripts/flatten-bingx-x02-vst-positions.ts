#!/usr/bin/env node

import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { BingXConnector } from "@/lib/exchange-connectors/bingx-connector"
import { getRuntimeMaintenanceState } from "@/lib/runtime-maintenance"

const CONNECTION_ID = "bingx-x02"
const APPLY_CONFIRMATION = "I understand this flattens only BingX X02 Prod-VST virtual positions"
const GUARDED_UNITS = [
  "cts-kn.service",
  "cts-kn-scheduler.service",
  "cts-kn-direct-trade.service",
] as const
const MAX_SLOTS = 8
const SETTLEMENT_TIMEOUT_MS = 30_000

type Direction = "long" | "short"
type PositionSlot = {
  symbol: string
  direction: Direction
  quantity: number
  entryPrice: number
}

function text(value: unknown): string {
  return String(value ?? "").trim()
}

function finite(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function argument(name: string): string {
  const index = process.argv.indexOf(name)
  return index >= 0 ? text(process.argv[index + 1]) : ""
}

function inactiveUnit(unit: string): boolean {
  const result = spawnSync("systemctl", ["is-active", unit], {
    encoding: "utf8",
    timeout: 5_000,
  })
  return text(result.stdout) === "inactive"
}

function assertMaintenanceAndServicesOff(): void {
  const maintenance = getRuntimeMaintenanceState()
  if (maintenance.reason !== "marker_present") {
    throw new Error("X02 VST flatten requires the runtime maintenance marker")
  }
  const activeUnits = GUARDED_UNITS.filter((unit) => !inactiveUnit(unit))
  if (activeUnits.length > 0) {
    throw new Error("X02 VST flatten requires all trading services to be inactive")
  }
}

function directionOf(position: any, signedQuantity: number): Direction | null {
  const raw = text(position?.positionSide ?? position?.direction ?? position?.side).toLowerCase()
  if (raw === "long" || raw === "buy") return "long"
  if (raw === "short" || raw === "sell") return "short"
  if (signedQuantity > 0) return "long"
  if (signedQuantity < 0) return "short"
  return null
}

function canonicalPositions(rawPositions: any[]): PositionSlot[] {
  const slots: PositionSlot[] = []
  for (const position of rawPositions) {
    const signedQuantity = finite(
      position?.positionAmt
      ?? position?.contracts
      ?? position?.size
      ?? position?.quantity,
    )
    const quantity = Math.abs(signedQuantity)
    if (!(quantity > 0)) continue
    const symbol = text(position?.symbol).toUpperCase()
    const direction = directionOf(position, signedQuantity)
    if (!symbol || !direction) {
      throw new Error("Authoritative X02 position has an invalid symbol or direction")
    }
    slots.push({
      symbol,
      direction,
      quantity,
      entryPrice: finite(position?.entryPrice ?? position?.avgPrice),
    })
  }
  return slots.sort((left, right) =>
    `${left.symbol}|${left.direction}`.localeCompare(`${right.symbol}|${right.direction}`),
  )
}

function snapshotDigest(slots: PositionSlot[]): string {
  return createHash("sha256").update(JSON.stringify(slots)).digest("hex")
}

function snapshotsEqual(left: PositionSlot[], right: PositionSlot[]): boolean {
  return snapshotDigest(left) === snapshotDigest(right)
}

function sanitizedFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[A-Za-z0-9_-]{36,}/g, "[redacted]").slice(0, 500)
}

function connectorFor(apiKey: string, apiSecret: string): BingXConnector {
  return new BingXConnector({
    apiKey,
    apiSecret,
    isTestnet: true,
    apiType: "perpetual_futures",
    contractType: "usdt-perpetual",
    marginType: "cross",
    positionMode: "hedge",
    connectionLibrary: "signed-rest-fallback",
  })
}

async function authoritativePositions(connector: BingXConnector): Promise<PositionSlot[]> {
  const raw = await connector.getPositions()
  const status = connector.getLastPositionsSnapshotStatus()
  if (!Array.isArray(raw) || status?.ok !== true) {
    throw new Error("X02 VST flatten requires an authoritative position snapshot")
  }
  return canonicalPositions(raw)
}

async function authoritativeOrders(connector: BingXConnector): Promise<any[]> {
  const orders = await connector.getOpenOrders(undefined, { forceRefresh: true })
  const status = connector.getLastOpenOrdersSnapshotStatus()
  if (!Array.isArray(orders) || status?.ok !== true) {
    throw new Error("X02 VST flatten requires an authoritative open-order snapshot")
  }
  return orders
}

async function waitForSnapshot(
  connector: BingXConnector,
  expected: PositionSlot[],
): Promise<PositionSlot[]> {
  const deadline = Date.now() + SETTLEMENT_TIMEOUT_MS
  let observed: PositionSlot[] = []
  while (Date.now() < deadline) {
    observed = await authoritativePositions(connector)
    if (snapshotsEqual(observed, expected)) return observed
    await new Promise<void>((resolve) => setTimeout(resolve, 750))
  }
  throw new Error(
    `X02 VST position settlement did not reach the expected snapshot; expected=${expected.length} observed=${observed.length}`,
  )
}

async function persistReport(
  payload: Record<string, unknown>,
  apiKey: string,
  apiSecret: string,
): Promise<string> {
  const reportDir = join(process.cwd(), ".agent-logs")
  const reportPath = join(
    reportDir,
    `bingx-x02-vst-flatten-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  )
  const serialized = `${JSON.stringify(payload, null, 2)}\n`
  if (serialized.includes(apiKey) || serialized.includes(apiSecret)) {
    throw new Error("Credential redaction invariant failed; refusing to write report")
  }
  await mkdir(reportDir, { recursive: true, mode: 0o700 })
  await writeFile(reportPath, serialized, { encoding: "utf8", mode: 0o600 })
  return reportPath
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply")
  const expectedDigest = argument("--expect-snapshot").toLowerCase()
  if (apply && !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new Error("Apply requires --expect-snapshot with the exact dry-run SHA-256")
  }
  if (apply && text(process.env.X02_VST_FLATTEN_CONFIRM) !== APPLY_CONFIRMATION) {
    throw new Error(`Apply requires X02_VST_FLATTEN_CONFIRM=\"${APPLY_CONFIRMATION}\"`)
  }

  const apiKey = text(process.env.BINGX_X02_API_KEY)
  const apiSecret = text(process.env.BINGX_X02_API_SECRET)
  if (apiKey.length < 10 || apiSecret.length < 10) {
    throw new Error("Server-side BINGX_X02_API_KEY and BINGX_X02_API_SECRET are required")
  }
  assertMaintenanceAndServicesOff()

  const connector = connectorFor(apiKey, apiSecret)
  const environment = connector.getEnvironmentInfo()
  if (environment?.environment !== "prod-vst" || environment?.usesVirtualFunds !== true) {
    throw new Error("Refusing X02 flatten outside BingX Prod-VST virtual funds")
  }

  const initialPositions = await authoritativePositions(connector)
  const initialOrders = await authoritativeOrders(connector)
  const digest = snapshotDigest(initialPositions)
  if (initialPositions.length > MAX_SLOTS) {
    throw new Error(`X02 VST flatten refuses more than ${MAX_SLOTS} physical slots`)
  }
  if (initialOrders.length > 0) {
    throw new Error("X02 VST flatten refuses while any venue order is open")
  }

  const closed: Array<{ symbol: string; direction: Direction; quantity: number }> = []
  let finalPositions = initialPositions
  let finalOrders = initialOrders
  if (apply) {
    if (digest !== expectedDigest) {
      throw new Error("X02 VST position snapshot changed after dry-run; refusing apply")
    }
    let remaining = [...initialPositions]
    for (const slot of initialPositions) {
      assertMaintenanceAndServicesOff()
      const current = await authoritativePositions(connector)
      if (!snapshotsEqual(current, remaining)) {
        throw new Error("X02 VST position snapshot changed before reduce-only close")
      }
      const result = await connector.closePosition(slot.symbol, slot.direction)
      if (result.success !== true) {
        throw new Error(`Reduce-only close failed for ${slot.symbol} ${slot.direction}: ${result.error || "unknown"}`)
      }
      closed.push({ symbol: slot.symbol, direction: slot.direction, quantity: slot.quantity })
      remaining = remaining.filter((candidate) =>
        candidate.symbol !== slot.symbol || candidate.direction !== slot.direction,
      )
      await waitForSnapshot(connector, remaining)
    }
    assertMaintenanceAndServicesOff()
    finalPositions = await authoritativePositions(connector)
    finalOrders = await authoritativeOrders(connector)
    if (finalPositions.length !== 0 || finalOrders.length !== 0) {
      throw new Error("X02 VST final flat-state audit failed")
    }
  }

  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    account: "x02",
    connectionId: CONNECTION_ID,
    environment: "prod-vst",
    virtualFunds: true,
    apply,
    success: !apply || (finalPositions.length === 0 && finalOrders.length === 0),
    snapshotDigest: digest,
    initialPositions,
    initialOpenOrderCount: initialOrders.length,
    closed,
    finalPositions,
    finalOpenOrderCount: finalOrders.length,
  }
  const reportPath = await persistReport(payload, apiKey, apiSecret)
  console.log(JSON.stringify({
    success: payload.success,
    apply,
    snapshotDigest: digest,
    initialPositionCount: initialPositions.length,
    initialOpenOrderCount: initialOrders.length,
    closedCount: closed.length,
    finalPositionCount: finalPositions.length,
    finalOpenOrderCount: finalOrders.length,
    positions: apply ? undefined : initialPositions,
    reportPath,
  }))
}

const executionKeepAlive = setInterval(() => undefined, 1_000)
void main()
  .catch((error) => {
    console.error(sanitizedFailure(error))
    process.exitCode = 1
  })
  .finally(() => {
    clearInterval(executionKeepAlive)
    setImmediate(() => process.exit(process.exitCode ?? 0))
  })

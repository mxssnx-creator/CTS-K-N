#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { BingXConnector } from "@/lib/exchange-connectors/bingx-connector"
import { getRuntimeMaintenanceState } from "@/lib/runtime-maintenance"
import {
  reconcileLiveProtectionSlot,
  type LiveProtectionSlotReconciliationReport,
} from "@/lib/trade-engine/stages/live-stage"

const CONNECTION_ID = "bingx-x02"
const APPLY_CONFIRMATION = "I understand this reconciles one CTS-owned Prod-VST slot"
const GUARDED_UNITS = [
  "cts-kn.service",
  "cts-kn-scheduler.service",
  "cts-kn-direct-trade.service",
] as const

function text(value: unknown): string {
  return String(value ?? "").trim()
}

function argument(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name)
  return index >= 0 ? text(process.argv[index + 1]) : fallback
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
    throw new Error("X02 exact-slot reconciliation requires the runtime maintenance marker")
  }
  const activeUnits = GUARDED_UNITS.filter((unit) => !inactiveUnit(unit))
  if (activeUnits.length > 0) {
    throw new Error("X02 exact-slot reconciliation requires all trading services to be inactive")
  }
}

function sanitizedFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[A-Za-z0-9_-]{36,}/g, "[redacted]").slice(0, 500)
}

async function persistReport(
  payload: Record<string, unknown>,
  apiKey: string,
  apiSecret: string,
): Promise<string> {
  const reportDir = join(process.cwd(), ".agent-logs")
  const reportPath = join(
    reportDir,
    `bingx-x02-protection-slot-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
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
  const symbol = argument("--symbol").toUpperCase().replace(/[^A-Z0-9]/g, "")
  const direction = argument("--direction").toLowerCase()
  if (!symbol || (direction !== "long" && direction !== "short")) {
    throw new Error(
      "Usage: reconcile-bingx-x02-protection-slot.ts --symbol SYMBOL --direction long|short [--apply]",
    )
  }
  if (apply && text(process.env.X02_SLOT_PROTECTION_CONFIRM) !== APPLY_CONFIRMATION) {
    throw new Error(`Apply requires X02_SLOT_PROTECTION_CONFIRM=\"${APPLY_CONFIRMATION}\"`)
  }

  const apiKey = text(process.env.BINGX_X02_API_KEY)
  const apiSecret = text(process.env.BINGX_X02_API_SECRET)
  if (apiKey.length < 10 || apiSecret.length < 10) {
    throw new Error("Server-side BINGX_X02_API_KEY and BINGX_X02_API_SECRET are required")
  }
  assertMaintenanceAndServicesOff()

  const connector = new BingXConnector({
    apiKey,
    apiSecret,
    isTestnet: true,
    apiType: "perpetual_futures",
    contractType: "usdt-perpetual",
    marginType: "cross",
    positionMode: "hedge",
    connectionLibrary: "signed-rest-fallback",
  })
  const environment = connector.getEnvironmentInfo()
  if (environment?.environment !== "prod-vst" || environment?.usesVirtualFunds !== true) {
    throw new Error("Refusing exact-slot reconciliation outside BingX Prod-VST virtual funds")
  }

  let report: LiveProtectionSlotReconciliationReport | null = null
  let failure: string | null = null
  try {
    report = await reconcileLiveProtectionSlot(CONNECTION_ID, connector, {
      symbol,
      direction,
      apply,
      expectedEnvironment: "prod-vst",
      maxOrphanCancellations: 4,
      assertMutationAllowed: assertMaintenanceAndServicesOff,
    })
  } catch (error) {
    failure = sanitizedFailure(error)
  }

  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    account: "x02",
    connectionId: CONNECTION_ID,
    environment: "prod-vst",
    virtualFunds: true,
    apply,
    symbol,
    direction,
    success: report?.success === true && failure === null,
    report,
    error: failure,
  }
  const reportPath = await persistReport(payload, apiKey, apiSecret)
  console.log(JSON.stringify({
    success: payload.success,
    apply,
    symbol,
    direction,
    localRows: report?.localRows ?? 0,
    expectedControlOrders: report?.after?.expectedControlOrderCount
      ?? report?.before.expectedControlOrderCount
      ?? 0,
    finalControlOrders: report?.after?.observedExpectedControlOrderCount
      ?? report?.before.observedExpectedControlOrderCount
      ?? 0,
    orphanCancelsSucceeded: report?.actions.orphanCancelsSucceeded ?? 0,
    blockedReason: report?.actions.blockedReason ?? failure,
    reportPath,
  }))
  if (!payload.success) process.exitCode = 1
}

void main().catch((error) => {
  console.error(sanitizedFailure(error))
  process.exitCode = 1
})

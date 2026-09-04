#!/usr/bin/env node

import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  assertAllowedVerifierRequest,
  assertExactX02LifecycleAuthorization,
  PROD_VST_ORIGINS,
  X02_LIFECYCLE_CONFIRMATION,
} from "@/lib/orchestrated-verifier-safety"
import { getRuntimeMaintenanceState } from "@/lib/runtime-maintenance"

const ORIGIN = String(process.env.BINGX_VST_VERIFY_ORIGIN || "https://open-api-vst.bingx.com").replace(/\/$/, "")
const APP = String(process.env.BINGX_VST_VERIFY_APP_URL || "http://127.0.0.1:3000").replace(/\/$/, "")
const OUT = join(process.cwd(), ".agent-logs")
const INDICATIONS = ["direction", "move", "active", "active_advanced", "special", "optimal", "auto", "common", "signal", "trend"]
const STRATEGIES = ["base", "main", "real", "live", "dca", "block"]
const PAGES = ["/", "/active-exchange", "/indications", "/sets", "/strategies", "/main", "/main/realtime", "/live-trading", "/statistics", "/statistics/direct-trade", "/statistics/indications/common", "/statistics/indications/main", "/statistics/indications/signal", "/monitoring", "/monitoring-advanced", "/settings", "/settings/connections"]
const MAX_CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.BINGX_VST_VERIFY_CONCURRENCY || 4)))
const report: any = { schemaVersion: 1, runId: randomUUID(), startedAt: new Date().toISOString(), success: false, phases: {}, violations: [] }

const fail = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
const normalize = (value: unknown) => String(value ?? "").trim().toUpperCase().replace(/[-/_:]/g, "")
const finiteTree = (value: unknown, path = "statistics") => {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`Non-finite ${path}`)
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) finiteTree(child, `${path}.${key}`)
}
async function json(url: string, init?: RequestInit) {
  assertAllowedVerifierRequest(url, Boolean(init?.headers && new Headers(init.headers).has("X-BX-APIKEY")))
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000), cache: "no-store" })
  if (!response.ok) throw new Error(`${new URL(url).pathname} returned HTTP ${response.status}`)
  return response.json()
}

async function discoverInventory() {
  fail(PROD_VST_ORIGINS.has(ORIGIN), "Inventory discovery requires an exact Prod-VST origin")
  const payload: any = await json(`${ORIGIN}/openApi/swap/v2/quote/contracts`)
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.data?.contracts) ? payload.data.contracts : []
  const symbols: string[] = [...new Set<string>(rows.map((row: any) => normalize(row?.symbol)).filter(Boolean))].sort()
  fail(symbols.length > 0, "Authoritative BingX Prod-VST inventory is empty")
  fail(symbols.length === rows.filter((row: any) => normalize(row?.symbol)).length, "Inventory contains duplicate normalized symbols")
  return { discoveredAt: new Date().toISOString(), endpoint: "/openApi/swap/v2/quote/contracts", exactCount: symbols.length, normalizedUniqueSymbols: symbols }
}

async function computation(symbols: string[]) {
  // Reuse the production soak's full pipeline and its memory, Redis, event,
  // generation, progression, relationship and coordinator assertions. Passing
  // the discovered inventory explicitly prevents its fallback basket from
  // becoming an accidental authority.
  let maxLagMs = 0, tick = Date.now(), running = true
  const timer = setInterval(() => { const now = Date.now(); maxLagMs = Math.max(maxLagMs, now - tick - 25); tick = now }, 25)
  try {
    const env = { ...process.env, BASE_URL: APP, SOAK_CONNECTION_ID: "bingx-x02", SOAK_SYMBOLS: symbols.join(","), SYMBOL_COUNT: String(symbols.length), START_SIMULATED_ENGINE: "1", FORCE_SIMULATED: "1", FORCE_LIVE: "0", ALLOW_LIVE_ORDER_PLACEMENT: "0", SOAK_MAX_CONCURRENCY: String(MAX_CONCURRENCY) }
    const code = await new Promise<number>((resolve, reject) => { const child = spawn(process.execPath, ["scripts/verify-prod-soak.mjs"], { cwd: process.cwd(), env, stdio: "inherit" }); child.once("error", reject); child.once("exit", value => resolve(value ?? 1)) })
    fail(code === 0, `Exhaustive simulated production soak failed (${code})`)
    running = false; clearInterval(timer)
    const stats: any = await json(`${APP}/api/connections/progression/bingx-x02/stats?t=${Date.now()}`)
    finiteTree(stats)
    fail(maxLagMs <= Number(process.env.BINGX_VST_VERIFY_MAX_EVENT_LOOP_LAG_MS || 1_000), `Event-loop lag unbounded: ${maxLagMs}ms`)
    return { exchangeSubmissionDisabled: true, exactSymbolCount: symbols.length, normalizedUniqueSymbols: symbols, requiredIndicationLanes: INDICATIONS, requiredStrategyLanes: STRATEGIES, boundedConcurrency: MAX_CONCURRENCY, maxEventLoopLagMs: maxLagMs, productionSoakPassed: true }
  } finally { if (running) clearInterval(timer) }
}

async function browserUi() {
  let chromium: any
  try { ({ chromium } = await (Function("return import('playwright')")() as Promise<any>)) } catch { throw new Error("Browser assertions require Playwright (provide it in the approved verifier environment)") }
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage()
  const unexpected: string[] = []
  page.on("request", (request: any) => { try { assertAllowedVerifierRequest(request.url(), false) } catch (error) { unexpected.push(String(error)); request.abort?.() } })
  try {
    for (const path of PAGES) { const response = await page.goto(`${APP}${path}`, { waitUntil: "domcontentloaded" }); fail(response?.ok(), `UI page failed: ${path}`); await page.locator("body").waitFor({ state: "visible" }) }
    await page.goto(`${APP}/settings/connections`)
    for (const name of [/add connection/i, /edit/i, /overview/i]) { const control = page.getByRole("button", { name }).first(); fail(await control.count(), `Missing connection dialog/control ${name}`); await control.click(); await page.keyboard.press("Escape") }
    await page.goto(`${APP}/main`)
    for (const action of ["start", "pause", "resume", "restart", "stop"]) { const button = page.getByRole("button", { name: new RegExp(action, "i") }).first(); fail(await button.count(), `Missing ${action} action`); await button.click(); await page.waitForTimeout(250) }
    await page.goto(`${APP}/statistics`); fail(await page.getByText(/statistics/i).count(), "Statistics panel missing")
    await page.goto(`${APP}/monitoring`); fail(await page.getByText(/log/i).count(), "Logs panel missing")
    const transport = await page.evaluate(async () => {
      const sse = await fetch(`/api/ws?connectionId=bingx-x02`, { signal: AbortSignal.timeout(4_000) }).then(r => r.ok).catch(() => false)
      const poll = await fetch(`/api/connections/progression/bingx-x02/stats?t=${Date.now()}`).then(r => r.ok)
      return { sse, poll }
    })
    fail(transport.poll, "Poll fallback failed"); fail(unexpected.length === 0, unexpected.join("; "))
    return { pages: PAGES, browserLevelAssertions: true, transport }
  } finally { await browser.close() }
}

async function authenticatedLifecycle() {
  if (process.env.BINGX_VST_VERIFY_AUTHENTICATED !== "1") return { skipped: true, reason: "authenticated phase requires separate explicit approval" }
  const maintenance = getRuntimeMaintenanceState()
  const inactive = process.env.BINGX_VST_VERIFY_SERVICES_INACTIVE === "1"
  assertExactX02LifecycleAuthorization({ connectionId: process.env.BINGX_VST_VERIFY_CONNECTION_ID, exchange: process.env.BINGX_VST_VERIFY_EXCHANGE, environment: process.env.BINGX_VST_VERIFY_ENVIRONMENT, origin: ORIGIN, confirmation: process.env.BINGX_VST_VERIFY_CONFIRM, maintenanceMarker: maintenance.reason === "marker_present", tradingServicesInactive: inactive })
  // The mature lifecycle runner owns baseline snapshots, minimum virtual sizing, prefixes, cleanup and exact restoration.
  const env = { ...process.env, BINGX_VST_SOAK_ORIGIN: ORIGIN, BINGX_VST_SOAK_CONFIRM: "I understand Prod-VST places authenticated orders with virtual funds" }
  const code = await new Promise<number>((resolve, reject) => { const child = spawn(process.execPath, ["--import", "tsx", "scripts/run-bingx-vst-live-soak.ts"], { cwd: process.cwd(), env, stdio: "inherit" }); child.once("error", reject); child.once("exit", value => resolve(value ?? 1)) })
  fail(code === 0, `Authenticated lifecycle runner failed (${code}); inspect its owner-only artifact`)
  return { skipped: false, runner: "scripts/run-bingx-vst-live-soak.ts", representativeMatrixOnly: true, baselineRestorationRequired: true }
}

async function main() {
  await mkdir(OUT, { recursive: true, mode: 0o700 }); const path = join(OUT, `bingx-vst-orchestrated-${report.runId}.json`)
  try { const inventory = await discoverInventory(); report.inventory = inventory; report.phases.computation = await computation(inventory.normalizedUniqueSymbols); report.phases.ui = await browserUi(); report.phases.authenticatedLifecycle = await authenticatedLifecycle(); report.success = true }
  catch (error) { report.violations.push(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  finally { report.finishedAt = new Date().toISOString(); await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); console.log(`[orchestrated-verifier] ${report.success ? "PASS" : "FAIL"} artifact=${path}`) }
}
void main()

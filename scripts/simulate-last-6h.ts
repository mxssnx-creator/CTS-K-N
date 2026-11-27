#!/usr/bin/env node
/**
 * Last-6-hour trade simulation: the 6 h pre-calculation and 6 h trading window
 * of scripts/simulate-trade-window.ts, with 1-hour buckets. Kept as a stable
 * entry point; the implementation (worker-parallel replay, linear ledger) lives
 * in simulate-trade-window.ts.
 *
 *   SIM_OUT_DIR=<dir> [SIM_SYMBOLS=...] node scripts/simulate-last-6h.ts
 */
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

const here = resolve(process.argv[1]).replace(/simulate-last-6h\.ts$/, "")
const env = {
  ...process.env,
  SIM_TRADE_HOURS: "6",
  SIM_PREHIST_HOURS: "6",
  SIM_BUCKET_HOURS: "1",
  SIM_OUT_DIR: process.env.SIM_OUT_DIR || "reports/last-6h",
}
const run = spawnSync(process.execPath, ["--import", "tsx", resolve(here, "simulate-trade-window.ts")], { env, stdio: "inherit" })
if (run.status !== 0) process.exit(run.status ?? 1)
const render = spawnSync(process.execPath, [resolve(here, "render-trade-window-report.mjs"), env.SIM_OUT_DIR], { stdio: "inherit" })
process.exit(render.status ?? 0)

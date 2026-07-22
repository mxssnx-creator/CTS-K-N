#!/usr/bin/env node

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import process from "node:process"

const kiloManagedMigration =
  process.env.KILO_DEPLOYMENT === "1" ||
  process.env.CTS_DEPLOYMENT_RUNTIME === "kilo-deploy" ||
  process.env.RUN_MANAGED_DB_MIGRATIONS === "1"

// Vercel can invoke the repository's db:migrate script as part of a generic
// build integration, but it does not use Kilo's HTTP-SQLite contract. Exit
// before resolving tsx so production-only installs cannot fail on a dev-only
// executable that this deployment does not need.
if (!kiloManagedMigration) {
  console.info("[db:migrate] Skipped: this deployment does not use Kilo managed SQLite.")
  process.exit(0)
}

const executable = process.platform === "win32" ? "tsx.cmd" : "tsx"
const tsx = path.join(process.cwd(), "node_modules", ".bin", executable)
if (!existsSync(tsx)) {
  console.error("[db:migrate] Kilo managed migration requested, but tsx is not installed.")
  process.exit(1)
}

const child = spawn(tsx, ["src/db/migrate.ts"], { stdio: "inherit" })
child.once("error", (error) => {
  console.error("[db:migrate] Failed to launch tsx", error)
  process.exitCode = 1
})
child.once("exit", (code, signal) => {
  process.exitCode = signal || code !== 0 ? 1 : 0
})

#!/usr/bin/env node

/**
 * Fail-closed Kilo/OpenNext deployment owner.
 *
 * The command validates local runtime/deploy inputs, builds the OpenNext
 * Worker, uploads only an explicit allowlist of application bindings alongside
 * the Worker, initializes schema v82, and runs the production contract. No
 * Cloudflare credential is ever copied into the Worker environment.
 */

import { spawn } from "node:child_process"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"

const root = process.cwd()
const binSuffix = process.platform === "win32" ? ".cmd" : ""
const openNext = path.join(root, "node_modules", ".bin", `opennextjs-cloudflare${binSuffix}`)

// Only values intentionally consumed by CTS-K-N may cross the deployment
// boundary. In particular CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are
// controller credentials and are deliberately absent.
const WORKER_BINDING_ALLOWLIST = [
  "ADMIN_SECRET",
  "CRON_SECRET",
  "ENCRYPTION_KEY",
  "JWT_SECRET",
  "REDIS_URL",
  "KV_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "DB_URL",
  "DB_TOKEN",
  "ALLOW_KILO_SQLITE_LIVE_TRADING",
  "NEXT_PUBLIC_APP_URL",
  "DEPLOYMENT_URL",
  "NEXTAUTH_URL",
  "REMOTE_INSTALL_OWNER_URL",
  "REMOTE_INSTALL_OWNER_SECRET",
  "BINGX_API_KEY",
  "BINGX_API_SECRET",
  "BINGX_PUBLIC_ORIGIN",
  "BINGX_PUBLIC_FALLBACK_ORIGIN",
  "BYBIT_API_KEY",
  "BYBIT_API_SECRET",
  "PIONEX_API_KEY",
  "PIONEX_API_SECRET",
  "ORANGEX_API_KEY",
  "ORANGEX_API_SECRET",
]

function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...extraEnv },
      stdio: "inherit",
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${path.basename(command)} terminated by ${signal}`))
      else if (code === 0) resolve()
      else reject(new Error(`${path.basename(command)} exited with status ${code ?? "unknown"}`))
    })
  })
}

function workerBindings() {
  return Object.fromEntries(
    WORKER_BINDING_ALLOWLIST
      .filter((name) => typeof process.env[name] === "string" && process.env[name].length > 0)
      .map((name) => [name, process.env[name]]),
  )
}

async function main() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "cts-kilo-deploy-"))
  const secretsFile = path.join(tempRoot, "worker-bindings.json")
  try {
    await run(process.execPath, ["scripts/kilo-deploy-preflight.mjs"], {
      KILO_REQUIRE_RUNTIME_ENV: "1",
      KILO_REQUIRE_DEPLOY_CREDENTIALS: "1",
      KILO_REQUIRE_REMOTE_INSTALL_OWNER: "1",
    })

    const bindings = workerBindings()
    await writeFile(secretsFile, `${JSON.stringify(bindings)}\n`, { mode: 0o600 })
    await chmod(secretsFile, 0o600)

    await run(process.execPath, ["scripts/clean-opennext-output.mjs"])
    await run(openNext, ["build"])
    // OpenNext officially forwards unrecognised deploy flags to Wrangler. The
    // secrets file therefore ships atomically with the new Worker version and
    // existing secrets not listed here remain intact.
    await run(openNext, ["deploy", "--secrets-file", secretsFile])

    const deploymentUrl = process.env.DEPLOYMENT_URL || process.env.NEXT_PUBLIC_APP_URL
    await run(process.execPath, ["scripts/production-deploy-init.mjs"], { DEPLOYMENT_URL: deploymentUrl })
    await run("bash", ["scripts/post-deploy-verify.sh"], {
      DEPLOYMENT_URL: deploymentUrl,
      CTS_DEPLOYMENT_RUNTIME: "kilo-deploy",
      DEPLOYMENT_CRON_MODE: "cloudflare-scheduled",
      REQUIRE_SHARED_PERSISTENCE: "1",
      REQUIRE_FRESH_CONTINUITY: "1",
    })
    console.log("[Kilo Deploy] READY: build, deploy, schema, scheduler, persistence, and runtime verification passed")
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`[Kilo Deploy] FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})

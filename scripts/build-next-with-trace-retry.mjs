#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { join, relative } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { tmpdir } from "node:os"

const distDir = process.env.NEXT_DIST_DIR || ".next"
const maxAttempts = Math.max(1, Number(process.env.NEXT_TRACE_BUILD_ATTEMPTS || 4))
const minimumTraceCount = 300
const settleAfterFailureMs = Math.max(0, Number(process.env.NEXT_TRACE_SETTLE_MS || 8000))
const isVercelBuild = process.env.VERCEL === "1" || process.env.VERCEL === "true"
const requiresStandalone = !isVercelBuild
const settleAfterSuccessMs = Math.max(
  0,
  Number(process.env.NEXT_TRACE_SUCCESS_SETTLE_MS || (requiresStandalone ? 8000 : 1500)),
)
const sleepArray = new Int32Array(new SharedArrayBuffer(4))

function sleep(milliseconds) {
  if (milliseconds > 0) Atomics.wait(sleepArray, 0, 0, milliseconds)
}

function runBuild(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout = []
    const stderr = []
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)))
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)))
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({
      pid: child.pid,
      signal,
      status: code ?? 1,
      stderr,
      stdout,
    }))
  })
}

function signalProcessGroup(pid, signal) {
  if (!pid || process.platform === "win32") return false
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if (error?.code === "ESRCH") return false
    throw error
  }
}

function stopLateBuildWriters(pid) {
  if (!signalProcessGroup(pid, "SIGTERM")) return
  sleep(300)
  signalProcessGroup(pid, "SIGKILL")
  sleep(100)
}

function getTrackedSourceState() {
  const listed = spawnSync("git", ["ls-files", "-z"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  if (listed.status !== 0) throw new Error("could not enumerate tracked source files before build")

  const conflicts = []
  const hash = createHash("sha256")
  for (const file of listed.stdout.split("\0").filter(Boolean).sort()) {
    // Next intentionally normalizes these two files for custom dist dirs.
    if (file === "next-env.d.ts" || file === "tsconfig.json" || !existsSync(file)) continue
    const metadata = lstatSync(file)
    if (metadata.isDirectory()) continue
    const contents = metadata.isSymbolicLink()
      ? Buffer.from(readlinkSync(file))
      : readFileSync(file)
    hash.update(file).update("\0").update(contents).update("\0")
    if (/^(?:<<<<<<<|=======|>>>>>>>)(?: .*)?$/m.test(contents.toString("utf8"))) conflicts.push(file)
  }
  return { fingerprint: hash.digest("hex"), conflicts }
}

function isRecoverableNextFilesystemRace(output) {
  const providerPath = /(?:ENOENT|ENOTEMPTY):[\s\S]{0,800}(?:\.next|pages-manifest|nft\.json|routes-manifest|prerender-manifest|\/export)/i
  const sourceFailure = /Failed to compile|webpack errors|Merge conflict marker|Syntax Error|Type error/i
  return providerPath.test(output) && !sourceFailure.test(output)
}

function collectFiles(root, suffix) {
  if (!existsSync(root)) return []
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = join(root, entry.name)
    if (entry.isDirectory()) files.push(...collectFiles(entryPath, suffix))
    else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(entryPath)
  }
  return files
}

function parseJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function validateBuild() {
  const failures = []
  const providerManifests = [
    "routes-manifest.json",
    "prerender-manifest.json",
    "required-server-files.json",
    "server/pages-manifest.json",
    "server/app-paths-manifest.json",
  ]
  if (requiresStandalone) {
    providerManifests.push(
      "standalone/.next/routes-manifest.json",
      "standalone/.next/prerender-manifest.json",
      "standalone/.next/required-server-files.json",
      "standalone/.next/server/pages-manifest.json",
      "standalone/.next/server/app-paths-manifest.json",
    )
  }
  for (const manifest of providerManifests) {
    const path = join(distDir, manifest)
    if (!parseJson(path)) failures.push(`${manifest}: missing or invalid JSON`)
  }

  const traceRoot = join(distDir, "server")
  const traces = collectFiles(traceRoot, ".nft.json")
  if (traces.length < minimumTraceCount) {
    failures.push(`only ${traces.length} trace files were emitted (expected at least ${minimumTraceCount})`)
  }
  for (const trace of traces) {
    const parsed = parseJson(trace)
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.files) || parsed.files.length === 0) {
      failures.push(`${relative(distDir, trace)}: incomplete Next trace`)
    }
  }

  const routeBundles = collectFiles(join(distDir, "server", "app"), "route.js")
  for (const route of routeBundles) {
    if (!existsSync(`${route}.nft.json`)) {
      failures.push(`${relative(distDir, route)}: trace file is missing`)
    }
  }
  return failures
}

function normalizeProviderOutput() {
  const result = spawnSync(
    process.execPath,
    ["scripts/normalize-next-env.mjs"],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    },
  )
  if (result.error) throw result.error
  return result.status === 0
}

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  console.log(`[next-trace-build] attempt ${attempt}/${maxAttempts}`)
  const sourceBefore = getTrackedSourceState()
  if (sourceBefore.conflicts.length > 0) {
    console.error(`[next-trace-build] refusing to build tracked merge markers: ${sourceBefore.conflicts.join(", ")}`)
    process.exit(1)
  }
  const inheritedPnpm = process.env.npm_execpath && existsSync(process.env.npm_execpath)
    ? process.env.npm_execpath
    : null
  const command = inheritedPnpm ? process.execPath : "corepack"
  const args = inheritedPnpm
    ? [inheritedPnpm, "run", "build"]
    : ["pnpm@10.28.1", "run", "build"]
  const result = await runBuild(
    command,
    args,
    {
      ...process.env,
      COREPACK_HOME: process.env.COREPACK_HOME || join(tmpdir(), "cts-corepack-cache"),
    },
  )

  let buildOutput = `${Buffer.concat(result.stdout).toString("utf8")}\n${Buffer.concat(result.stderr).toString("utf8")}`
  const recoverableFilesystemRace = result.status !== 0 && isRecoverableNextFilesystemRace(buildOutput)

  // A successful Next parent can still leave output-tracing children writing
  // into `.next` after the lifecycle exits. Give them a provider-bounded
  // completion window, then terminate the isolated build process group before
  // validating or handing the directory to Vercel/OpenNext packaging.
  const writerSettleMs = result.status === 0 ? settleAfterSuccessMs : settleAfterFailureMs
  if (writerSettleMs > 0) sleep(writerSettleMs)
  stopLateBuildWriters(result.pid)

  buildOutput = `${Buffer.concat(result.stdout).toString("utf8")}\n${Buffer.concat(result.stderr).toString("utf8")}`
  if (result.stdout.length > 0) process.stdout.write(Buffer.concat(result.stdout))
  if (result.stderr.length > 0) process.stderr.write(Buffer.concat(result.stderr))

  const sourceAfter = getTrackedSourceState()
  if (sourceBefore.fingerprint !== sourceAfter.fingerprint || sourceAfter.conflicts.length > 0) {
    console.error("[next-trace-build] tracked source changed while Next was compiling; refusing a mixed-revision artifact")
    process.exit(1)
  }

  // Next 15 can report a late ENOENT/ENOTEMPTY while one of its tracing
  // workers is still flushing the same build. Accept a non-zero lifecycle only
  // when the error has that exact signature and all build-owned artifacts prove
  // complete below.
  if (result.status !== 0) {
    if (!recoverableFilesystemRace) {
      console.error(`[next-trace-build] non-recoverable Next build failure (${result.status})`)
      process.exit(result.status || 1)
    }
    console.warn(`[next-trace-build] Next build exited ${result.status}; late writer group settled for ${writerSettleMs}ms`)
  }

  const normalized = normalizeProviderOutput()

  const failures = validateBuild()
  if (normalized && failures.length === 0) {
    if (result.status !== 0) {
      console.warn("[next-trace-build] recovered a complete artifact after a late Next filesystem race")
    }
    console.log(`[next-trace-build] validated ${collectFiles(join(distDir, "server"), ".nft.json").length} complete trace files`)
    process.exit(0)
  }
  if (!normalized) failures.unshift("provider manifest normalization failed")
  console.warn(`[next-trace-build] incomplete provider output:\n- ${failures.slice(0, 30).join("\n- ")}`)
  if (attempt === maxAttempts) {
    console.error(`[next-trace-build] failed after ${maxAttempts} attempts`)
    process.exit(1)
  }
}

#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { basename, join, relative } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { isRecoverableNextFilesystemRace } from "./next-build-race-classifier.mjs"

const distDir = process.env.NEXT_DIST_DIR || ".next"
const maxAttempts = Math.max(1, Number(process.env.NEXT_TRACE_BUILD_ATTEMPTS || 4))
const minimumTraceCount = 300
const settleAfterFailureMs = Math.max(0, Number(process.env.NEXT_TRACE_SETTLE_MS || 8000))
const isVercelBuild = process.env.VERCEL === "1" || process.env.VERCEL === "true"
const requiresStandalone = !isVercelBuild
const standaloneDistName = basename(distDir)
const settleAfterSuccessMs = Math.max(
  0,
  Number(process.env.NEXT_TRACE_SUCCESS_SETTLE_MS || (requiresStandalone ? 8000 : 1500)),
)
const settleAfterChildExitMs = Math.max(
  0,
  Number(process.env.NEXT_TRACE_CHILD_SETTLE_MS || (requiresStandalone ? 15000 : 1500)),
)
const sleepArray = new Int32Array(new SharedArrayBuffer(4))

function sleep(milliseconds) {
  if (milliseconds > 0) Atomics.wait(sleepArray, 0, 0, milliseconds)
}

function runBuild(command, args, env) {
  const timeoutMs = Math.max(0, Number(process.env.NEXT_TRACE_BUILD_TIMEOUT_MS || 0))
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let timedOut = false
    const timeout = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          signalProcessGroup(child.pid, "SIGTERM")
          setTimeout(() => signalProcessGroup(child.pid, "SIGKILL"), 1500).unref()
        }, timeoutMs)
      : null
    const stdout = []
    const stderr = []
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)))
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)))
    child.once("error", error => {
      if (timeout) clearTimeout(timeout)
      reject(error)
    })
    child.once("exit", (code, signal) => {
      if (timeout) clearTimeout(timeout)
      resolve({
        pid: child.pid,
        signal,
        timedOut,
        status: timedOut ? 124 : (code ?? 1),
        stderr,
        stdout,
      })
    })
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

function processGroupIsAlive(pid) {
  if (!pid || process.platform === "win32") return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (error?.code === "ESRCH") return false
    if (error?.code === "EPERM") return true
    throw error
  }
}

function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (processGroupIsAlive(pid) && Date.now() < deadline) {
    sleep(250)
  }
  return !processGroupIsAlive(pid)
}

function stopLateBuildWriters(pid) {
  if (!signalProcessGroup(pid, "SIGTERM")) return
  sleep(300)
  signalProcessGroup(pid, "SIGKILL")
  sleep(100)
}

const archiveSourceExcludedDirectories = new Set([
  ".git",
  "node_modules",
  "coverage",
  "dist",
  "build",
  "out",
  ".cts-runtime",
  ".v0-data",
  "validation-results",
  "data",
  "logs",
])

function isRuntimeEnvironmentFile(file) {
  const name = basename(file)
  return name === ".env"
    || (name.startsWith(".env.") && name !== ".env.example")
    || name === ".dev.vars"
}

function listArchiveSourceFiles(directory = process.cwd(), prefix = "") {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      archiveSourceExcludedDirectories.has(entry.name)
      || entry.name === ".next"
      || entry.name.startsWith(".next-")
    ) continue
    const file = prefix ? `${prefix}/${entry.name}` : entry.name
    if (isRuntimeEnvironmentFile(file)) continue
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listArchiveSourceFiles(absolute, file))
    else files.push(file)
  }
  return files
}

function getTrackedSourceState() {
  const listed = spawnSync("git", ["ls-files", "-z"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  // Sanitized Drive/release archives intentionally omit `.git`. Preserve the
  // mixed-revision/merge-marker guard by fingerprinting the extracted source
  // tree with the same build, dependency, runtime-state and credential
  // exclusions instead of disabling the guard or refusing a valid recovery.
  const sourceFiles = listed.status === 0
    ? listed.stdout.split("\0").filter(Boolean)
    : listArchiveSourceFiles()

  const conflicts = []
  const hash = createHash("sha256")
  const files = new Map()
  for (const file of sourceFiles.sort()) {
    // Next intentionally normalizes these two files for custom dist dirs.
    if (file === "next-env.d.ts" || file === "tsconfig.json" || !existsSync(file)) continue
    const metadata = lstatSync(file)
    if (metadata.isDirectory()) continue
    const contents = metadata.isSymbolicLink()
      ? Buffer.from(readlinkSync(file))
      : readFileSync(file)
    hash.update(file).update("\0").update(contents).update("\0")
    files.set(file, createHash("sha256").update(contents).digest("hex"))
    if (/^(?:<<<<<<<|=======|>>>>>>>)(?: .*)?$/m.test(contents.toString("utf8"))) conflicts.push(file)
  }
  return { fingerprint: hash.digest("hex"), conflicts, files }
}

function trackedSourceDrift(before, after) {
  const names = new Set([...before.files.keys(), ...after.files.keys()])
  return [...names]
    .filter((file) => before.files.get(file) !== after.files.get(file))
    .sort()
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
      `standalone/${standaloneDistName}/routes-manifest.json`,
      `standalone/${standaloneDistName}/prerender-manifest.json`,
      `standalone/${standaloneDistName}/required-server-files.json`,
      `standalone/${standaloneDistName}/server/pages-manifest.json`,
      `standalone/${standaloneDistName}/server/app-paths-manifest.json`,
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

function prepareStandaloneAssets() {
  // This wrapper invokes `build:next` directly so it can retry only the
  // provider build race. That intentionally bypasses npm's `postbuild` hook;
  // run the same standalone finalizer explicitly so a validated artifact is
  // also runnable by `node standalone/server.js` outside a provider.
  const result = spawnSync(
    process.execPath,
    ["scripts/prepare-standalone-assets.mjs"],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    },
  )
  if (result.error) throw result.error
  return result.status === 0
}

function cleanBuildOutput() {
  // A failed Next trace can leave an export subtree behind while the child
  // process is still unwinding. Always rebuild the explicit .next* target
  // from a clean boundary so retry #2 cannot inherit a mixed artifact.
  const result = spawnSync(
    process.execPath,
    ["scripts/clean-next-dist.mjs"],
    { cwd: process.cwd(), env: process.env, stdio: "inherit" },
  )
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`could not clean ${distDir} before build attempt`)
}

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  console.log(`[next-trace-build] attempt ${attempt}/${maxAttempts}`)
  cleanBuildOutput()
  const sourceBefore = getTrackedSourceState()
  if (sourceBefore.conflicts.length > 0) {
    console.error(`[next-trace-build] refusing to build tracked merge markers: ${sourceBefore.conflicts.join(", ")}`)
    process.exit(1)
  }
  // Keep the provider's pinned Corepack invocation as the single build
  // contract. `build:next` already points at Next's executable, while this
  // wrapper owns the clean boundary, retry, child-group settlement, and final
  // trace validation around it.
  //
  // Some local/CI runtimes (e.g. bun-managed sandboxes) ship `pnpm` directly
  // but omit `corepack`. Fall back to the locally-installed `pnpm` when
  // Corepack is not resolvable so the production build still succeeds here,
  // while Vercel and other Corepack-enabled providers keep the pinned
  // `pnpm@10.28.1` contract unchanged.
  function resolveBuildCommand() {
    // A fully installed Linux node may deliberately run without outbound
    // package-registry access.  In that case Corepack must not try to resolve
    // pnpm again: execute the already installed, lockfile-produced Next
    // binary while retaining this wrapper's source-drift, trace and
    // standalone validation.  The opt-in flag keeps CI/Vercel on the pinned
    // Corepack path by default.
    if (process.env.CTS_USE_LOCAL_NEXT_BUILD === "1") {
      return {
        command: process.execPath,
        args: ["node_modules/next/dist/bin/next", "build"],
      }
    }
    if (process.env.COREPACK_BIN) {
      return { command: process.env.COREPACK_BIN, args: ["pnpm@10.28.1", "run", "build:next"] }
    }
    const corepackProbe = spawnSync("corepack", ["--version"], { stdio: "ignore" })
    if (corepackProbe.error?.code !== "ENOENT") {
      return { command: "corepack", args: ["pnpm@10.28.1", "run", "build:next"] }
    }
    return { command: "pnpm", args: ["run", "build:next"] }
  }
  const { command, args } = resolveBuildCommand()
  const result = await runBuild(
    command,
    args,
    {
      ...process.env,
      NODE_OPTIONS: process.env.NODE_OPTIONS ||
        `--max-old-space-size=${process.env.CTS_NODE_HEAP_MB || "5632"} --max-semi-space-size=256 --expose-gc`,
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
  if (!waitForProcessGroupExit(result.pid, settleAfterChildExitMs)) {
    console.warn(`[next-trace-build] late writer group remained after ${writerSettleMs + settleAfterChildExitMs}ms; terminating it before validation`)
    stopLateBuildWriters(result.pid)
    waitForProcessGroupExit(result.pid, 3000)
  }

  buildOutput = `${Buffer.concat(result.stdout).toString("utf8")}\n${Buffer.concat(result.stderr).toString("utf8")}`
  if (result.stdout.length > 0) process.stdout.write(Buffer.concat(result.stdout))
  if (result.stderr.length > 0) process.stderr.write(Buffer.concat(result.stderr))

  const sourceAfter = getTrackedSourceState()
  if (sourceBefore.fingerprint !== sourceAfter.fingerprint || sourceAfter.conflicts.length > 0) {
    const drift = trackedSourceDrift(sourceBefore, sourceAfter)
    const detail = drift.length > 0 ? `: ${drift.slice(0, 20).join(", ")}` : ""
    // Never validate an artifact assembled from two source revisions. A local
    // editor, formatter, or generated configuration can legitimately finish
    // while a long standalone trace build is running, so discard this output
    // and retry from a fresh source fingerprint. The final attempt still
    // fails closed if the tree cannot settle.
    console.warn(`[next-trace-build] tracked source changed while Next was compiling; discarding the mixed-revision artifact${detail}`)
    if (attempt === maxAttempts) {
      console.error(`[next-trace-build] source did not stay stable after ${maxAttempts} attempts`)
      process.exit(1)
    }
    continue
  }

  // Next 15 can report a late ENOENT/ENOTEMPTY while one of its tracing
  // workers is still flushing the same build. Accept a non-zero lifecycle only
  // when the error has that exact signature and all build-owned artifacts prove
  // complete below.
  if (result.status !== 0) {
    if (result.timedOut) {
      console.error(`[next-trace-build] timed out after ${process.env.NEXT_TRACE_BUILD_TIMEOUT_MS}ms`)
      process.exit(124)
    }
    if (!recoverableFilesystemRace) {
      console.error(`[next-trace-build] non-recoverable Next build failure (${result.status})`)
      process.exit(result.status || 1)
    }
    console.warn(`[next-trace-build] Next build exited ${result.status}; late writer group settled for ${writerSettleMs}ms`)
  }

  const normalized = normalizeProviderOutput()
  const standaloneAssetsPrepared = normalized && prepareStandaloneAssets()

  const failures = validateBuild()
  if (normalized && standaloneAssetsPrepared && failures.length === 0) {
    if (result.status !== 0) {
      console.warn("[next-trace-build] recovered a complete artifact after a late Next filesystem race")
    }
    console.log(`[next-trace-build] validated ${collectFiles(join(distDir, "server"), ".nft.json").length} complete trace files`)
    process.exit(0)
  }
  if (!normalized) failures.unshift("provider manifest normalization failed")
  if (!standaloneAssetsPrepared) failures.unshift("standalone asset preparation failed")
  console.warn(`[next-trace-build] incomplete provider output:\n- ${failures.slice(0, 30).join("\n- ")}`)
  if (attempt === maxAttempts) {
    console.error(`[next-trace-build] failed after ${maxAttempts} attempts`)
    process.exit(1)
  }
}

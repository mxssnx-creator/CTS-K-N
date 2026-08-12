#!/usr/bin/env node

/**
 * Shared Redis lifecycle for development and production preview harnesses.
 *
 * Next.js evaluates route handlers in multiple operating-system workers. An
 * InlineLocalRedis instance is process-local, so it cannot prove coordinator,
 * migration, or Base -> Main -> Real -> Live ownership across those workers.
 * Full preview soaks therefore use either an explicitly configured shared
 * Redis endpoint or an isolated redis-server child owned by the harness.
 */
import { spawn, spawnSync } from "node:child_process"
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { createClient } from "redis"

const serviceScript = fileURLToPath(new URL("./npm-redis-service.mjs", import.meta.url))

function hasConfiguredSharedRedis() {
  return Boolean(
    process.env.REDIS_URL ||
      process.env.KV_URL ||
      (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) ||
      (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN),
  )
}

async function verifyRedisUrl(url) {
  const client = createClient({
    url,
    socket: { connectTimeout: 2_000, reconnectStrategy: false },
  })
  client.on("error", () => {})
  const token = `cts-preview-${process.pid}-${Date.now()}`
  try {
    await client.connect()
    if (await client.ping() !== "PONG") throw new Error("PING did not return PONG")
    await client.set(token, "ok", { EX: 30 })
    if (await client.get(token) !== "ok") throw new Error("read/write probe did not round-trip")
    await client.del(token)
  } finally {
    if (client.isOpen) await client.quit().catch(() => client.disconnect())
  }
}

function resolveRedisServerBinary() {
  const explicit = String(process.env.CTS_REDIS_SERVER_BIN || "").trim()
  if (explicit) {
    try {
      accessSync(explicit, constants.X_OK)
    } catch {
      throw new Error(`CTS_REDIS_SERVER_BIN is not executable: ${explicit}`)
    }
    return explicit
  }
  const probe = spawnSync("redis-server", ["--version"], { stdio: "ignore" })
  return probe.status === 0 ? "redis-server" : ""
}

async function reserveLoopbackPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  if (!port) throw new Error("Could not reserve a loopback port for preview Redis")
  return port
}

async function waitForRedis(child, url, label) {
  const timeoutMs = Math.max(5_000, Number(process.env.CTS_PREVIEW_REDIS_START_TIMEOUT_MS || 600_000))
  const deadline = Date.now() + timeoutMs
  let lastError = "not ready"
  while (Date.now() < deadline) {
    if (child.exitCode != null || child.signalCode != null) {
      throw new Error(`${label} Redis exited before readiness (code=${child.exitCode ?? "none"}, signal=${child.signalCode || "none"})`)
    }
    try {
      await verifyRedisUrl(url)
      return
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`${label} Redis did not become ready: ${lastError}`)
}

async function stopOwnedRedis(child, runtimeDir) {
  if (child?.pid && child.exitCode == null && child.signalCode == null) {
    child.kill("SIGTERM")
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ])
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL")
  }
  rmSync(runtimeDir, { recursive: true, force: true })
}

export async function startPreviewRedisHarness({ required = false, label = "preview" } = {}) {
  if (hasConfiguredSharedRedis()) {
    if (process.env.REDIS_URL) await verifyRedisUrl(process.env.REDIS_URL)
    return {
      kind: "configured-shared",
      environment: { ALLOW_PROD_INLINE_REDIS: "0" },
      stop: async () => {},
    }
  }

  const binary = resolveRedisServerBinary()
  const npmRoot = String(process.env.CTS_NPM_REDIS_ROOT || "").trim()
  if (!binary && !npmRoot) {
    if (!required) {
      return { kind: "inline-local-smoke", environment: {}, stop: async () => {} }
    }
    throw new Error(
      `${label} requires shared Redis across Next.js workers. Configure REDIS_URL, ` +
      "install redis-server, set CTS_REDIS_SERVER_BIN, or configure CTS_NPM_REDIS_ROOT.",
    )
  }

  const port = await reserveLoopbackPort()
  const runtimeDir = mkdtempSync(path.join(tmpdir(), "cts-preview-redis-"))
  const url = `redis://127.0.0.1:${port}`
  let outputTail = ""
  const child = binary
    ? spawn(binary, [
        "--bind", "127.0.0.1",
        "--protected-mode", "yes",
        "--port", String(port),
        "--dir", runtimeDir,
        "--save", "",
        "--appendonly", "no",
        "--daemonize", "no",
        "--loglevel", "warning",
      ], { stdio: ["ignore", "pipe", "pipe"] })
    : spawn(process.execPath, [serviceScript], {
        env: {
          ...process.env,
          CTS_NPM_REDIS_ROOT: npmRoot,
          CTS_REDIS_DATA_DIR: runtimeDir,
          CTS_REDIS_PORT: String(port),
          REDISMS_DOWNLOAD_DIR: process.env.REDISMS_DOWNLOAD_DIR || path.join(runtimeDir, "binaries"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      })

  const keepTail = (chunk) => {
    outputTail = `${outputTail}${String(chunk)}`.slice(-16_000)
  }
  child.stdout?.on("data", keepTail)
  child.stderr?.on("data", keepTail)

  try {
    await waitForRedis(child, url, label)
  } catch (error) {
    await stopOwnedRedis(child, runtimeDir)
    const detail = outputTail ? `\nRedis output:\n${outputTail}` : ""
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`)
  }

  let stopped = false
  return {
    kind: binary ? "isolated-native" : "isolated-npm",
    environment: {
      REDIS_URL: url,
      ALLOW_PROD_INLINE_REDIS: "0",
    },
    stop: async () => {
      if (stopped) return
      stopped = true
      await stopOwnedRedis(child, runtimeDir)
    },
  }
}

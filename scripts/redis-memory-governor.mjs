#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createRequire } from "node:module"
import { createClient } from "redis"

const require = createRequire(import.meta.url)
const { MIB, calculateRedisMemoryPolicy } = require("../lib/redis-memory-policy.cjs")
const SIX_HOURS_MS = 6 * 60 * 60 * 1_000

function parseInfo(raw) {
  const result = {}
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue
    const separator = line.indexOf(":")
    if (separator > 0) result[line.slice(0, separator)] = line.slice(separator + 1).trim()
  }
  return result
}

async function readMemInfo() {
  const raw = await readFile("/proc/meminfo", "utf8")
  const values = Object.fromEntries([...raw.matchAll(/^(\w+):\s+(\d+)\s+kB$/gm)].map((match) => [match[1], Number(match[2]) * 1024]))
  let totalBytes = values.MemTotal || 0
  let availableBytes = values.MemAvailable || values.MemFree || 0
  try {
    const [maxRaw, currentRaw] = await Promise.all([
      readFile("/sys/fs/cgroup/memory.max", "utf8"),
      readFile("/sys/fs/cgroup/memory.current", "utf8"),
    ])
    const cgroupMax = Number(maxRaw.trim())
    const cgroupCurrent = Number(currentRaw.trim())
    if (Number.isFinite(cgroupMax) && cgroupMax > 0) {
      totalBytes = Math.min(totalBytes || cgroupMax, cgroupMax)
      availableBytes = Math.min(availableBytes || cgroupMax, Math.max(0, cgroupMax - cgroupCurrent))
    }
  } catch {
    // cgroup v1 or an unrestricted host; /proc remains authoritative.
  }
  return { totalBytes, availableBytes }
}

async function readState(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return {}
  }
}

async function writeState(path, state) {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

function isLocalRedis(redisUrl) {
  try {
    const host = new URL(redisUrl).hostname.toLowerCase()
    return host === "127.0.0.1" || host === "localhost" || host === "::1"
  } catch {
    return false
  }
}

async function main() {
  const redisUrl = process.env.REDIS_URL || process.env.KV_URL || "redis://127.0.0.1:6379"
  const runtimeDir = process.env.CTS_RUNTIME_DIR || join(process.cwd(), ".cts-runtime")
  const statePath = process.env.CTS_REDIS_GOVERNOR_STATE || join(runtimeDir, "redis-memory-governor.json")
  const previous = await readState(statePath)
  const now = Date.now()

  if (!isLocalRedis(redisUrl)) {
    if (now - Number(previous.lastHeartbeatAt || 0) >= SIX_HOURS_MS) {
      console.log("[redis-governor] external Redis detected; host memory policy is not applied")
      await writeState(statePath, { ...previous, state: "external", lastHeartbeatAt: now })
    }
    return
  }

  const client = createClient({ url: redisUrl })
  client.on("error", () => undefined)
  await client.connect()
  try {
    const [memoryRaw, persistenceRaw, maxmemoryConfig, policyConfig, host] = await Promise.all([
      client.info("memory"),
      client.info("persistence"),
      client.configGet("maxmemory"),
      client.configGet("maxmemory-policy"),
      readMemInfo(),
    ])
    const configRows = { ...maxmemoryConfig, ...policyConfig }
    const memory = parseInfo(memoryRaw)
    const persistence = parseInfo(persistenceRaw)
    const usedBytes = Number(memory.used_memory) || 0
    const currentTarget = Number(configRows.maxmemory) || 0
    const buildMode = process.env.CTS_REDIS_BUILD_MODE === "1"
    const instanceShare = Number(process.env.CTS_REDIS_MEMORY_INSTANCE_SHARE || "1")
    const policy = calculateRedisMemoryPolicy({
      ...host,
      usedBytes,
      previousState: previous.state,
      buildMode,
      instanceShare,
    })
    const targetChanged = Math.abs(currentTarget - policy.targetBytes) >= 64 * MIB
    const stateChanged = previous.state !== policy.state
    const actions = []

    if (targetChanged) {
      await client.configSet("maxmemory", String(policy.targetBytes))
      actions.push("maxmemory")
    }
    if (String(configRows["maxmemory-policy"] || "").toLowerCase() !== "noeviction") {
      await client.configSet("maxmemory-policy", "noeviction")
      actions.push("noeviction")
    }
    if (actions.length > 0) {
      await client.configRewrite().catch(() => undefined)
    }

    const fragmentation = Number(memory.mem_fragmentation_ratio) || 0
    const purgeDue = now - Number(previous.lastPurgeAt || 0) >= SIX_HOURS_MS
    let lastPurgeAt = Number(previous.lastPurgeAt || 0)
    if ((policy.state !== "normal" || (fragmentation >= 1.5 && purgeDue)) && usedBytes > 128 * MIB) {
      try {
        await client.sendCommand(["MEMORY", "PURGE"])
        actions.push("memory-purge")
        lastPurgeAt = now
      } catch {
        // Allocator/managed Redis may not support MEMORY PURGE.
      }
    }

    const aofBytes = Number(persistence.aof_current_size) || 0
    const aofRewriteDue = now - Number(previous.lastAofRewriteAt || 0) >= SIX_HOURS_MS
    let lastAofRewriteAt = Number(previous.lastAofRewriteAt || 0)
    if (
      aofRewriteDue
      && persistence.aof_enabled === "1"
      && persistence.aof_rewrite_in_progress !== "1"
      && aofBytes > Math.max(256 * MIB, usedBytes * 1.5)
    ) {
      try {
        await client.bgRewriteAof()
        actions.push("aof-rewrite")
        lastAofRewriteAt = now
      } catch {
        // A rewrite may already be scheduled between INFO and this command.
      }
    }

    const heartbeatDue = now - Number(previous.lastHeartbeatAt || 0) >= SIX_HOURS_MS
    const nextState = {
      state: policy.state,
      targetBytes: policy.targetBytes,
      overBudget: policy.overBudget,
      lastRunAt: now,
      lastHeartbeatAt: stateChanged || actions.length > 0 || heartbeatDue ? now : previous.lastHeartbeatAt,
      lastPurgeAt,
      lastAofRewriteAt,
    }
    await writeState(statePath, nextState)
    if (stateChanged || actions.length > 0 || heartbeatDue || policy.overBudget) {
      console.log(JSON.stringify({
        component: "redis-memory-governor",
        state: policy.state,
        availablePercent: Number((policy.availableRatio * 100).toFixed(1)),
        usedMiB: Math.round(usedBytes / MIB),
        maxmemoryMiB: Math.round(policy.targetBytes / MIB),
        overBudget: policy.overBudget,
        instanceShare: policy.instanceShare,
        actions,
      }))
    }
  } finally {
    await client.quit().catch(() => client.disconnect())
  }
}

main().catch((error) => {
  console.error(`[redis-governor] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})

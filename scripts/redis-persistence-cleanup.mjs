#!/usr/bin/env node

/**
 * Remove only Redis persistence artifacts that cannot participate in the
 * current recovery chain. The active multi-part AOF names come exclusively
 * from appendonly.aof.manifest; dump.rdb and every unknown file are preserved.
 */
import { readdir, readFile, stat, unlink } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const MANIFEST_NAME = "appendonly.aof.manifest"
const CANONICAL_AOF_SEGMENT = /^appendonly\.aof\.\d+\.(?:base\.rdb|incr\.aof)$/
const TOP_LEVEL_REWRITE_TEMP = /^(?:temp-\d+\.rdb|temp-rewriteaof-\d+\.aof|\.(?:dump|temp).*\.rdb(?:\..+)?)$/

function safeDataDirectory(value) {
  const resolved = path.resolve(String(value || ""))
  if (!value || resolved === path.parse(resolved).root || resolved.length < 8) {
    throw new Error(`Refusing unsafe Redis data directory: ${String(value || "<empty>")}`)
  }
  return resolved
}

async function regularFiles(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}

async function activeAofSegments(appendOnlyDirectory) {
  const manifestPath = path.join(appendOnlyDirectory, MANIFEST_NAME)
  let manifest = ""
  try {
    manifest = await readFile(manifestPath, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return new Set()
    throw error
  }
  return new Set(
    manifest
      .split(/\r?\n/)
      .map((line) => /^file\s+(\S+)\s+seq\s+\d+\s+type\s+[bi]\b/.exec(line)?.[1] || "")
      .filter(Boolean),
  )
}

export async function cleanupRedisPersistenceArtifacts(
  dataDirectory,
  { dryRun = false, minimumAgeMs = 0 } = {},
) {
  const dataDir = safeDataDirectory(dataDirectory)
  const safeMinimumAgeMs = Math.max(0, Number(minimumAgeMs) || 0)
  const appendOnlyDirectory = path.join(dataDir, "appendonlydir")
  const activeSegments = await activeAofSegments(appendOnlyDirectory)
  const candidates = []

  for (const name of await regularFiles(dataDir)) {
    if (TOP_LEVEL_REWRITE_TEMP.test(name)) candidates.push(path.join(dataDir, name))
  }
  for (const name of await regularFiles(appendOnlyDirectory)) {
    const isTemporary = name.startsWith(".")
    const isObsoleteSegment = CANONICAL_AOF_SEGMENT.test(name) &&
      activeSegments.size > 0 &&
      !activeSegments.has(name)
    if (isTemporary || isObsoleteSegment) candidates.push(path.join(appendOnlyDirectory, name))
  }

  let bytes = 0
  const removed = []
  const skippedYoung = []
  const now = Date.now()
  for (const candidate of candidates.sort()) {
    const metadata = await stat(candidate).catch(() => null)
    if (!metadata?.isFile()) continue
    if (safeMinimumAgeMs > 0 && now - metadata.mtimeMs < safeMinimumAgeMs) {
      skippedYoung.push(path.relative(dataDir, candidate))
      continue
    }
    bytes += metadata.size
    removed.push(path.relative(dataDir, candidate))
    if (!dryRun) await unlink(candidate)
  }
  return {
    dataDir,
    dryRun,
    activeAofSegments: [...activeSegments].sort(),
    minimumAgeMs: safeMinimumAgeMs,
    removedFiles: removed.length,
    reclaimedBytes: bytes,
    removed,
    skippedYoungFiles: skippedYoung.length,
    skippedYoung,
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directoryIndex = process.argv.indexOf("--dir")
  const dataDirectory = directoryIndex >= 0 ? process.argv[directoryIndex + 1] : ""
  const dryRun = process.argv.includes("--dry-run")
  const ageIndex = process.argv.indexOf("--minimum-age-ms")
  const minimumAgeMs = ageIndex >= 0 ? Number(process.argv[ageIndex + 1]) : 0
  if (!dryRun && !process.argv.includes("--stopped")) {
    throw new Error("Mutation requires --stopped after the Redis service has been stopped")
  }
  const result = await cleanupRedisPersistenceArtifacts(dataDirectory, { dryRun, minimumAgeMs })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

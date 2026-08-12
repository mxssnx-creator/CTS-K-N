"use strict"

/**
 * Next 15's temporary static-generation directory can receive the final
 * MultiFileWriter rename while the build parent is already removing it. On
 * overlay filesystems Node's default fs.promises.rm() has no retries unless
 * maxRetries is explicitly supplied, so the otherwise complete build exits
 * with ENOTEMPTY at `<distDir>/export`.
 *
 * The same build can start its adapter callback while a `.nft.json` trace is
 * between truncate and flush, producing `Unexpected end of JSON input` and a
 * permanently incomplete standalone artifact. Keep the workarounds narrow:
 * only recursive removal of a temporary Next export directory, reads of Next
 * output-trace JSON, and writes of Next-owned JSON build contracts receive
 * special handling. JSON writes publish by same-directory rename so readers
 * never observe the truncate/write window; reads retain a bounded readiness
 * retry for traces emitted by webpack's separate output filesystem. Every
 * other path and filesystem error keeps Node's native behaviour.
 */

const fs = require("fs")
const fsPromises = require("fs/promises")
const path = require("path")

const nativeRm = fsPromises.rm.bind(fsPromises)
const nativeReadFile = fsPromises.readFile.bind(fsPromises)
const nativeWriteFile = fsPromises.writeFile.bind(fsPromises)
const nativeRename = fsPromises.rename.bind(fsPromises)
const nativeUnlink = fsPromises.unlink.bind(fsPromises)
// Match the outer build wrapper's late-writer settlement window. In practice
// a trace normally becomes complete within milliseconds; this is only the
// fail-closed ceiling for severely throttled provider filesystems.
const traceReadAttempts = 300
const traceReadDelayMs = 50
let traceWriteSequence = 0

function isNextTemporaryExport(target, options) {
  if (!options?.recursive || typeof target !== "string") return false
  const resolved = path.resolve(target)
  return path.basename(resolved) === "export" && path.basename(path.dirname(resolved)).startsWith(".next")
}

async function rmWithNextExportRetry(target, options) {
  try {
    return await nativeRm(target, options)
  } catch (error) {
    if (
      !isNextTemporaryExport(target, options) ||
      !["ENOTEMPTY", "EBUSY", "EPERM"].includes(error?.code)
    ) {
      throw error
    }

    return nativeRm(target, {
      ...options,
      maxRetries: Math.max(20, Number(options?.maxRetries) || 0),
      retryDelay: Math.max(50, Number(options?.retryDelay) || 0),
    })
  }
}

function isNextTraceFile(target) {
  if (typeof target !== "string") return false
  const resolved = path.resolve(target)
  if (!resolved.endsWith(".nft.json")) return false
  return resolved.split(path.sep).some((part) => part.startsWith(".next"))
}

function isNextJsonBuildContract(target) {
  if (typeof target !== "string") return false
  const resolved = path.resolve(target)
  if (!resolved.endsWith(".json")) return false
  return resolved.split(path.sep).some((part) => part.startsWith(".next"))
}

function isCompleteNextTrace(contents) {
  try {
    const parsed = JSON.parse(Buffer.isBuffer(contents) ? contents.toString("utf8") : String(contents))
    return parsed?.version === 1 && Array.isArray(parsed.files) && parsed.files.length > 0
  } catch {
    return false
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function readFileWithNextTraceReadiness(target, options) {
  if (!isNextTraceFile(target)) return nativeReadFile(target, options)

  let lastContents
  for (let attempt = 0; attempt <= traceReadAttempts; attempt += 1) {
    try {
      lastContents = await nativeReadFile(target, options)
      if (isCompleteNextTrace(lastContents) || attempt === traceReadAttempts) {
        return lastContents
      }
    } catch (error) {
      if (error?.code !== "ENOENT" || attempt === traceReadAttempts) throw error
    }
    await wait(traceReadDelayMs)
  }
  return lastContents
}

async function writeFileWithAtomicNextJsonPublish(target, contents, options) {
  if (!isNextJsonBuildContract(target)) return nativeWriteFile(target, contents, options)

  const requestedFlag = typeof options === "object" && options !== null ? options.flag : undefined
  if (requestedFlag && requestedFlag !== "w") return nativeWriteFile(target, contents, options)

  const resolved = path.resolve(target)
  traceWriteSequence += 1
  const temporary = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${process.pid}.${traceWriteSequence}.tmp`,
  )

  try {
    await nativeWriteFile(temporary, contents, options)
    return await nativeRename(temporary, resolved)
  } catch (error) {
    try {
      await nativeUnlink(temporary)
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") {
        error.traceTemporaryCleanupError = cleanupError
      }
    }
    throw error
  }
}

fsPromises.rm = rmWithNextExportRetry
fsPromises.readFile = readFileWithNextTraceReadiness
fsPromises.writeFile = writeFileWithAtomicNextJsonPublish
// `require("fs").promises` and `require("fs/promises")` normally share the
// same object, but assign both surfaces explicitly for Node patch-version
// compatibility and for Next's compiled `_fs.default.promises.*` access.
fs.promises.rm = rmWithNextExportRetry
fs.promises.readFile = readFileWithNextTraceReadiness
fs.promises.writeFile = writeFileWithAtomicNextJsonPublish

#!/usr/bin/env node

/**
 * Inspect the SET history for exact Redis keys in one RESP-format incremental
 * AOF. The tool is deliberately read-only: it prints hashes and compact JSON
 * summaries, never values, and never connects to Redis.
 */

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

const [file, ...keys] = process.argv.slice(2)
if (!file || keys.length === 0) {
  process.stderr.write("Usage: inspect-redis-aof-key-history.mjs AOF_FILE KEY [KEY ...]\n")
  process.exit(2)
}

const data = readFileSync(file)
const crlf = Buffer.from("\r\n")

function summarizeValue(value) {
  try {
    const parsed = JSON.parse(value.toString("utf8"))
    if (!Array.isArray(parsed)) return { json: true, type: typeof parsed }

    const statuses = {}
    for (const position of parsed) {
      const label = `${String(position?.mode || "simulated")}:${String(position?.status || "unknown")}`
      statuses[label] = (statuses[label] || 0) + 1
    }

    return {
      json: true,
      count: parsed.length,
      statuses,
      active: parsed
        .filter((position) => ["open", "opening"].includes(String(position?.status)))
        .map((position) => ({
          id: position?.id,
          symbol: position?.symbol,
          direction: position?.direction,
          status: position?.status,
          mode: position?.mode,
          controlId: position?.openControlId || position?.closeControlId || null,
          orderId: position?.exchangeOrderId || position?.openOrderId || position?.orderId || null,
        })),
    }
  } catch (error) {
    return { json: false, error: String(error?.message || error).slice(0, 120) }
  }
}

function inspectKey(key) {
  const keyBytes = Buffer.from(key)
  const setMarker = Buffer.from(`$3\r\nSET\r\n$${keyBytes.length}\r\n`)
  const records = []
  const transitions = []
  let cursor = 0
  let occurrences = 0
  let previousSha256 = null

  while (true) {
    const keyOffset = data.indexOf(keyBytes, cursor)
    if (keyOffset < 0) break
    cursor = keyOffset + keyBytes.length

    const commandOffset = data.lastIndexOf(setMarker, keyOffset)
    if (commandOffset < 0 || commandOffset + setMarker.length !== keyOffset) continue

    let offset = keyOffset + keyBytes.length
    if (data[offset] !== 13 || data[offset + 1] !== 10 || data[offset + 2] !== 36) continue
    offset += 3
    const lengthEnd = data.indexOf(crlf, offset)
    if (lengthEnd < 0) continue
    const length = Number(data.subarray(offset, lengthEnd).toString("ascii"))
    if (!Number.isSafeInteger(length) || length < 0) continue

    const valueOffset = lengthEnd + 2
    const valueEnd = valueOffset + length
    if (valueEnd + 2 > data.length) continue
    const value = data.subarray(valueOffset, valueEnd)
    occurrences += 1
    const record = {
      offset: valueOffset,
      length,
      sha256: createHash("sha256").update(value).digest("hex"),
      ...summarizeValue(value),
    }
    records.push(record)
    if (records.length > 20) records.shift()
    if (record.sha256 !== previousSha256) {
      transitions.push(record)
      if (transitions.length > 12) transitions.shift()
      previousSha256 = record.sha256
    }
  }

  return { occurrences, lastTransitions: transitions, lastRecords: records }
}

const report = {
  file,
  bytes: data.length,
  keys: Object.fromEntries(keys.map((key) => [key, inspectKey(key)])),
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)

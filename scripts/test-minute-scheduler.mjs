#!/usr/bin/env node

import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { CRON_PATHS, MINUTE_INTERVAL_MS, runSchedulerTick } from "./run-minute-scheduler.mjs"

const secret = "test-cron-secret-1234567890"
const received = []
const server = createServer((request, response) => {
  received.push({ path: request.url, authorization: request.headers.authorization })
  response.writeHead(200, { "Content-Type": "application/json" })
  response.end(JSON.stringify({ ok: true }))
})

server.listen(0, "127.0.0.1")
await once(server, "listening")

try {
  const address = server.address()
  assert.equal(typeof address, "object")
  const summary = await runSchedulerTick({
    baseUrl: `http://127.0.0.1:${address.port}`,
    secret,
    timeoutMs: 2_000,
  })

  assert.equal(summary.ok, true)
  assert.equal(MINUTE_INTERVAL_MS, 60_000)
  assert.deepEqual(received.map((entry) => entry.path).sort(), [...CRON_PATHS].sort())
  assert.ok(received.every((entry) => entry.authorization === `Bearer ${secret}`))
  console.log(JSON.stringify({ success: true, paths: received.length, intervalMs: MINUTE_INTERVAL_MS }))
} finally {
  server.close()
  await once(server, "close")
}

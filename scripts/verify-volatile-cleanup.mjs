#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const redisDb = readFileSync('lib/redis-db.ts', 'utf8')
const startup = readFileSync('lib/startup-coordinator.ts', 'utf8')

function assert(condition, message) {
  if (!condition) {
    console.error(`volatile cleanup regression failed: ${message}`)
    process.exitCode = 1
  }
}

assert(/export async function cleanupVolatileRuntimeState/.test(redisDb), 'cleanupVolatileRuntimeState must be exported')
assert(/VOLATILE_STATE_STALE_MS/.test(redisDb), 'cleanup threshold must be configurable')
assert(/key\.startsWith\("prehistoric_loaded:"\)[\s\S]*staleStringKey/.test(redisDb) || /key\.startsWith\("live:lock:"\) \|\| key\.startsWith\("prehistoric_loaded:"\)/.test(redisDb), 'prehistoric_loaded:* must be evaluated by stale cleanup in production')
assert(/key\.startsWith\("live:lock:"\)[\s\S]*olderThanThreshold/.test(redisDb) || /key\.startsWith\("live:lock:"\) \|\| key\.startsWith\("prehistoric_loaded:"\)/.test(redisDb), 'live:lock:* must be evaluated by stale cleanup in production')
assert(
  /key\.startsWith\("live:position:"\)[\s\S]*key\.startsWith\("live:position:tracking:"\) \|\| key\.includes\(":moved:"\)/.test(redisDb),
  'cleanup must preserve durable live positions and only remove transient tracking/moved keys',
)
assert(/key\.startsWith\("strategies:"\)[\s\S]*activeOwnerSafe[\s\S]*hasFreshOwner/.test(redisDb), 'cleanup must preserve strategies:* data for a fresh distributed owner')
assert(/key\.startsWith\("pseudo_position:"\)[\s\S]*activeOwnerSafe[\s\S]*hasFreshOwner/.test(redisDb), 'cleanup must preserve pseudo_position:* data for a fresh distributed owner')
assert(/mode === "activeOwnerSafe"/.test(redisDb), 'production-safe cleanup must require active-owner protection mode')
assert(
  /await initRedis\(\)[\s\S]*cleanupVolatileRuntimeState\(\{ mode: "activeOwnerSafe", reason: "completeStartup" \}\)/.test(startup),
  'completeStartup must run active-owner-safe volatile cleanup immediately after initRedis',
)

if (process.exitCode) process.exit(process.exitCode)
console.log('volatile cleanup regression checks passed')

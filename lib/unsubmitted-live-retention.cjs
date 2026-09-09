const TRANSIENT_FAILURE_GRACE_MS = 60 * 60 * 1000

function parsed(value) {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) } catch { return value }
}

/** Never classify an ambiguous or exchange-backed record as disposable. */
function isRetirableUnsubmittedFailure(row, now = Date.now()) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false
  if (!["rejected", "error"].includes(String(row.status || "").toLowerCase())) return false
  if (!["live", "blocked"].includes(String(row.executionMode || "").toLowerCase())) return false
  const updatedAt = Number(row.updatedAt || row.createdAt)
  if (!Number.isFinite(updatedAt) || updatedAt <= 0 || now - updatedAt < TRANSIENT_FAILURE_GRACE_MS) return false
  for (const field of ["executedQuantity", "totalExecutedQuantity", "closedQuantity", "remainingQuantity", "filledQuantity", "filledQty"]) {
    const value = row[field]
    if (value !== undefined && value !== null && value !== "" && (!Number.isFinite(Number(value)) || Number(value) !== 0)) return false
  }
  for (const field of ["orderId", "exchangeOrderId", "clientOrderId", "exchangePositionId", "positionId", "closeOrderId", "stopLossOrderId", "takeProfitOrderId", "securityStopOrderId"]) {
    if (String(row[field] ?? "").trim()) return false
  }
  for (const field of ["fills", "partialOrderExecutions", "controlOrders", "controlOrderSetCoverage", "exchangeData", "pendingAccumulation", "pendingReduction", "pendingSystemAction", "pendingQuantityMutation", "pendingProtectionOrders"]) {
    const value = parsed(row[field])
    if (value == null || value === "" || value === false) continue
    if (typeof value === "object" && Object.keys(value).length === 0) continue
    return false
  }
  if (String(row.submissionState ?? "").trim()) return false
  return true
}

// Compare every field, not just a timestamp: a concurrent recovery save must
// fence retirement even if an older writer forgot to increment its version.
// EXPIRE releases large objects through Redis' configured lazy expiration.
// Active writers PERSIST their own lifecycle records as an additional fence.
const RETIRE_UNSUBMITTED_LUA = `
local function matches(key,kind,encoded)
  if redis.call('TYPE', key).ok ~= kind then return false end
  if kind == 'none' then return true end
  if kind == 'string' then return redis.call('GET', key) == encoded end
  if kind ~= 'hash' then return false end
  local expected = cjson.decode(encoded)
  local count = 0
  for field,value in pairs(expected) do
    count = count + 1
    if redis.call('HGET', key, field) ~= value then return false end
  end
  return redis.call('HLEN', key) == count
end
if not matches(KEYS[1],ARGV[1],ARGV[2]) or not matches(KEYS[2],ARGV[3],ARGV[4]) then return 0 end
local ttl = redis.call('TTL', KEYS[1])
if ttl >= 0 and ttl <= 60 then return 0 end
redis.call('EXPIRE', KEYS[1], 60)
if ARGV[3] ~= 'none' then redis.call('EXPIRE', KEYS[2], 60) end
return 1
`

async function retireUnsubmittedRedisRecord(client, key, kind, raw, now = Date.now()) {
  const row = kind === 'hash' ? raw : parsed(raw)
  if (!isRetirableUnsubmittedFailure(row, now)) return 0
  // This legacy storm repair is deliberately scoped to the authorised X02
  // account; unrelated connections retain their existing retention policy.
  const connection = String(row.connectionId || row.connection_id || '')
  const id = String(row.id || '')
  if (connection !== 'bingx-x02' || !id.startsWith(`live:${connection}:`)) return 0
  const primary = `live_positions:${connection}:${id}`
  const mirror = `live:position:${id}`
  if (key !== (kind === 'hash' ? primary : mirror)) return 0
  const peer = kind === 'hash' ? mirror : primary
  const peerKind = await client.type(peer)
  if (!['none', 'hash', 'string'].includes(peerKind)) return 0
  const peerRaw = peerKind === 'none' ? '' : peerKind === 'hash'
    ? await (client.hgetall || client.hGetAll).call(client, peer)
    : await client.get(peer)
  const peerRow = peerKind === 'hash' ? peerRaw : parsed(peerRaw)
  if (peerKind !== 'none' && !isRetirableUnsubmittedFailure(peerRow, now)) return 0
  return client.eval(RETIRE_UNSUBMITTED_LUA, {
    keys: [key, peer],
    arguments: [kind, kind === 'hash' ? JSON.stringify(raw) : raw, peerKind, peerKind === 'hash' ? JSON.stringify(peerRaw) : peerRaw],
  })
}

module.exports = { TRANSIENT_FAILURE_GRACE_MS, isRetirableUnsubmittedFailure, RETIRE_UNSUBMITTED_LUA, retireUnsubmittedRedisRecord }

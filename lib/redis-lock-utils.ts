export function createRedisLockToken(scope: string): string {
  return `${scope}:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 12)}`
}

export async function releaseOwnedRedisLock(client: any, key: string, token: string): Promise<boolean> {
  if (typeof client?.eval === "function") {
    try {
      const released = await client.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
        { keys: [key], arguments: [token] },
      )
      return Number(released) === 1
    } catch { return false }
  }
  const current = await client.get(key).catch(() => null)
  if (current !== token) return false
  return Number(await client.del(key).catch(() => 0)) === 1
}

export async function renewOwnedRedisLock(
  client: any,
  key: string,
  token: string,
  ttlSeconds: number,
): Promise<boolean> {
  if (typeof client?.eval === "function") {
    try {
      const renewed = await client.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) else return 0 end",
        { keys: [key], arguments: [token, String(ttlSeconds)] },
      )
      return Number(renewed) === 1
    } catch { return false }
  }
  const current = await client.get(key).catch(() => null)
  if (current !== token) return false
  return (await client.set(key, token, { XX: true, EX: ttlSeconds }).catch(() => null)) === "OK"
}

/** Replace a lock only while its observed value is still unchanged. */
export async function replaceRedisLockIfValue(
  client: any,
  key: string,
  expected: string,
  replacement: string,
  ttlSeconds: number,
): Promise<boolean> {
  if (typeof client?.eval === "function") {
    try {
      const replaced = await client.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) return 1 else return 0 end",
        { keys: [key], arguments: [expected, replacement, String(ttlSeconds)] },
      )
      return Number(replaced) === 1
    } catch { return false }
  }
  // InlineLocalRedis is single-process, so its compare/set fallback cannot
  // race another process. Shared adapters expose EVAL and fail closed above.
  const current = await client.get(key).catch(() => null)
  if (current !== expected) return false
  return (await client.set(key, replacement, { EX: ttlSeconds }).catch(() => null)) === "OK"
}

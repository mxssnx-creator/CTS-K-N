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
    } catch {
      // Inline/test clients may expose a partial EVAL surface. Use the safe
      // single-process fallback below; shared Redis adapters support the Lua.
    }
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
    } catch {
      // See releaseOwnedRedisLock fallback note.
    }
  }
  const current = await client.get(key).catch(() => null)
  if (current !== token) return false
  return (await client.set(key, token, { XX: true, EX: ttlSeconds }).catch(() => null)) === "OK"
}

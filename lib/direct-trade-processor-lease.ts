export type DirectTradeLeaseBackend = "inline-local" | "redis-network" | "kilo-sqlite-snapshot"

const RENEW_OWNED_LEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`

const inlineLeaseTails = new Map<string, Promise<void>>()

async function withInlineLeaseLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = inlineLeaseTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.catch(() => {}).then(() => gate)
  inlineLeaseTails.set(key, tail)
  await previous.catch(() => {})
  try {
    return await work()
  } finally {
    release()
    if (inlineLeaseTails.get(key) === tail) inlineLeaseTails.delete(key)
  }
}

function validLeaseInput(key: string, owner: string, ttlMs: number): boolean {
  return Boolean(key && owner && owner.length <= 160 && Number.isFinite(ttlMs) && ttlMs > 0)
}

async function renewInlineOwnedLease(
  client: any,
  key: string,
  owner: string,
  ttlMs: number,
): Promise<boolean> {
  const current = await client.get(key).catch(() => null)
  if (current !== owner) return false
  const renewed = await client.set(key, owner, { XX: true, PX: ttlMs }).catch(() => null)
  return renewed === "OK" || renewed === true
}

async function renewSharedOwnedLease(
  client: any,
  key: string,
  owner: string,
  ttlMs: number,
): Promise<boolean> {
  // Shared Redis must compare the owner and extend its TTL in one server-side
  // operation. GET followed by SET XX can steal a lease from a new owner when
  // the old lease expires between those two commands.
  if (typeof client?.eval !== "function") return false
  try {
    const renewed = await client.eval(RENEW_OWNED_LEASE_LUA, {
      keys: [key],
      arguments: [owner, String(ttlMs)],
    })
    return Number(renewed) === 1
  } catch {
    return false
  }
}

export async function acquireOrRenewDirectTradeProcessorLease(input: {
  client: any
  key: string
  owner: string
  ttlMs: number
  backend: DirectTradeLeaseBackend
}): Promise<boolean> {
  const { client, key, owner, ttlMs, backend } = input
  if (!validLeaseInput(key, owner, ttlMs)) return false

  if (backend === "inline-local") {
    return withInlineLeaseLock(key, async () => {
      const created = await client.set(key, owner, { NX: true, PX: ttlMs }).catch(() => null)
      if (created === "OK" || created === true) return true
      return renewInlineOwnedLease(client, key, owner, ttlMs)
    })
  }

  const created = await client.set(key, owner, { NX: true, PX: ttlMs }).catch(() => null)
  if (created === "OK" || created === true) return true
  return renewSharedOwnedLease(client, key, owner, ttlMs)
}

export async function renewDirectTradeProcessorLease(input: {
  client: any
  key: string
  owner: string
  ttlMs: number
  backend: DirectTradeLeaseBackend
}): Promise<boolean> {
  const { client, key, owner, ttlMs, backend } = input
  if (!validLeaseInput(key, owner, ttlMs)) return false
  if (backend === "inline-local") {
    return withInlineLeaseLock(key, () => renewInlineOwnedLease(client, key, owner, ttlMs))
  }
  return renewSharedOwnedLease(client, key, owner, ttlMs)
}

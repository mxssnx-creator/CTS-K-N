import { scanRedisKeys } from "@/lib/redis-scan"

export const STATIC_CONNECTION_INDEX_KEYS = [
  "connections:main:enabled",
  "connections:base:enabled",
  "connections:working",
] as const

function isEnabled(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true"
}

function connectionId(connection: any): string {
  return String(connection?.id ?? "").trim()
}

function exchangeName(connection: any): string {
  return String(connection?.exchange ?? "").trim().toLowerCase()
}

function isMainEnabled(connection: any): boolean {
  const assigned =
    isEnabled(connection?.is_assigned) ||
    isEnabled(connection?.is_active_inserted) ||
    isEnabled(connection?.is_dashboard_inserted)
  return assigned && isEnabled(connection?.is_enabled_dashboard)
}

function isBaseEnabled(connection: any): boolean {
  return isEnabled(connection?.is_inserted) && isEnabled(connection?.is_enabled)
}

function isWorking(connection: any): boolean {
  const status = String(
    connection?.last_test_status ?? connection?.test_status ?? connection?.connection_status ?? "",
  ).toLowerCase()
  return status === "success" || status === "connected" || status === "working"
}

export function getConnectionSecondaryIndexKeys(connection: any): Set<string> {
  const keys = new Set<string>()
  if (isMainEnabled(connection)) keys.add("connections:main:enabled")
  if (isBaseEnabled(connection)) keys.add("connections:base:enabled")
  if (isWorking(connection)) keys.add("connections:working")
  const exchange = exchangeName(connection)
  if (exchange) keys.add(`connections:exchange:${exchange}`)
  return keys
}

function queueOrRun(client: any, commands: Array<[string, ...any[]]>): Promise<any> {
  if (typeof client?.multi === "function") {
    const tx = client.multi()
    for (const [method, ...args] of commands) tx[method](...args)
    return tx.exec()
  }
  return Promise.all(commands.map(([method, ...args]) => client[method](...args)))
}

export async function syncConnectionSecondaryIndexes(
  client: any,
  connection: any,
  previousConnection?: any,
): Promise<void> {
  const id = connectionId(connection)
  if (!id) return
  const desired = getConnectionSecondaryIndexKeys(connection)
  const commands: Array<[string, ...any[]]> = STATIC_CONNECTION_INDEX_KEYS.map((key) => [
    desired.has(key) ? "sadd" : "srem",
    key,
    id,
  ])

  const currentExchange = exchangeName(connection)
  const previousExchange = exchangeName(previousConnection)
  if (previousExchange && previousExchange !== currentExchange) {
    commands.push(["srem", `connections:exchange:${previousExchange}`, id])
  }
  if (currentExchange) commands.push(["sadd", `connections:exchange:${currentExchange}`, id])
  await queueOrRun(client, commands)
}

export async function removeConnectionSecondaryIndexes(client: any, connection: any): Promise<void> {
  const id = connectionId(connection)
  if (!id) return
  const commands: Array<[string, ...any[]]> = STATIC_CONNECTION_INDEX_KEYS.map((key) => ["srem", key, id])
  const exchange = exchangeName(connection)
  if (exchange) commands.push(["srem", `connections:exchange:${exchange}`, id])
  await queueOrRun(client, commands)
}

export interface ConnectionIndexRebuildResult {
  connections: number
  indexKeys: number
  memberships: number
}

export async function rebuildConnectionSecondaryIndexes(
  client: any,
  connections: any[],
): Promise<ConnectionIndexRebuildResult> {
  const exchangeIndexKeys = await scanRedisKeys(client, "connections:exchange:*")
  const indexKeys = [...STATIC_CONNECTION_INDEX_KEYS, ...exchangeIndexKeys]
  const membersByKey = new Map<string, string[]>()

  for (const connection of connections) {
    const id = connectionId(connection)
    if (!id) continue
    for (const key of getConnectionSecondaryIndexKeys(connection)) {
      const members = membersByKey.get(key) ?? []
      members.push(id)
      membersByKey.set(key, members)
    }
  }

  const commands: Array<[string, ...any[]]> = []
  if (indexKeys.length > 0) commands.push(["del", ...indexKeys])
  for (const [key, members] of membersByKey) {
    if (members.length > 0) commands.push(["sadd", key, ...members])
  }
  if (commands.length > 0) await queueOrRun(client, commands)

  return {
    connections: connections.length,
    indexKeys: new Set([...indexKeys, ...membersByKey.keys()]).size,
    memberships: Array.from(membersByKey.values()).reduce((total, members) => total + members.length, 0),
  }
}

/** Operator-facing label for the Redis backend reported by /api/install/status. */
export function describeRedisMode(status: { databaseConnected?: boolean; redisBackend?: string } | null): string {
  if (!status) return "Checking…"
  if (!status.databaseConnected) return "Disconnected"
  return status.redisBackend === "inline-local" ? "In-Memory Fallback" : "Persistent Redis"
}

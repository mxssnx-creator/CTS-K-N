/**
 * A dashboard poll can arrive while an operator's configuration change is
 * queued or in flight. Keep the local value authoritative until that write is
 * confirmed, otherwise a stale poll can make a slider jump back.
 */
export function mergePendingDirectTradeConfig<T extends object>(
  remote: T,
  local: T,
  pendingKeys: ReadonlySet<string>,
): T {
  const next = { ...remote } as T
  for (const key of pendingKeys) {
    const typedKey = key as keyof T
    if (typedKey in local) next[typedKey] = local[typedKey]
  }
  return next
}

type TradeEngineIntentClient = {
  hset(key: string, values: Record<string, string>): Promise<unknown>
  hdel(key: string, ...fields: string[]): Promise<unknown>
}

/**
 * Publish the durable running transition used by every operator start path.
 * This deliberately does not catch persistence errors: starting an engine
 * without first committing its operator intent would create a split-brain
 * control state.
 */
export async function publishRunningTradeEngineIntent(
  client: TradeEngineIntentClient,
  options: { event: "started" | "resumed" | "restarted"; previousStatus?: string; startedAt?: string } = { event: "started" },
): Promise<void> {
  const nowIso = new Date().toISOString()
  const eventField = `${options.event}_at`

  await client.hset("trade_engine:global", {
    status: "running",
    desired_status: "running",
    operator_intent: "running",
    actual_status: "running",
    coordinator_ready: "true",
    operator_stopped: "0",
    stopped_at: "",
    operator_stopped_at: "",
    ...(options.previousStatus ? { previous_status: options.previousStatus } : {}),
    ...(options.startedAt ? { started_at: options.startedAt } : {}),
    [eventField]: nowIso,
    last_start_requested_at: nowIso,
    updated_at: nowIso,
  })
  await client.hdel("trade_engine:global", "paused_at", "paused_by", "pause_reason")
}

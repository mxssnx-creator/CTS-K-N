import { EventEmitter } from "events"
import { getRedisClient, initRedis } from "./redis-db"

export type EngineEventName =
  | "engine.intent.changed"
  | "engine.heartbeat.missed"
  | "engine.heartbeat.updated"
  | "settings.changed"
  | "progression.stage.completed"
  | "market.candle.closed"
  | "engine.refresh.requested"

export interface EngineEventPayloads {
  "engine.intent.changed": { connectionId?: string; intent: string; reason?: string; timestamp?: string }
  "engine.heartbeat.missed": { connectionId: string; lastHeartbeatAt?: number; ageMs?: number; reason?: string; timestamp?: string }
  "engine.heartbeat.updated": { connectionId: string; heartbeatAt: number; source?: string; timestamp?: string }
  "settings.changed": { connectionId: string; changedFields: string[]; changeType: string; timestamp: string; eventId?: string }
  "progression.stage.completed": { connectionId: string; stage: string; successful?: boolean; cycle?: number; timestamp?: string }
  "market.candle.closed": { connectionId?: string; symbol: string; interval?: string; closedAt: number; timestamp?: string }
  "engine.refresh.requested": { connectionId: string; action: string; stateSwitchVersion: string; reason: string; timestamp: string }
}

export type EngineEvent<T extends EngineEventName = EngineEventName> = {
  id: string
  type: T
  payload: EngineEventPayloads[T]
  createdAt: string
}

type Handler<T extends EngineEventName> = (event: EngineEvent<T>) => void | Promise<void>

const STREAM_KEY = "engine:events"
const MAX_EVENTS = 10_000
const g = globalThis as typeof globalThis & { __engine_event_bus?: EventEmitter }
const emitter = g.__engine_event_bus ?? new EventEmitter()
emitter.setMaxListeners(1000)
g.__engine_event_bus = emitter

function eventId(type: EngineEventName, payload: unknown): string {
  const p = payload as Record<string, any>
  const scope = p?.connectionId || p?.symbol || "global"
  return `${Date.now()}-${type}-${scope}-${Math.random().toString(36).slice(2, 8)}`
}

export async function publishEngineEvent<T extends EngineEventName>(
  type: T,
  payload: EngineEventPayloads[T],
): Promise<EngineEvent<T>> {
  const event: EngineEvent<T> = { id: eventId(type, payload), type, payload, createdAt: new Date().toISOString() }
  // Notify in-process consumers first. Redis persistence is intentionally
  // best-effort and must never add network latency to state transitions.
  emitter.emit(type, event)
  emitter.emit("*", event)

  void (async () => {
    try {
      await initRedis().catch(() => undefined)
      const client = getRedisClient()
      await client.rpush(STREAM_KEY, JSON.stringify(event))
      await client.ltrim(STREAM_KEY, -MAX_EVENTS, -1).catch(() => undefined)
    } catch (error) {
      console.warn("[v0] [EngineEventBus] durable append failed:", error instanceof Error ? error.message : String(error))
    }
  })()
  return event
}

export function onEngineEvent<T extends EngineEventName>(type: T, handler: Handler<T>): () => void {
  const listener = (event: EngineEvent<T>) => {
    try { void Promise.resolve(handler(event)).catch((e) => console.warn("[v0] [EngineEventBus] handler failed:", e instanceof Error ? e.message : String(e))) }
    catch (e) { console.warn("[v0] [EngineEventBus] handler failed:", e instanceof Error ? e.message : String(e)) }
  }
  emitter.on(type, listener)
  return () => emitter.off(type, listener)
}

/**
 * Wait for the next matching engine event. Event delivery is the primary
 * completion path; timeout/abort are safety boundaries for crashed producers.
 */
export function waitForEngineEvent<T extends EngineEventName>(
  type: T,
  predicate: (event: EngineEvent<T>) => boolean = () => true,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<EngineEvent<T>> {
  const { timeoutMs = 30_000, signal } = options
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      emitter.off(type, listener)
      if (timeout) clearTimeout(timeout)
      signal?.removeEventListener("abort", onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Event wait aborted"))
    }
    const listener = (event: EngineEvent<T>) => {
      if (!predicate(event)) return
      cleanup()
      resolve(event)
    }
    if (signal?.aborted) return onAbort()
    emitter.on(type, listener)
    signal?.addEventListener("abort", onAbort, { once: true })
    timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for engine event ${type}`))
    }, timeoutMs)
  })
}

export async function readEngineEvents(start = 0, stop = -1): Promise<EngineEvent[]> {
  await initRedis().catch(() => undefined)
  const rows = await getRedisClient().lrange(STREAM_KEY, start, stop).catch(() => [])
  return rows.flatMap((row) => { try { return [JSON.parse(row) as EngineEvent] } catch { return [] } })
}

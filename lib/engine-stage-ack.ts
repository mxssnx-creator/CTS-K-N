import { getBroadcaster } from "@/lib/event-broadcaster"

export const ENGINE_STAGE_ACK_EVENT = "engine-stage-ack" as const

export const ENGINE_STAGE_ACK_STAGES = [
  "startup",
  "market_data",
  "prehistoric_data",
  "base_sets",
  "main_sets",
  "real_sets",
  "live_dispatch",
  "live_sync",
  "recoordination_complete",
] as const

export type EngineStageAckStage = typeof ENGINE_STAGE_ACK_STAGES[number]
export type EngineStageAckStatus = "ack" | "timeout" | "error"

export interface EngineStageAckPayload {
  stage: EngineStageAckStage
  status: EngineStageAckStatus
  connectionId: string
  message?: string
  details?: Record<string, unknown>
  timestamp: string
}

export function isEngineStageAckStage(stage: string): stage is EngineStageAckStage {
  return (ENGINE_STAGE_ACK_STAGES as readonly string[]).includes(stage)
}

export function emitEngineStageAck(
  connectionId: string | null | undefined,
  stage: EngineStageAckStage,
  status: EngineStageAckStatus = "ack",
  message?: string,
  details?: Record<string, unknown>,
): EngineStageAckPayload {
  const payload: EngineStageAckPayload = {
    stage,
    status,
    connectionId: connectionId || "global",
    message,
    details,
    timestamp: new Date().toISOString(),
  }

  try {
    const broadcaster = getBroadcaster()
    for (const target of new Set([payload.connectionId, "*"])) {
      broadcaster.broadcast({
        type: ENGINE_STAGE_ACK_EVENT as any,
        connectionId: target,
        data: payload,
        timestamp: payload.timestamp,
      })
    }
  } catch (error) {
    console.warn("[EngineStageAck] Failed to broadcast stage acknowledgement:", error)
  }

  return payload
}

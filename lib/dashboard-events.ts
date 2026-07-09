"use client"

import { useEffect } from "react"
import { getSSEClient, releaseSSE, retainSSE, type SSEEventType } from "@/lib/sse-client"

export const DASHBOARD_EVENT_TYPES = [
  "connection.updated",
  "settings.recoordinated",
  "engine.stage.changed",
  "progression.updated",
  "live.summary.updated",
  "logs.appended",
  "monitoring.updated",
] as const

export type DashboardEventType = (typeof DASHBOARD_EVENT_TYPES)[number]
export type DashboardEventPayload = {
  connectionId?: string
  [key: string]: unknown
}

export function useDashboardEvents(
  connectionId: string | undefined | null,
  handlers: Partial<Record<DashboardEventType, (payload: DashboardEventPayload) => void>>,
): void {
  useEffect(() => {
    const streamConnectionId = connectionId || "*"
    const client = getSSEClient(streamConnectionId)
    const unsubscribers = DASHBOARD_EVENT_TYPES.map((eventType) =>
      client.subscribe(eventType as SSEEventType, (payload: DashboardEventPayload) => {
        handlers[eventType]?.(payload)
      }),
    )

    retainSSE(streamConnectionId)

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe())
      releaseSSE(streamConnectionId)
    }
  }, [connectionId, handlers])
}

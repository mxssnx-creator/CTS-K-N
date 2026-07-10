"use client"

import { useEffect } from "react"
import { getSSEClient, releaseSSE, retainSSE, type SSEEventType } from "@/lib/sse-client"
import type { CanonicalEvent } from "@/lib/events/schema"

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

const CANONICAL_DASHBOARD_EVENT_MAP: Record<string, DashboardEventType[]> = {
  "settings.saved": ["settings.recoordinated", "connection.updated", "monitoring.updated"],
  "settings.hotReloaded": ["settings.recoordinated", "connection.updated", "monitoring.updated"],
  "connection.recoordinated": [
    "settings.recoordinated",
    "connection.updated",
    "progression.updated",
    "engine.stage.changed",
    "live.summary.updated",
    "monitoring.updated",
    "logs.appended",
  ],
  "progression.epochStarted": ["progression.updated", "engine.stage.changed", "monitoring.updated", "logs.appended"],
  "progression.stageChanged": ["progression.updated", "engine.stage.changed", "monitoring.updated", "logs.appended"],
  "strategy.stageChanged": ["progression.updated", "engine.stage.changed", "monitoring.updated", "logs.appended"],
  "processing.progress": ["progression.updated", "engine.stage.changed", "monitoring.updated"],
  "live.stageChanged": ["live.summary.updated", "progression.updated", "engine.stage.changed", "monitoring.updated"],
  "position.updated": ["live.summary.updated", "monitoring.updated"],
  "indication.updated": ["monitoring.updated"],
  "dashboard.sectionUpdated": ["connection.updated", "progression.updated", "live.summary.updated", "monitoring.updated"],
  "engine.status": ["engine.stage.changed", "progression.updated", "monitoring.updated", "logs.appended"],
  error: ["monitoring.updated", "logs.appended"],
}

function dashboardEventsForCanonical(event: CanonicalEvent): DashboardEventType[] {
  return CANONICAL_DASHBOARD_EVENT_MAP[event.type] || ["monitoring.updated"]
}

function dashboardPayloadFromCanonical(event: CanonicalEvent): DashboardEventPayload {
  return {
    ...(event.data && typeof event.data === "object" ? event.data : {}),
    connectionId: event.connectionId,
    canonicalEvent: event,
    canonicalType: event.type,
    epoch: event.epoch,
    session: event.session,
    settingsVersion: event.settingsVersion,
    stage: event.stage,
    symbol: event.symbol,
    timestamp: event.timestamp,
  }
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

    unsubscribers.push(
      client.subscribe("canonical-event", (event: CanonicalEvent) => {
        const payload = dashboardPayloadFromCanonical(event)
        for (const eventType of dashboardEventsForCanonical(event)) {
          handlers[eventType]?.(payload)
        }
      }),
    )

    retainSSE(streamConnectionId)

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe())
      releaseSSE(streamConnectionId)
    }
  }, [connectionId, handlers])
}

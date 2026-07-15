"use client"

import { useEffect } from "react"
import { getSSEClient, releaseSSE, retainSSE } from "@/lib/sse-client"
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
  "live.stageChanged": ["connection.updated", "live.summary.updated", "progression.updated", "engine.stage.changed", "monitoring.updated"],
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
    // Every broadcaster message is normalized to one canonical event. Listening
    // to both the canonical and its legacy compatibility event made each UI
    // refresh run twice (and doubled API traffic) for the same server message.
    const pendingHandlers = new Map<
      (payload: DashboardEventPayload) => void,
      { timer: ReturnType<typeof setTimeout>; payload: DashboardEventPayload; delay: number }
    >()
    const highFrequencyTypes = new Set([
      "strategy.stageChanged",
      "processing.progress",
      "position.updated",
      "indication.updated",
    ])
    const scheduleHandler = (
      handler: (payload: DashboardEventPayload) => void,
      payload: DashboardEventPayload,
      canonicalType: string,
    ) => {
      const delay = highFrequencyTypes.has(canonicalType) ? 750 : 25
      const pending = pendingHandlers.get(handler)
      if (pending) {
        pending.payload = payload
        // A settings/switch event must not sit behind a pending telemetry
        // refresh. Promote it to the short coordination delay.
        if (delay < pending.delay) {
          clearTimeout(pending.timer)
          pending.delay = delay
          pending.timer = setTimeout(() => {
            pendingHandlers.delete(handler)
            handler(pending.payload)
          }, delay)
        }
        return
      }
      const entry = {
        payload,
        delay,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      }
      entry.timer = setTimeout(() => {
        pendingHandlers.delete(handler)
        handler(entry.payload)
      }, delay)
      pendingHandlers.set(handler, entry)
    }

    const unsubscribers = [
      client.subscribe("canonical-event", (event: CanonicalEvent) => {
        const payload = dashboardPayloadFromCanonical(event)
        const invoked = new Set<(payload: DashboardEventPayload) => void>()
        for (const eventType of dashboardEventsForCanonical(event)) {
          const handler = handlers[eventType]
          if (!handler || invoked.has(handler)) continue
          invoked.add(handler)
          scheduleHandler(handler, payload, event.type)
        }
      }),
    ]

    retainSSE(streamConnectionId)

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe())
      pendingHandlers.forEach(({ timer }) => clearTimeout(timer))
      pendingHandlers.clear()
      releaseSSE(streamConnectionId)
    }
  }, [connectionId, handlers])
}

import { getBroadcaster } from "@/lib/event-broadcaster"
import { createCanonicalEvent, type CanonicalEvent } from "@/lib/events/schema"

export function emitCanonicalEvent(input: Parameters<typeof createCanonicalEvent>[0]): CanonicalEvent<any> {
  const event = createCanonicalEvent(input)
  getBroadcaster().broadcastCanonical(event)
  return event
}

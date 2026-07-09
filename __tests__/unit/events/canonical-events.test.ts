import { createCanonicalEvent, isCanonicalEventFresh, mergeFreshEventCursor } from "@/lib/events/schema"
import { getBroadcaster, resetBroadcaster } from "@/lib/event-broadcaster"

describe("canonical event ordering", () => {
  afterEach(() => resetBroadcaster())

  test("settings save → hot reload/recoordination → progression epoch/stage update → dashboard section update", () => {
    const connectionId = "conn-order"
    const settings = createCanonicalEvent({
      type: "settings.saved",
      connectionId,
      stage: "settings",
      settingsVersion: 7,
      timestamp: "2026-07-09T00:00:00.000Z",
      data: { changedFields: ["force_symbols"] },
    })
    const reload = createCanonicalEvent({
      type: "settings.hotReloaded",
      connectionId,
      stage: "settings",
      settingsVersion: 7,
      parentEventId: settings.id,
      timestamp: "2026-07-09T00:00:01.000Z",
      data: {},
    })
    const recoordination = createCanonicalEvent({
      type: "connection.recoordinated",
      connectionId,
      stage: "connection",
      epoch: 100,
      settingsVersion: 7,
      parentEventId: reload.id,
      timestamp: "2026-07-09T00:00:02.000Z",
      data: { changed: true },
    })
    const progression = createCanonicalEvent({
      type: "progression.epochStarted",
      connectionId,
      stage: "prehistoric",
      epoch: 100,
      settingsVersion: 7,
      parentEventId: recoordination.id,
      timestamp: "2026-07-09T00:00:03.000Z",
      data: { symbolCount: 3 },
    })
    const dashboard = createCanonicalEvent({
      type: "dashboard.sectionUpdated",
      connectionId,
      stage: "dashboard",
      epoch: 100,
      settingsVersion: 7,
      parentEventId: progression.id,
      timestamp: "2026-07-09T00:00:04.000Z",
      data: { section: "progression" },
    })

    expect([settings, reload, recoordination, progression, dashboard].map((e) => e.parentEventId)).toEqual([
      undefined,
      settings.id,
      reload.id,
      recoordination.id,
      progression.id,
    ])

    const broadcaster = getBroadcaster()
    ;[settings, reload, recoordination, progression, dashboard].forEach((event) => broadcaster.broadcastCanonical(event))
    expect(broadcaster.getHistory(connectionId).map((message) => message.canonicalEvent?.type)).toEqual([
      "settings.saved",
      "settings.hotReloaded",
      "connection.recoordinated",
      "progression.epochStarted",
      "dashboard.sectionUpdated",
    ])
  })

  test("older epochs cannot overwrite newer connection/progression UI state", () => {
    const newer = createCanonicalEvent({
      type: "progression.stageChanged",
      connectionId: "conn-stale",
      stage: "live",
      epoch: 200,
      session: 4,
      settingsVersion: 9,
      timestamp: "2026-07-09T00:00:10.000Z",
      data: { status: "new" },
    })
    const older = createCanonicalEvent({
      type: "progression.stageChanged",
      connectionId: "conn-stale",
      stage: "live",
      epoch: 199,
      session: 3,
      settingsVersion: 8,
      timestamp: "2026-07-09T00:00:09.000Z",
      data: { status: "old" },
    })

    const cursor = mergeFreshEventCursor({}, newer)
    expect(isCanonicalEventFresh(older, cursor)).toBe(false)
    expect(mergeFreshEventCursor(cursor, older)).toEqual(cursor)
  })
})

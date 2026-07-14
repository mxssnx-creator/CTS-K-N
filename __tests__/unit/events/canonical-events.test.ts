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

  test("a newer authoritative generation wins despite cross-worker clock skew", () => {
    const cursor = {
      epoch: 4,
      session: 7,
      settingsVersion: 11,
      timestamp: "2026-07-14T12:00:02.000Z",
    }
    const newerGeneration = createCanonicalEvent({
      type: "progression.stageChanged",
      connectionId: "conn-clock-skew",
      stage: "main",
      epoch: 5,
      session: 8,
      settingsVersion: 12,
      timestamp: "2026-07-14T11:59:59.000Z",
      data: { status: "running" },
    })

    expect(isCanonicalEventFresh(newerGeneration, cursor)).toBe(true)
    expect(mergeFreshEventCursor(cursor, newerGeneration)).toMatchObject({
      epoch: 5,
      session: 8,
      settingsVersion: 12,
    })
  })

  test("a new epoch may reset its session counter without being rejected", () => {
    const cursor = {
      epoch: 5,
      session: 99,
      settingsVersion: 12,
      timestamp: "2026-07-14T12:00:02.000Z",
    }
    const resetSession = createCanonicalEvent({
      type: "progression.epochStarted",
      connectionId: "conn-session-reset",
      stage: "prehistoric",
      epoch: 6,
      session: 1,
      settingsVersion: 12,
      timestamp: "2026-07-14T11:59:59.000Z",
      data: {},
    })

    expect(isCanonicalEventFresh(resetSession, cursor)).toBe(true)
    expect(mergeFreshEventCursor(cursor, resetSession)).toMatchObject({ epoch: 6, session: 1 })
  })

  test("timestamp settings versions do not make later numeric switch generations stale", () => {
    const cursor = {
      settingsVersion: "conn-mixed:1784023200000:settings",
      timestamp: "2026-07-14T12:00:00.000Z",
    }
    const laterSwitch = createCanonicalEvent({
      type: "connection.recoordinated",
      connectionId: "conn-mixed",
      stage: "connection",
      settingsVersion: "42",
      timestamp: "2026-07-14T12:00:01.000Z",
      data: { action: "enabled" },
    })
    const olderSwitch = createCanonicalEvent({
      type: "connection.recoordinated",
      connectionId: "conn-mixed",
      stage: "connection",
      settingsVersion: "41",
      timestamp: "2026-07-14T12:00:02.000Z",
      data: { action: "disabled" },
    })
    const olderSettingsSave = createCanonicalEvent({
      type: "connection.recoordinated",
      connectionId: "conn-mixed",
      stage: "connection",
      settingsVersion: "conn-mixed:1784023199000:settings",
      // Even a skewed worker clock cannot revive an older settings generation.
      timestamp: "2026-07-14T12:00:03.000Z",
      data: { action: "settings-reload" },
    })

    expect(isCanonicalEventFresh(laterSwitch, cursor)).toBe(true)
    const switchedCursor = mergeFreshEventCursor(cursor, laterSwitch)
    expect(isCanonicalEventFresh(olderSwitch, switchedCursor)).toBe(false)
    expect(isCanonicalEventFresh(olderSettingsSave, switchedCursor)).toBe(false)
  })

  test("generated canonical IDs remain unique for same-millisecond events", () => {
    const input = {
      type: "engine.status" as const,
      connectionId: "conn-id-collision",
      stage: "engine" as const,
      timestamp: "2026-07-14T12:00:00.000Z",
      data: {},
    }
    const ids = new Set(Array.from({ length: 100 }, () => createCanonicalEvent(input).id))
    expect(ids.size).toBe(100)
  })
})

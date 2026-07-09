import { publishEngineEvent, readEngineEvents } from "@/lib/engine-event-bus"

jest.mock("@/lib/redis-db", () => {
  const list: string[] = []
  return {
    initRedis: jest.fn(async () => undefined),
    getRedisClient: jest.fn(() => ({
      rpush: jest.fn(async (_key: string, value: string) => { list.push(value); return list.length }),
      ltrim: jest.fn(async (_key: string, start: number, stop: number) => {
        const normalizedStart = start < 0 ? Math.max(0, list.length + start) : start
        const normalizedStop = stop < 0 ? list.length + stop : stop
        const kept = list.slice(normalizedStart, normalizedStop + 1)
        list.splice(0, list.length, ...kept)
      }),
      lrange: jest.fn(async () => list.slice()),
    })),
    __list: list,
  }

})

describe("engine event bus", () => {
  beforeEach(() => {
    const redis = jest.requireMock("@/lib/redis-db")
    redis.__list.splice(0)
  })

  test("repeated settings saves append one serialized event per connection save without a timer tick", async () => {
    await publishEngineEvent("settings.changed", {
      connectionId: "conn-a",
      changedFields: ["connection_settings"],
      changeType: "reload",
      timestamp: "2026-07-09T00:00:00.000Z",
    })
    await publishEngineEvent("settings.changed", {
      connectionId: "conn-b",
      changedFields: ["strategies"],
      changeType: "reload",
      timestamp: "2026-07-09T00:00:01.000Z",
    })

    const events = await readEngineEvents()
    expect(events).toHaveLength(2)
    expect(events.map((event) => event.type)).toEqual(["settings.changed", "settings.changed"])
    expect(events.map((event) => (event.payload as any).connectionId)).toEqual(["conn-a", "conn-b"])
  })

  test("progression completion events are durable and can update coordinator state immediately", async () => {
    await publishEngineEvent("progression.stage.completed", {
      connectionId: "conn-a",
      stage: "cycle",
      successful: true,
      cycle: 12,
      timestamp: "2026-07-09T00:00:02.000Z",
    })

    const [event] = await readEngineEvents()
    expect(event.type).toBe("progression.stage.completed")
    expect(event.payload).toMatchObject({ connectionId: "conn-a", stage: "cycle", cycle: 12 })
  })
  test("refresh request events carry connection, action, version, and reason", async () => {
    await publishEngineEvent("engine.refresh.requested", {
      connectionId: "conn-a",
      action: "restart",
      stateSwitchVersion: "42",
      reason: "settings_reload",
      timestamp: "2026-07-09T00:00:03.000Z",
    })

    const [event] = await readEngineEvents()
    expect(event.type).toBe("engine.refresh.requested")
    expect(event.payload).toMatchObject({
      connectionId: "conn-a",
      action: "restart",
      stateSwitchVersion: "42",
      reason: "settings_reload",
    })
  })

})

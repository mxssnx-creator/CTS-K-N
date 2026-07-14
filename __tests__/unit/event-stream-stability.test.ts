import { readFileSync } from "node:fs"
import { join } from "node:path"
import { getBroadcaster, resetBroadcaster } from "@/lib/event-broadcaster"
import { createCanonicalEvent } from "@/lib/events/schema"
import { SSEClient } from "@/lib/sse-client"

describe("event stream stability", () => {
  afterEach(() => resetBroadcaster())

  test("wildcard clients accept per-connection canonical events", () => {
    const client = new SSEClient("*", "http://localhost/api/ws?connectionId=*")
    const event = createCanonicalEvent({
      type: "progression.stageChanged",
      connectionId: "conn-a",
      stage: "main",
      epoch: 4,
      data: { status: "running" },
    })

    expect(client.acceptCanonicalEvent(event)).toBe(true)
    expect(client.acceptCanonicalEvent(event)).toBe(false)
  })

  test("broadcast history stores each event once regardless of subscribers", () => {
    const broadcaster = getBroadcaster()
    const response = { writable: true, write: jest.fn(), end: jest.fn() }
    const subscription = broadcaster.registerClient("conn-a", response)
    const event = createCanonicalEvent({
      type: "engine.status",
      connectionId: "conn-a",
      stage: "engine",
      data: { status: "running" },
    })

    broadcaster.broadcastCanonical(event)

    expect(response.write).toHaveBeenCalledTimes(1)
    expect(broadcaster.getHistory("conn-a")).toHaveLength(1)
    expect(broadcaster.getHistory("*")).toHaveLength(1)
    expect(broadcaster.getStats().totalClients).toBe(1)

    subscription.unsubscribe()
    expect(broadcaster.getStats().totalClients).toBe(0)
  })

  test("reconnect history and retained payload size stay bounded", () => {
    const broadcaster = getBroadcaster()
    for (let index = 0; index < 30; index++) {
      broadcaster.broadcastCanonical(createCanonicalEvent({
        type: "processing.progress",
        connectionId: "conn-bounded",
        stage: "main",
        data: { index },
      }))
    }
    expect(broadcaster.getHistory("conn-bounded")).toHaveLength(20)

    broadcaster.broadcastCanonical(createCanonicalEvent({
      type: "processing.progress",
      connectionId: "conn-bounded",
      stage: "main",
      data: { oversized: "x".repeat(10_000) },
    }))
    const latest = broadcaster.getHistory("conn-bounded").at(-1)
    expect(latest?.canonicalEvent?.data).toMatchObject({ historyPayloadTruncated: true })
  })

  test("SSE route has a resolvable handshake and deterministic disconnect cleanup", () => {
    const source = readFileSync(join(process.cwd(), "app/api/ws/route.ts"), "utf8")
    expect(source).toContain("event: connected")
    expect(source).toContain("request.signal.addEventListener")
    expect(source).toContain("request.signal.removeEventListener")
    expect(source).toContain("cancel()")
    expect(source).toContain("unsubscribe()")
    expect(source.indexOf("cleanup = () => {")).toBeLessThan(
      source.indexOf("broadcaster.registerClient"),
    )
    expect(source.indexOf("broadcaster.registerClient")).toBeLessThan(
      source.indexOf("broadcaster.getHistory"),
    )
  })

  test("server-side switches emit canonical cross-tab updates without returning secrets", () => {
    const toggle = readFileSync(join(process.cwd(), "app/api/settings/connections/[id]/toggle/route.ts"), "utf8")
    const dashboard = readFileSync(join(process.cwd(), "app/api/settings/connections/[id]/toggle-dashboard/route.ts"), "utf8")
    const live = readFileSync(join(process.cwd(), "app/api/settings/connections/[id]/live-trade/route.ts"), "utf8")

    expect(toggle).toContain('type: "dashboard.sectionUpdated"')
    expect(toggle).not.toContain("connection: updatedConnection,")
    expect(dashboard).toContain('type: "connection.recoordinated"')
    expect(live).toContain('type: "live.stageChanged"')
    expect(live).toContain("Skipping stale control-order rebuild")
  })
})

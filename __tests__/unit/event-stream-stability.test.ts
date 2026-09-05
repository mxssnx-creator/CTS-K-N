import { readFileSync } from "node:fs"
import { join } from "node:path"
import { getBroadcaster, resetBroadcaster } from "@/lib/event-broadcaster"
import { createCanonicalEvent } from "@/lib/events/schema"
import { SSEClient } from "@/lib/sse-client"
import { NextRequest } from "next/server"
import { GET as openEventStream } from "@/app/api/ws/route"

describe("event stream stability", () => {
  afterEach(() => resetBroadcaster())

  test("streams its handshake through nginx and releases the subscription on abort", async () => {
    const abort = new AbortController()
    const response = await openEventStream(new NextRequest(
      "http://localhost/api/ws?connectionId=conn-stream-proof",
      { signal: abort.signal },
    ))
    expect(response.headers.get("Content-Type")).toBe("text/event-stream")
    expect(response.headers.get("X-Accel-Buffering")).toBe("no")
    expect(response.headers.get("Cache-Control")).toContain("no-transform")
    const reader = response.body!.getReader()
    try {
      const retry = new TextDecoder().decode((await reader.read()).value)
      const handshake = new TextDecoder().decode((await reader.read()).value)
      expect(retry).toContain("retry: 1000")
      expect(handshake).toContain("event: connected")
      expect(handshake).toContain("conn-stream-proof")
      expect(getBroadcaster().getStats().totalClients).toBe(1)
    } finally {
      abort.abort()
      await reader.cancel()
    }
    expect(getBroadcaster().getStats().totalClients).toBe(0)
  })

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
    expect(source).toContain("isServerlessDeploymentRuntime")
    expect(source).toContain("serverlessCloseTimer")
    expect(source).toContain("maxDuration = 10")
    expect(source).toContain('enqueue("retry: 1000')
    expect(source.indexOf("cleanup = () => {")).toBeLessThan(
      source.indexOf("broadcaster.registerClient"),
    )
    expect(source.indexOf("broadcaster.registerClient")).toBeLessThan(
      source.indexOf("broadcaster.getHistory"),
    )
  })

  test("native EventSource reconnect is not duplicated or reported as a failure", () => {
    const client = readFileSync(join(process.cwd(), "lib/sse-client.ts"), "utf8")
    expect(client).toContain("source?.readyState === EventSource.CONNECTING")
    expect(client.indexOf("source?.readyState === EventSource.CONNECTING")).toBeLessThan(
      client.indexOf("console.error('[SSE] Connection error')"),
    )

    for (const file of [
      "components/dashboard/quickstart-test-procedure-dialog.tsx",
      "components/dashboard/quickstart-full-system-test-dialog.tsx",
      "components/dashboard/engine-progression-test-dialog.tsx",
    ]) {
      const dialog = readFileSync(join(process.cwd(), file), "utf8")
      expect(dialog).toContain("source.readyState === EventSource.CONNECTING")
    }
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

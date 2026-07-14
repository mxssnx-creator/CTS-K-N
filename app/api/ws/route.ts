// Server-Sent Events (SSE) API endpoint for real-time updates
// Since Next.js doesn't natively support WebSocket, we use SSE for real-time streaming
import type { NextRequest } from "next/server"
import { getBroadcaster } from "@/lib/event-broadcaster"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    // Get connection ID from query parameters
    const connectionId = request.nextUrl.searchParams.get("connectionId")

    if (!connectionId) {
      return new Response("Missing connectionId parameter", { status: 400 })
    }

    // Set up SSE response headers
    const responseHeaders = new Headers({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    })

    // Create a response with streaming support. `cancel()` and the request
    // abort signal both tear down the heartbeat and broadcaster subscription;
    // without this, every reconnect retained a closed controller forever.
    let cleanup = () => {}
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        try {
            let closed = false
            let heartbeatInterval: ReturnType<typeof setInterval> | undefined
            let unsubscribe = () => {}
            const onAbort = () => cleanup()
            cleanup = () => {
              if (closed) return
              closed = true
              if (heartbeatInterval) clearInterval(heartbeatInterval)
              request.signal.removeEventListener("abort", onAbort)
              unsubscribe()
              try { controller.close() } catch { /* already cancelled */ }
            }
            const enqueue = (payload: string) => controller.enqueue(encoder.encode(payload))
            // Send initial connection confirmation
            const confirmationMessage = {
              type: "connected",
              connectionId,
              timestamp: new Date().toISOString(),
            }
            // This is a named event because SSEClient resolves its connect()
            // promise from the `connected` listener. Generic data-only output
            // left clients stuck in CONNECTING even though bytes were flowing.
            enqueue(`event: connected\ndata: ${JSON.stringify(confirmationMessage)}\n\n`)

            // Register before taking the reconnect-history snapshot. If an
            // event lands between the two operations it may be delivered both
            // live and through history, but the canonical event id makes that
            // harmless on the client. Registering after the snapshot left a
            // real gap where the event was delivered by neither path.
            const broadcaster = getBroadcaster()
            const subscription = broadcaster.registerClient(connectionId, {
              write: (data: string) => {
                enqueue(data)
              },
              writable: true,
            })
            unsubscribe = subscription.unsubscribe

            // Get message history for catch-up on reconnect.
            const history = broadcaster.getHistory(connectionId)
            // Send recent history if available (for client catch-up)
            if (history.length > 0) {
              const historyMessage = {
                type: "history",
                connectionId,
                data: history.slice(-10), // Last 10 messages
                timestamp: new Date().toISOString(),
              }
              enqueue(`data: ${JSON.stringify(historyMessage)}\n\n`)
            }

            // Keep connection alive with periodic heartbeat
            heartbeatInterval = setInterval(() => {
              try {
                enqueue(`: heartbeat at ${new Date().toISOString()}\n\n`)
              } catch (error) {
                console.error("[SSE] Heartbeat error:", error)
                cleanup()
              }
            }, 30000) // 30 second heartbeat

            request.signal.addEventListener("abort", onAbort, { once: true })
            if (request.signal.aborted) cleanup()
          } catch (error) {
            console.error("[SSE] Stream setup error:", error)
            try { controller.error(error) } catch { /* already closed */ }
            cleanup()
          }
        },
        cancel() {
          cleanup()
        },
      })

    const response = new Response(
      stream,
      {
        status: 200,
        headers: responseHeaders,
      }
    )

    return response
  } catch (error) {
    console.error("[SSE] Error:", error)
    return new Response("Internal Server Error", { status: 500 })
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  })
}

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

    // Create a response with streaming support
    const response = new Response(
      new ReadableStream({
        async start(controller) {
          try {
            // Send initial connection confirmation
            const confirmationMessage = {
              type: "connected",
              connectionId,
              timestamp: new Date().toISOString(),
            }
            controller.enqueue(`data: ${JSON.stringify(confirmationMessage)}\n\n`)

            // Get message history for catch-up on reconnect
            const broadcaster = getBroadcaster()
            const history = broadcaster.getHistory(connectionId)

            // Send recent history if available (for client catch-up)
            if (history.length > 0) {
              const historyMessage = {
                type: "history",
                connectionId,
                data: history.slice(-10), // Last 10 messages
                timestamp: new Date().toISOString(),
              }
              controller.enqueue(`data: ${JSON.stringify(historyMessage)}\n\n`)
            }

            // Register client and get send function
            const { send } = broadcaster.registerClient(connectionId, {
              write: (data: string) => {
                controller.enqueue(data)
              },
              writable: true,
            })

            // Keep connection alive with periodic heartbeat
            const heartbeatInterval = setInterval(() => {
              try {
                controller.enqueue(`: heartbeat at ${new Date().toISOString()}\n\n`)
              } catch (error) {
                console.error("[SSE] Heartbeat error:", error)
                clearInterval(heartbeatInterval)
              }
            }, 30000) // 30 second heartbeat

            // Handle connection close
            const originalClose = controller.close.bind(controller)
            controller.close = () => {
              clearInterval(heartbeatInterval)
              originalClose()
            }
          } catch (error) {
            console.error("[SSE] Stream setup error:", error)
            controller.error(error)
          }
        },
      }),
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

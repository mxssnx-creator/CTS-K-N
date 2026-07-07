import { NextResponse } from "next/server"
import { chatHistory } from "@/lib/additional/chat-history"

export const dynamic = "force-dynamic"
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const format = searchParams.get("format") || "combined"
    const daysBack = Number.parseInt(searchParams.get("days") || "30")

    let messages
    let filename

    switch (format) {
      case "input":
        messages = chatHistory.getUserMessages(daysBack)
        filename = "chat-input-messages.txt"
        break
      case "output":
        messages = chatHistory.getAssistantMessages(daysBack)
        filename = "chat-output-messages.txt"
        break
      case "combined":
      default:
        messages = chatHistory.getMessages(daysBack)
        filename = "chat-conversation.txt"
        break
    }

    const content = chatHistory.formatAsText(messages)

    return new NextResponse(content, {
      headers: {
        "Content-Type": "text/plain",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    })
  } catch (error) {
    console.error("[v0] Chat history export error:", error)
    return NextResponse.json({ error: "Failed to export chat history" }, { status: 500 })
  }
}

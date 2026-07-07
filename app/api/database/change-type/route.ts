import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export async function POST(request: Request) {
  try {
    const { type } = await request.json()

    // Only Redis is supported
    if (type !== "redis") {
      return NextResponse.json({ 
        error: "Only Redis is supported. SQLite and PostgreSQL have been removed from this system.",
        supportedTypes: ["redis"]
      }, { status: 400 })
    }

    return NextResponse.json({
      success: true,
      type: "redis",
      message: "System database is Redis. No configuration needed.",
    })
  } catch (error) {
    console.error("[v0] Database type change error:", error)
    const errorMessage = error instanceof Error ? error.message : "Failed to process request"
    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
}

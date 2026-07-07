import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    return NextResponse.json({ type: "redis", system: "Upstash Redis" })
  } catch (error) {
    console.error("[v0] Failed to get database type:", error)
    const errorMessage = error instanceof Error ? error.message : "Failed to get database type"
    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
}

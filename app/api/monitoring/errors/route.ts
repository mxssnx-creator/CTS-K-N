import { type NextRequest, NextResponse } from "next/server"
import DatabaseManager from "@/lib/database"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const limit = Number.parseInt(searchParams.get("limit") || "50")
    const resolved = searchParams.get("resolved") === "true"
    const category = searchParams.get("category") || undefined
    const severity = searchParams.get("severity") || undefined

    const db = DatabaseManager.getInstance()

    let errors = await db.getErrors(limit, resolved)

    if (category) {
      errors = errors.filter((e: any) => e.category === category)
    }

    if (severity) {
      errors = errors.filter((e: any) => e.severity === severity)
    }

    const stats = {
      total: errors.length,
      resolved: errors.filter((e: any) => e.resolved).length,
      unresolved: errors.filter((e: any) => !e.resolved).length,
      byCategory: errors.reduce((acc: any, e: any) => {
        acc[e.category || "unknown"] = (acc[e.category || "unknown"] || 0) + 1
        return acc
      }, {}),
    }

    return NextResponse.json({ errors, stats })
  } catch (error) {
    console.error("[v0] Error fetching errors:", error)
    return NextResponse.json(
      {
        error: "Failed to fetch errors",
        details: error instanceof Error ? error.message : "Unknown error",
        errors: [],
        stats: { total: 0, resolved: 0, unresolved: 0, byCategory: {} },
      },
      { status: 500 },
    )
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { id, resolved } = await request.json()

    if (!id) {
      return NextResponse.json({ error: "Error ID is required" }, { status: 400 })
    }

    const db = DatabaseManager.getInstance()

    if (resolved !== undefined) {
      await db.resolveError(id)
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[v0] Error resolving error:", error)
    return NextResponse.json(
      {
        error: "Failed to resolve error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const days = Number.parseInt(searchParams.get("days") || "30")

    const db = DatabaseManager.getInstance()
    
    await db.clearOldErrors(days)

    return NextResponse.json({ success: true, message: `Deleted errors older than ${days} days` })
  } catch (error) {
    console.error("[v0] Error deleting old errors:", error)
    return NextResponse.json(
      {
        error: "Failed to delete old errors",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
